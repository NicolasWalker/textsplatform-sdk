import {
  WAMessage,
  WAMessageContent,
  WASocket,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
} from 'baileys'
import type { Logger } from 'pino'
import type DBMessage from '../entities/DBMessage'
import type { FileCache } from './file-cache'

const VIEW_ONCE_WRAPPERS = new Set([
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
])

function hasViewOnceWrapper(content: WAMessageContent | null | undefined): boolean {
  if (!content) return false
  return (
    !!content.viewOnceMessage
    || !!content.viewOnceMessageV2
    || !!content.viewOnceMessageV2Extension
  )
}

/** Walk ephemeral / edited wrappers and report whether any layer is view-once. */
export function isViewOnceMessage(msg: WAMessage): boolean {
  if ((msg.key as { isViewOnce?: boolean })?.isViewOnce) return true

  let content: WAMessageContent | null | undefined = msg.message
  for (let i = 0; i < 5 && content; i += 1) {
    if (hasViewOnceWrapper(content)) return true

    const type = getContentType(content)
    if (!type) break

    if (type === 'ephemeralMessage' || type === 'documentWithCaptionMessage' || type === 'editedMessage') {
      const inner = (content as Record<string, { message?: WAMessageContent } | undefined>)[type]
      content = inner?.message
      continue
    }

    const media = (content as Record<string, { viewOnce?: boolean } | undefined>)[type]
    if (media && typeof media === 'object' && media.viewOnce) return true
    break
  }

  return false
}

export function isViewOnceImageOrVideo(msg: WAMessage): boolean {
  if (!msg.message || !isViewOnceMessage(msg)) return false
  const normalized = normalizeMessageContent(msg.message)
  return !!(normalized?.imageMessage || normalized?.videoMessage)
}

export function attachmentCachePathParams(threadID: string, attachment: { id: string, fileName?: string }) {
  return ['attachment', threadID, attachment.id, attachment.fileName || ''].map(p => encodeURIComponent(p))
}

export type ViewOnceMediaSaved = {
  threadID: string
  messageID: string
  fileName: string
  mimeType?: string
  buffer: Buffer
  message: WAMessage
}

export type PersistViewOnceMediaOptions = {
  fileCache: FileCache
  sock: WASocket
  logger: Logger
  /** Optional second copy into a user-facing media folder. */
  onMediaFolderCopy?: (saved: ViewOnceMediaSaved) => Promise<void>
}

/**
 * Download view-once image/video for mapped messages and write into the file cache
 * under the same key getAsset already reads. Optionally copy into a media folder.
 */
export async function persistViewOnceMediaForMessages(
  messages: DBMessage[],
  { fileCache, sock, logger, onMediaFolderCopy }: PersistViewOnceMediaOptions,
) {
  for (const dbMsg of messages) {
    const waMsg = dbMsg.original?.message
    if (!waMsg || !isViewOnceImageOrVideo(waMsg)) continue
    if (waMsg.messageStubType) continue

    const attachment = dbMsg.attachments?.[0]
    if (!attachment) continue

    const pathParams = attachmentCachePathParams(dbMsg.threadID, attachment)
    if (await fileCache.has(pathParams)) {
      logger.trace({ id: dbMsg.id, threadID: dbMsg.threadID }, 'view-once already cached')
      continue
    }

    try {
      const buffer = await downloadMediaMessage(
        waMsg,
        'buffer',
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage.bind(sock),
        },
      ) as Buffer

      await fileCache.put(pathParams, buffer)
      logger.info(
        { id: dbMsg.id, threadID: dbMsg.threadID, bytes: buffer.length },
        'cached view-once media on conversation message',
      )

      if (onMediaFolderCopy) {
        await onMediaFolderCopy({
          threadID: dbMsg.threadID,
          messageID: dbMsg.id,
          fileName: attachment.fileName || `${dbMsg.id}.bin`,
          mimeType: attachment.mimeType,
          buffer,
          message: waMsg,
        })
      }
    } catch (err) {
      logger.warn(
        { err, id: dbMsg.id, threadID: dbMsg.threadID },
        'failed to download view-once media; message row kept on thread',
      )
    }
  }
}
