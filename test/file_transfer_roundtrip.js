// End-to-end-ish desktop file-transfer round trip:
// offer manifest -> authenticated encrypted chunk serving -> pull -> sha256 verify.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createFileTransfer } = require('../desktop/src/main/file-transfer')

function encryptBytes(plain, keyBase64) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()])
}

function decryptBytes(data, keyBase64) {
  const buffer = Buffer.from(data)
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(buffer.length - 16)
  const ciphertext = buffer.subarray(12, buffer.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function hmacBase64(keyBase64, message) {
  return crypto.createHmac('sha256', Buffer.from(keyBase64, 'base64')).update(message).digest('base64')
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

async function main() {
  const key = crypto.randomBytes(32).toString('base64')
  const senderId = 'desktop-a'
  const receiverId = 'phone-b'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-ft-'))
  const sourcePath = path.join(tmp, 'source.bin')
  const downloads = path.join(tmp, 'downloads')
  const incomingTmp = path.join(tmp, 'tmp')
  fs.writeFileSync(sourcePath, crypto.randomBytes(1024 * 1024 + 321))

  let manifest = null
  const sender = createFileTransfer({
    getIdentity: () => ({ id: senderId, name: 'Desktop A', type: 'WINDOWS_DESKTOP' }),
    encryptBytes,
    decryptBytes,
    hmacBase64,
    generateNonce: () => crypto.randomBytes(16).toString('base64'),
    sendManifest: async (targets, payload) => {
      manifest = payload.fileManifest
      return targets.length
    },
    lookupPeerKey: id => id === receiverId ? key : null,
    resolveSource: () => null,
    httpGet: async () => null,
    downloadDir: downloads,
    tmpDir: incomingTmp,
    maxChunkBytes: 256 * 1024
  })

  const offer = await sender.offerFile(sourcePath, [receiverId])
  if (!offer || !manifest) throw new Error('offer failed')

  const receiver = createFileTransfer({
    getIdentity: () => ({ id: receiverId, name: 'Phone B', type: 'ANDROID_PHONE' }),
    encryptBytes,
    decryptBytes,
    hmacBase64,
    generateNonce: () => crypto.randomBytes(16).toString('base64'),
    sendManifest: async () => 0,
    lookupPeerKey: () => null,
    resolveSource: id => id === senderId
      ? { id: senderId, name: 'Desktop A', host: '127.0.0.1', port: 19529, pairingKey: key }
      : null,
    httpGet: async ({ path: reqPath }) => {
      const url = new URL(reqPath, 'http://127.0.0.1')
      const result = await sender.serveFileChunk({
        fileId: decodeURIComponent(url.pathname.slice('/file/'.length)),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        senderId: url.searchParams.get('senderId'),
        nonce: url.searchParams.get('nonce'),
        authToken: url.searchParams.get('authToken')
      })
      return { status: result.status, body: result.body }
    },
    downloadDir: downloads,
    tmpDir: incomingTmp,
    maxChunkBytes: 256 * 1024
  })

  const pulled = await receiver.startIncomingPull(manifest, { maxBytes: 10 * 1024 * 1024 })
  if (!pulled) throw new Error('pull failed')

  const downloaded = fs.readdirSync(downloads).find(name => name === path.basename(sourcePath))
  if (!downloaded) throw new Error('download missing')
  const downloadedPath = path.join(downloads, downloaded)
  if (sha256File(downloadedPath) !== sha256File(sourcePath)) throw new Error('hash mismatch')

  console.log('file-transfer roundtrip: 1 passed, 0 failed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
