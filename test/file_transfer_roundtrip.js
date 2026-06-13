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

  const offer = await sender.offerFile(sourcePath, [receiverId], {
    payloadExtra: {
      sourceHost: '192.0.2.10',
      sourceTsHost: '127.0.0.1',
      sourceAltHosts: ['127.0.0.1']
    }
  })
  if (!offer || !manifest) throw new Error('offer failed')
  if (manifest.host !== '192.0.2.10' || manifest.tsHost !== '127.0.0.1') {
    throw new Error('source addresses missing from manifest')
  }

  const directHosts = []
  const receiver = createFileTransfer({
    getIdentity: () => ({ id: receiverId, name: 'Phone B', type: 'ANDROID_PHONE' }),
    encryptBytes,
    decryptBytes,
    hmacBase64,
    generateNonce: () => crypto.randomBytes(16).toString('base64'),
    sendManifest: async () => 0,
    lookupPeerKey: () => null,
    resolveSource: (id, incomingManifest) => id === senderId
      ? {
          id: senderId,
          name: 'Desktop A',
          host: '192.0.2.10',
          hosts: [incomingManifest.host, incomingManifest.tsHost],
          port: 19529,
          pairingKey: key
        }
      : null,
    httpGet: async ({ host, path: reqPath }) => {
      directHosts.push(host)
      if (host !== '127.0.0.1') return null
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
  if (!directHosts.includes('192.0.2.10') || !directHosts.includes('127.0.0.1')) {
    throw new Error('direct multi-host fallback not exercised')
  }

  const downloaded = fs.readdirSync(downloads).find(name => name === path.basename(sourcePath))
  if (!downloaded) throw new Error('download missing')
  const downloadedPath = path.join(downloads, downloaded)
  if (sha256File(downloadedPath) !== sha256File(sourcePath)) throw new Error('hash mismatch')

  // ===== 用例 2：relativePath 重建目录树（目录分享） =====
  let dirManifest = null
  const dirSource = path.join(tmp, 'tree.bin')
  fs.writeFileSync(dirSource, crypto.randomBytes(64 * 1024 + 7))
  const dirSender = createFileTransfer({
    getIdentity: () => ({ id: senderId, name: 'Desktop A', type: 'WINDOWS_DESKTOP' }),
    encryptBytes,
    decryptBytes,
    hmacBase64,
    generateNonce: () => crypto.randomBytes(16).toString('base64'),
    sendManifest: async (targets, payload) => {
      dirManifest = payload.fileManifest
      return targets.length
    },
    lookupPeerKey: id => id === receiverId ? key : null,
    resolveSource: () => null,
    httpGet: async () => null,
    downloadDir: downloads,
    tmpDir: incomingTmp,
    maxChunkBytes: 256 * 1024
  })
  await dirSender.offerFile(dirSource, [receiverId], { relativePath: 'myfolder/sub/../..\\evil/tree.bin' })
  if (!dirManifest || dirManifest.relativePath !== 'myfolder/sub/../..\\evil/tree.bin') {
    throw new Error('relativePath missing in manifest')
  }
  const dirServeChunk = async ({ path: reqPath }) => {
    const url = new URL(reqPath, 'http://127.0.0.1')
    const prefix = url.pathname.startsWith('/file/proxy/')
      ? url.pathname.split('/').slice(0, 4).join('/') + '/'
      : '/file/'
    const result = await dirSender.serveFileChunk({
      fileId: decodeURIComponent(url.pathname.slice(prefix.length)),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      senderId: url.searchParams.get('senderId'),
      nonce: url.searchParams.get('nonce'),
      authToken: url.searchParams.get('authToken')
    })
    return { status: result.status, body: result.body }
  }
  // 用例 3 一并验证：直连不可达（resolveSource 无 host）时经代理候选回退拉取
  const proxyHits = []
  const dirReceiver = createFileTransfer({
    getIdentity: () => ({ id: receiverId, name: 'Phone B', type: 'ANDROID_PHONE' }),
    encryptBytes,
    decryptBytes,
    hmacBase64,
    generateNonce: () => crypto.randomBytes(16).toString('base64'),
    sendManifest: async () => 0,
    lookupPeerKey: () => null,
    resolveSource: id => id === senderId
      ? { id: senderId, name: 'Desktop A', host: '', port: 19529, pairingKey: key }
      : null,
    resolveRelayCandidates: () => [{ id: 'relay-c', host: '10.0.0.9', port: 19529, name: 'Relay C' }],
    httpGet: async ({ host, path: reqPath }) => {
      if (host !== '10.0.0.9' || !reqPath.startsWith(`/file/proxy/${senderId}/`)) return null
      proxyHits.push(reqPath)
      return dirServeChunk({ path: reqPath })
    },
    downloadDir: downloads,
    tmpDir: incomingTmp,
    maxChunkBytes: 256 * 1024
  })
  const dirPulled = await dirReceiver.startIncomingPull(dirManifest, { maxBytes: 10 * 1024 * 1024 })
  if (!dirPulled) throw new Error('proxy/relativePath pull failed')
  if (proxyHits.length === 0) throw new Error('proxy transport not used')
  // 消毒后只保留 myfolder/sub/evil（.. 段被剔除，文件名取 manifest.name）
  const treePath = path.join(downloads, 'myfolder', 'sub', 'evil', 'tree.bin')
  if (!fs.existsSync(treePath)) throw new Error(`relativePath tree missing: ${treePath}`)
  if (sha256File(treePath) !== sha256File(dirSource)) throw new Error('tree hash mismatch')

  console.log('file-transfer roundtrip: 3 passed, 0 failed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
