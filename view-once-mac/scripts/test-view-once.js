const { WAProto } = require('@whiskeysockets/baileys')
const { getViewOnceMedia, isViewOnceMessage, messageDedupKey } = require('../dist/view-once')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const viewOnceImage = WAProto.WebMessageInfo.fromObject({
  key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'ABC123' },
  messageTimestamp: 1700000000,
  message: {
    ephemeralMessage: {
      message: {
        viewOnceMessageV2: {
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              url: 'https://mmg.whatsapp.net/d/f/test.enc',
              mediaKey: Buffer.alloc(32),
              fileLength: 1024,
              viewOnce: true,
            },
          },
        },
      },
    },
  },
})

assert(isViewOnceMessage(viewOnceImage), 'should detect view-once wrapper')
const media = getViewOnceMedia(viewOnceImage)
assert(!!media, 'should extract media')
assert(media.kind === 'image', 'kind should be image')
assert(media.extension === 'jpg', 'extension should be jpg')
assert(messageDedupKey(viewOnceImage) === '123@s.whatsapp.net|ABC123|0', 'dedup key')

const normalImage = WAProto.WebMessageInfo.fromObject({
  key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'XYZ' },
  message: {
    imageMessage: {
      mimetype: 'image/jpeg',
      url: 'https://mmg.whatsapp.net/d/f/test.enc',
      mediaKey: Buffer.alloc(32),
    },
  },
})

assert(!isViewOnceMessage(normalImage), 'normal image is not view-once')
assert(getViewOnceMedia(normalImage) === null, 'normal image ignored')

const viewOnceVideo = WAProto.WebMessageInfo.fromObject({
  key: { remoteJid: 'g.us', fromMe: true, id: 'VID1' },
  message: {
    viewOnceMessage: {
      message: {
        videoMessage: {
          mimetype: 'video/mp4',
          url: 'https://mmg.whatsapp.net/d/f/v.enc',
          mediaKey: Buffer.alloc(32),
          viewOnce: true,
        },
      },
    },
  },
})

assert(getViewOnceMedia(viewOnceVideo)?.kind === 'video', 'video view-once')

console.log('view-once detection tests passed')
