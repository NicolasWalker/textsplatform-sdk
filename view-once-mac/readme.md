# View Once Saver (macOS)

Small Electron app that links your WhatsApp account and saves **view-once** images and videos from:

1. The initial recent-history sync (`messaging-history.set`)
2. New messages as they arrive (`messages.upsert`)

Media is decrypted with Baileys the same way the Texts WhatsApp platform does: unwrap `viewOnceMessage` / `viewOnceMessageV2` (often inside `ephemeralMessage`), then `downloadMediaMessage`.

## Requirements

- macOS
- Node.js 18+
- WhatsApp on your phone (to scan the QR code)

## Develop

```bash
cd view-once-mac
npm install
npm start
```

## Build a `.app`

```bash
npm run dist
```

Output lands in `release/` (unsigned DMG + app directory for arm64 and x64).

## Where files go

Default: `~/Pictures/WhatsApp View Once/`

Session data (QR auth) is stored under the app’s Application Support folder so you stay linked across launches.

## Notes

- WhatsApp may delete view-once ciphertext after it is opened on the phone or after a while. History downloads only work while the CDN still has the file; failures are logged and skipped.
- Each message id is saved once so history + live events do not duplicate files.
