import makeWASocket, {
  DisconnectReason,
  WAMessage,
  WASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino, { Logger } from 'pino'
import QRCode from 'qrcode'
import path from 'path'
import fs from 'fs/promises'
import {
  describeViewOnceWrapper,
  downloadViewOnceMedia,
  getViewOnceMedia,
  isViewOnceMessage,
  messageDedupKey,
} from './view-once'
import { createAdvSecretKey, decideCompanionRegRefresh, replacePairingQrAdvSecret } from './pairing-qr'
import { ConversationStore } from './conversation-store'

export type ConnectionStatus =
  | 'starting'
  | 'qr'
  | 'connecting'
  | 'open'
  | 'closed'
  | 'logged-out'

export interface SavedFileInfo {
  path: string
  fileName: string
  kind: 'image' | 'video'
  chatId: string
  messageId: string
  savedAt: string
  cachePath?: string
}

export interface WhatsAppControllerOptions {
  authDir: string
  saveDir: string
  onStatus: (status: ConnectionStatus, detail?: string) => void
  onQr: (dataUrl: string | null) => void
  onSaved: (info: SavedFileInfo) => void
  onError: (message: string) => void
  onLog: (message: string) => void
}

export class WhatsAppController {
  private sock: WASocket | null = null
  private logger: Logger
  private saveDir: string
  private authDir: string
  private processed = new Set<string>()
  private processedPath: string
  private conversations: ConversationStore
  private saving = Promise.resolve()
  private shouldReconnect = true
  private latestQr: string | undefined
  private opts: WhatsAppControllerOptions

  constructor(opts: WhatsAppControllerOptions) {
    this.opts = opts
    this.saveDir = opts.saveDir
    this.authDir = opts.authDir
    this.processedPath = path.join(opts.authDir, 'processed-ids.json')
    this.conversations = new ConversationStore(opts.authDir)
    this.logger = pino({ level: 'info' })
  }

  getSaveDir() {
    return this.saveDir
  }

  async setSaveDir(dir: string) {
    this.saveDir = dir
    await fs.mkdir(dir, { recursive: true })
  }

  async start() {
    this.shouldReconnect = true
    await fs.mkdir(this.authDir, { recursive: true })
    await fs.mkdir(this.saveDir, { recursive: true })
    await this.conversations.init()
    await this.loadProcessed()
    await this.connect()
  }

  async stop() {
    this.shouldReconnect = false
    try {
      await this.sock?.end(undefined)
    } catch {
      // ignore
    }
    this.sock = null
  }

  private async loadProcessed() {
    try {
      const raw = await fs.readFile(this.processedPath, 'utf8')
      const ids = JSON.parse(raw) as string[]
      this.processed = new Set(ids)
      this.opts.onLog(`Loaded ${this.processed.size} previously saved message ids`)
    } catch {
      this.processed = new Set()
    }
  }

  private async persistProcessed() {
    const ids = [...this.processed]
    // Cap growth so the file stays small
    const trimmed = ids.length > 50_000 ? ids.slice(ids.length - 50_000) : ids
    await fs.writeFile(this.processedPath, JSON.stringify(trimmed), 'utf8')
  }

  private async connect() {
    this.opts.onStatus('starting', 'Connecting to WhatsApp…')

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    const { version } = await fetchLatestBaileysVersion()

    // Cold start has no user. `registered` is the saved login flag; the
    // handshake itself sends a registration payload only when `me` is absent.
    const loggedIn = !!state.creds.me?.id
    if (!loggedIn) {
      state.creds.registered = false
      state.creds.me = undefined
    }
    this.opts.onLog(
      loggedIn
        ? `Resuming saved login ${state.creds.me?.id}`
        : 'No saved login (registered=false). Requesting a QR.',
    )

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      logger: this.logger,
      // Mac OS + syncFullHistory makes Baileys 6.7 advertise webSubPlatform
      // DARWIN. WhatsApp closes that socket before pair-device, so no QR
      // is ever sent. A browser identity stays WEB_BROWSER and still asks
      // for full history via requireFullSync.
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      printQRInTerminal: false,
    })

    this.sock = sock
    this.bindCompanionRegRefresh(sock)

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        const advSecretKey = sock.authState.creds.advSecretKey
        const next = advSecretKey ? replacePairingQrAdvSecret(qr, advSecretKey) ?? qr : qr
        await this.renderQr(next)
      }

      if (connection === 'connecting') {
        this.opts.onStatus('connecting', 'Connecting…')
      }

      if (connection === 'open') {
        this.latestQr = undefined
        this.opts.onQr(null)
        this.opts.onStatus('open', 'Connected — saving conversations and view-once media')
      }

      if (connection === 'close') {
        this.latestQr = undefined
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut

        if (loggedOut) {
          this.opts.onStatus('logged-out', 'Logged out — delete the auth folder or restart to scan again')
          this.shouldReconnect = false
          return
        }

        this.opts.onStatus('closed', `Disconnected (${statusCode ?? 'unknown'})`)
        if (this.shouldReconnect) {
          this.opts.onLog('Reconnecting…')
          setTimeout(() => {
            void this.connect()
          }, 2000)
        }
      }
    })

    sock.ev.on('messaging-history.set', ({ messages, isLatest }) => {
      this.opts.onLog(
        `History sync: ${messages.length} message(s)${isLatest ? ' (latest batch)' : ''}`,
      )
      void this.handleMessages(messages, 'history')
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.opts.onLog(`Live upsert (${type}): ${messages.length} message(s)`)
      void this.handleMessages(messages, 'live')
    })
  }

  /**
   * After a scan, WhatsApp retires the adv secret inside the QR and will not
   * finish pairing until that secret is rotated and the same ref is shown again.
   */
  private bindCompanionRegRefresh(sock: WASocket) {
    const ws = sock.ws as {
      on(event: string, listener: (node: { attrs: Record<string, string | undefined>, content?: unknown }) => void): void
    }
    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
      void this.onCompanionRegRefresh(sock, node)
    })
  }

  private async onCompanionRegRefresh(
    sock: WASocket,
    node: { attrs: Record<string, string | undefined>, content?: unknown },
  ) {
    const creds = sock.authState.creds
    const decision = decideCompanionRegRefresh(node, !!creds.me?.id)
    if (decision.action !== 'rotate') {
      this.opts.onLog(`companion_reg_refresh ignored (${decision.reason})`)
      return
    }

    if (!creds.me?.id && node.attrs.id && node.attrs.from) {
      try {
        await sock.sendNode({
          tag: 'ack',
          attrs: {
            id: node.attrs.id,
            to: node.attrs.from,
            class: 'notification',
            type: node.attrs.type || 'companion_reg_refresh',
          },
        })
      } catch (err) {
        this.opts.onError(`Failed to ack companion_reg_refresh: ${String(err)}`)
      }
    }

    const advSecretKey = createAdvSecretKey()
    creds.advSecretKey = advSecretKey
    sock.ev.emit('creds.update', { advSecretKey })

    const refreshed = this.latestQr ? replacePairingQrAdvSecret(this.latestQr, advSecretKey) : undefined
    if (refreshed) await this.renderQr(refreshed)
    this.opts.onLog('Rotated the pairing secret and refreshed the QR. Scan the new code.')
  }

  private async renderQr(qr: string) {
    this.latestQr = qr
    try {
      const dataUrl = await QRCode.toDataURL(qr, {
        margin: 2,
        width: 280,
        color: { dark: '#111111', light: '#ffffff' },
      })
      this.opts.onQr(dataUrl)
      this.opts.onStatus('qr', 'Scan the QR code with WhatsApp on your phone')
    } catch (err) {
      this.opts.onError(`Failed to render QR: ${String(err)}`)
    }
  }

  private handleMessages(messages: WAMessage[], source: 'history' | 'live') {
    this.saving = this.saving.then(async () => {
      for (const msg of messages) {
        await this.processMessage(msg, source)
      }
    }).catch((err) => {
      this.opts.onError(`Save queue error: ${String(err)}`)
    })
    return this.saving
  }

  private async processMessage(msg: WAMessage, source: 'history' | 'live') {
    const isViewOnce = isViewOnceMessage(msg)
    // Keep every message on its conversation thread (Texts-style record).
    await this.conversations.upsertMessage(msg, isViewOnce)

    const media = getViewOnceMedia(msg)
    if (!media) return

    const key = messageDedupKey(msg)
    const alreadyCached = await this.conversations.hasAttachment(msg)
    const alreadyInMediaFolder = this.processed.has(key)

    if (alreadyCached && alreadyInMediaFolder) {
      this.opts.onLog(`Skip duplicate (${source}): ${key}`)
      return
    }

    if (!this.sock && !alreadyCached) {
      this.opts.onError('Socket not ready')
      return
    }

    const wrapper = describeViewOnceWrapper(msg)
    this.opts.onLog(
      `Saving view-once ${media.kind} (${wrapper}) from ${source}: ${key}`,
    )

    try {
      let buffer: Buffer
      if (alreadyCached) {
        const threadID = msg.key.remoteJid || 'unknown'
        const mid = `${msg.key.id || 'unknown'}|${msg.key.fromMe ? '1' : '0'}`
        const cachePath = this.conversations.attachmentCachePath(threadID, mid, media.extension)
        buffer = await fs.readFile(cachePath)
      } else {
        buffer = await downloadViewOnceMedia(media, this.sock!, this.logger)
      }

      const savedAt = new Date().toISOString()
      const mediaInfo = alreadyInMediaFolder
        ? null
        : await this.writeMediaFolderCopy(msg, media.kind, media.extension, buffer)

      const stored = alreadyCached && !mediaInfo
        ? null
        : await this.conversations.attachMedia(msg, {
          kind: media.kind,
          mimeType: media.mimeType,
          extension: media.extension,
          fileName: mediaInfo?.fileName || `${sanitize(msg.key.id || 'msg')}.${media.extension}`,
          savedAt,
          mediaPath: mediaInfo?.path,
          buffer,
        })

      if (mediaInfo) {
        this.processed.add(key)
        await this.persistProcessed()
        this.opts.onSaved({
          ...mediaInfo,
          cachePath: stored?.attachment?.cachePath,
        })
        this.opts.onLog(`Saved on conversation and media folder: ${mediaInfo.fileName}`)
      } else if (!alreadyCached) {
        this.opts.onLog(`Cached on conversation message: ${key}`)
      } else {
        this.opts.onLog(`Media folder copy written from conversation cache: ${key}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.onError(
        `Could not download view-once media (${source}) ${key}: ${message}`,
      )
    }
  }

  private async writeMediaFolderCopy(
    msg: WAMessage,
    kind: 'image' | 'video',
    extension: string,
    buffer: Buffer,
  ): Promise<SavedFileInfo> {
    await fs.mkdir(this.saveDir, { recursive: true })

    const ts = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000)
      : new Date()
    const stamp = ts.toISOString().replace(/[:.]/g, '-').replace('Z', '')
    const chat = sanitize((msg.key.remoteJid || 'chat').split('@')[0])
    const mid = sanitize(msg.key.id || 'msg')
    const fileName = `${stamp}_${chat}_${mid}.${extension}`
    const filePath = path.join(this.saveDir, fileName)

    await fs.writeFile(filePath, buffer)

    return {
      path: filePath,
      fileName,
      kind,
      chatId: msg.key.remoteJid || '',
      messageId: msg.key.id || '',
      savedAt: new Date().toISOString(),
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
}
