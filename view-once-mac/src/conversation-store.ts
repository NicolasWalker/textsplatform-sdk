import path from 'path'
import fs from 'fs/promises'
import type { WAMessage } from '@whiskeysockets/baileys'

export type StoredAttachment = {
  kind: 'image' | 'video'
  mimeType: string
  extension: string
  /** Absolute path inside the conversation attachment cache */
  cachePath: string
  /** Absolute path of the media-folder copy, when written */
  mediaPath?: string
  fileName: string
  savedAt: string
}

export type StoredMessage = {
  id: string
  threadID: string
  fromMe: boolean
  timestamp: number
  text?: string | null
  pushName?: string | null
  isViewOnce: boolean
  attachment?: StoredAttachment
  updatedAt: string
}

function messageId(msg: WAMessage): string {
  const id = msg.key.id || 'unknown'
  const fromMe = msg.key.fromMe ? '1' : '0'
  return `${id}|${fromMe}`
}

function threadId(msg: WAMessage): string {
  return msg.key.remoteJid || 'unknown'
}

function captionFromMessage(msg: WAMessage): string | null {
  const m = msg.message
  if (!m) return null
  const inner =
    m.ephemeralMessage?.message
    || m.viewOnceMessage?.message
    || m.viewOnceMessageV2?.message
    || m.viewOnceMessageV2Extension?.message
    || m
  const image = inner.imageMessage
  const video = inner.videoMessage
  const extended = inner.extendedTextMessage
  return (
    image?.caption
    || video?.caption
    || extended?.text
    || inner.conversation
    || null
  )
}

/**
 * Lightweight per-thread conversation store so view-once media sits on the
 * same message record as the rest of the chat history.
 */
export class ConversationStore {
  private rootDir: string
  private attachmentsDir: string

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, 'conversations')
    this.attachmentsDir = path.join(dataDir, 'attachment-cache')
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true })
    await fs.mkdir(this.attachmentsDir, { recursive: true })
  }

  private threadPath(threadID: string) {
    const safe = threadID.replace(/[^a-zA-Z0-9._@-]+/g, '_')
    return path.join(this.rootDir, `${safe}.json`)
  }

  private async readThread(threadID: string): Promise<Record<string, StoredMessage>> {
    try {
      const raw = await fs.readFile(this.threadPath(threadID), 'utf8')
      return JSON.parse(raw) as Record<string, StoredMessage>
    } catch {
      return {}
    }
  }

  private async writeThread(threadID: string, messages: Record<string, StoredMessage>) {
    await fs.mkdir(this.rootDir, { recursive: true })
    await fs.writeFile(this.threadPath(threadID), JSON.stringify(messages, null, 2), 'utf8')
  }

  /** Upsert a WA message onto its conversation thread. Keeps an existing attachment. */
  async upsertMessage(msg: WAMessage, isViewOnce: boolean): Promise<StoredMessage> {
    const threadID = threadId(msg)
    const id = messageId(msg)
    const messages = await this.readThread(threadID)
    const existing = messages[id]
    const stored: StoredMessage = {
      id,
      threadID,
      fromMe: !!msg.key.fromMe,
      timestamp: Number(msg.messageTimestamp || 0),
      text: captionFromMessage(msg),
      pushName: msg.pushName || null,
      isViewOnce,
      attachment: existing?.attachment,
      updatedAt: new Date().toISOString(),
    }
    messages[id] = stored
    await this.writeThread(threadID, messages)
    return stored
  }

  attachmentCachePath(threadID: string, messageID: string, extension: string) {
    const safeThread = threadID.replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 80)
    const safeMsg = messageID.replace(/[^a-zA-Z0-9._|-]+/g, '_').slice(0, 80)
    return path.join(this.attachmentsDir, safeThread, `${safeMsg}.${extension}`)
  }

  async attachMedia(
    msg: WAMessage,
    attachment: Omit<StoredAttachment, 'cachePath'> & { buffer: Buffer },
  ): Promise<StoredMessage> {
    const threadID = threadId(msg)
    const id = messageId(msg)
    const cachePath = this.attachmentCachePath(threadID, id, attachment.extension)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, attachment.buffer)

    const messages = await this.readThread(threadID)
    const existing = messages[id] || await this.upsertMessage(msg, true)
    const stored: StoredMessage = {
      ...existing,
      isViewOnce: true,
      attachment: {
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        extension: attachment.extension,
        cachePath,
        mediaPath: attachment.mediaPath,
        fileName: attachment.fileName,
        savedAt: attachment.savedAt,
      },
      updatedAt: new Date().toISOString(),
    }
    messages[id] = stored
    await this.writeThread(threadID, messages)
    return stored
  }

  async hasAttachment(msg: WAMessage): Promise<boolean> {
    const threadID = threadId(msg)
    const id = messageId(msg)
    const messages = await this.readThread(threadID)
    const att = messages[id]?.attachment
    if (!att?.cachePath) return false
    try {
      await fs.access(att.cachePath)
      return true
    } catch {
      return false
    }
  }
}
