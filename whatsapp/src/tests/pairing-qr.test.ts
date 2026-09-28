import { createAdvSecretKey, decideCompanionRegRefresh, replacePairingQrAdvSecret } from '../utils/pairing-qr'

const refresh = (child: string) => ({
  tag: 'notification',
  attrs: { type: 'companion_reg_refresh', id: '1' },
  content: [{ tag: child, attrs: {} }],
})

test('companion_reg_refresh rotates only an unpaired session with a known child', () => {
  expect(decideCompanionRegRefresh(refresh('companion_reg_refresh'), false)).toEqual({ action: 'rotate' })
  expect(decideCompanionRegRefresh(refresh('pair-device-rotate-qr'), false)).toEqual({ action: 'rotate' })
  expect(decideCompanionRegRefresh(refresh('companion_reg_refresh'), true)).toEqual({
    action: 'ignore',
    reason: 'registered',
  })
  expect(decideCompanionRegRefresh({ content: [{ tag: 'something-else' }] }, false)).toEqual({
    action: 'ignore',
    reason: 'malformed',
  })
  expect(decideCompanionRegRefresh({ content: undefined }, false)).toEqual({
    action: 'ignore',
    reason: 'malformed',
  })
})

test('adv secret replacement keeps the ref and only swaps the secret', () => {
  const qr = 'https://wa.me/settings/linked_devices#ref-1,noise,identity,old-secret,7'
  expect(replacePairingQrAdvSecret(qr, 'new-secret')).toBe(
    'https://wa.me/settings/linked_devices#ref-1,noise,identity,new-secret,7',
  )
  expect(replacePairingQrAdvSecret('ref-1,noise,identity,old-secret', 'new-secret')).toBe(
    'ref-1,noise,identity,new-secret',
  )
  expect(replacePairingQrAdvSecret('not-a-qr', 'new-secret')).toBeUndefined()
})

test('fresh adv secret is 32 bytes', () => {
  const key = createAdvSecretKey()
  expect(Buffer.from(key, 'base64')).toHaveLength(32)
  expect(createAdvSecretKey()).not.toBe(key)
})
