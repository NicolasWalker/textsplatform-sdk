// Kept in step with whatsapp/src/utils/pairing-qr.ts
import { randomBytes } from 'crypto'

/** Children WA Web accepts on a companion_reg_refresh notification. */
const COMPANION_REG_REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr'] as const

export type CompanionRefreshDecision =
  | { action: 'rotate' }
  | { action: 'ignore', reason: 'malformed' | 'registered' }

type NotificationNode = {
  content?: unknown
}

/**
 * WhatsApp sends companion_reg_refresh to an unpaired device to retire the
 * advertisement secret currently inside the QR. The next scan only succeeds
 * if that secret is replaced and the same ref is shown again.
 * A session that already has `me` must keep its secret: pair-success and
 * pairing-code registration both verify against it.
 */
export const decideCompanionRegRefresh = (
  node: NotificationNode,
  registered: boolean,
): CompanionRefreshDecision => {
  const tags = childTags(node)
  const accepted = COMPANION_REG_REFRESH_CHILDREN.some(tag => tags.includes(tag))
  if (!accepted) return { action: 'ignore', reason: 'malformed' }
  if (registered) return { action: 'ignore', reason: 'registered' }
  return { action: 'rotate' }
}

/** 32 CSPRNG bytes, base64. Same construction as initAuthCreds. */
export const createAdvSecretKey = () => randomBytes(32).toString('base64')

/**
 * Pairing QR payload is `ref,noise,identity,adv[,platform]`, optionally after
 * `https://wa.me/settings/linked_devices#`. Replacing the adv field keeps the
 * ref the server already issued.
 */
export const replacePairingQrAdvSecret = (qr: string, advSecretKey: string): string | undefined => {
  const hash = qr.indexOf('#')
  const payload = hash === -1 ? qr : qr.slice(hash + 1)
  const parts = payload.split(',')
  if (parts.length < 4 || parts.slice(0, 4).some(part => part.length === 0)) return undefined
  parts[3] = advSecretKey
  const next = parts.join(',')
  return hash === -1 ? next : `${qr.slice(0, hash + 1)}${next}`
}

const childTags = (node: NotificationNode): string[] => {
  if (!Array.isArray(node.content)) return []
  return node.content.flatMap(child => {
    if (!child || typeof child !== 'object' || !('tag' in child)) return []
    const { tag } = child as { tag?: unknown }
    return typeof tag === 'string' ? [tag] : []
  })
}
