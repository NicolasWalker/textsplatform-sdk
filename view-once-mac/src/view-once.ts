import {
  WAMessage,
  WAMessageContent,
  downloadMediaMessage,
  normalizeMessageContent,
  getContentType,
  WASocket,
} from '@whiskeysockets/baileys'
import type { Logger } from 'pino'

export type ViewOnceMediaKind = 'image' | 'video'

export interface ViewOnceMedia {
  kind: ViewOnceMediaKind
  mimeType: string
  extension: string
  message: WAMessage
}

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

    // Some clients set viewOnce: true on the media itself
    const media = (content as Record<string, { viewOnce?: boolean } | undefined>)[type]
    if (media && typeof media === 'object' && media.viewOnce) return true
    break
  }

  return false
}

export function getViewOnceMedia(msg: WAMessage): ViewOnceMedia | null {
  if (!msg.message) return null
  if (!isViewOnceMessage(msg)) return null

  const normalized = normalizeMessageContent(msg.message)
  if (!normalized) return null

  if (normalized.imageMessage) {
    const mimeType = normalized.imageMessage.mimetype || 'image/jpeg'
    return {
      kind: 'image',
      mimeType,
      extension: mimeToExt(mimeType, 'jpg'),
      message: msg,
    }
  }

  if (normalized.videoMessage) {
    const mimeType = normalized.videoMessage.mimetype || 'video/mp4'
    return {
      kind: 'video',
      mimeType,
      extension: mimeToExt(mimeType, 'mp4'),
      message: msg,
    }
  }

  return null
}

function mimeToExt(mimeType: string, fallback: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
  }
  return map[mimeType] || mimeType.split('/')[1]?.split(';')[0] || fallback
}

export async function downloadViewOnceMedia(
  media: ViewOnceMedia,
  sock: WASocket,
  logger: Logger,
): Promise<Buffer> {
  const buffer = await downloadMediaMessage(
    media.message,
    'buffer',
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage.bind(sock),
    },
  )
  return buffer as Buffer
}

export function messageDedupKey(msg: WAMessage): string {
  const id = msg.key.id || 'unknown'
  const fromMe = msg.key.fromMe ? '1' : '0'
  const jid = msg.key.remoteJid || 'unknown'
  return `${jid}|${id}|${fromMe}`
}

/** True if this content type lives under a view-once wrapper name (for logging). */
export function describeViewOnceWrapper(msg: WAMessage): string {
  let content: WAMessageContent | null | undefined = msg.message
  const found: string[] = []
  for (let i = 0; i < 5 && content; i += 1) {
    for (const name of VIEW_ONCE_WRAPPERS) {
      if ((content as Record<string, unknown>)[name]) found.push(name)
    }
    const type = getContentType(content)
    if (!type) break
    if (type === 'ephemeralMessage' || type === 'documentWithCaptionMessage' || type === 'editedMessage') {
      const inner = (content as Record<string, { message?: WAMessageContent } | undefined>)[type]
      content = inner?.message
      continue
    }
    break
  }
  return found.join('+') || 'viewOnce'
}
