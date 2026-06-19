'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  createFileTransfer,
  sanitizeFileName,
  guessMime
} = require('../src/main/file-transfer')

function hmacBase64(key, value) {
  return crypto.createHmac('sha256', Buffer.from(String(key), 'base64'))
    .update(String(value))
    .digest('base64')
}

function nonceFactory() {
  let counter = 0
  return () => `nonce-${counter++}`
}

test('file transfer sanitizes names and guesses MIME type', () => {
  assert.equal(sanitizeFileName('../unsafe:name?.png'), 'unsafe_name_.png')
  assert.equal(sanitizeFileName(''), 'file')
  assert.equal(guessMime('photo.jpg'), 'image/jpeg')
  assert.equal(guessMime('archive.unknown'), 'application/octet-stream')
})

test('file transfer can offer, pull, resume state, and verify a plain trusted chunk stream', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-transfer-'))
  const sendDir = path.join(tmpRoot, 'send')
  const recvDir = path.join(tmpRoot, 'recv')
  const tmpDir = path.join(tmpRoot, 'tmp')
  fs.mkdirSync(sendDir, { recursive: true })
  fs.mkdirSync(recvDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  const pairingKey = Buffer.from('shared-key-for-test-32bytes').toString('base64')
  const sourcePath = path.join(sendDir, 'payload.txt')
  const content = Buffer.from('hello softbus file transfer\n'.repeat(1024), 'utf8')
  fs.writeFileSync(sourcePath, content)

  const sender = createFileTransfer({
    getIdentity: () => ({ id: 'A', name: 'Desktop A' }),
    encryptBytes: buffer => buffer,
    decryptBytes: buffer => buffer,
    hmacBase64,
    generateNonce: nonceFactory(),
    lookupPeerKey: id => (id === 'B' ? pairingKey : null),
    sendManifest: async () => 1,
    downloadDir: recvDir,
    tmpDir,
    maxChunkBytes: 4096
  })

  const offered = await sender.offerFile(sourcePath, ['B'])
  assert.equal(offered.delivered, 1)
  assert.equal(offered.manifest.blockCount > 1, true)
  assert.equal(offered.manifest.chunkEncodings.includes('none'), true)

  const receiver = createFileTransfer({
    getIdentity: () => ({ id: 'B', name: 'Phone B' }),
    encryptBytes: buffer => buffer,
    decryptBytes: buffer => buffer,
    hmacBase64,
    generateNonce: nonceFactory(),
    lookupPeerKey: () => pairingKey,
    resolveSource: () => ({ id: 'A', name: 'Desktop A', host: '127.0.0.1', port: 19529, pairingKey }),
    httpGet: async ({ path: reqPath }) => {
      const url = new URL(reqPath, 'http://127.0.0.1')
      const fileId = decodeURIComponent(url.pathname.split('/').pop())
      return sender.serveFileChunk({
        fileId,
        from: Number(url.searchParams.get('from')),
        to: Number(url.searchParams.get('to')),
        senderId: url.searchParams.get('senderId'),
        nonce: url.searchParams.get('nonce'),
        authToken: url.searchParams.get('authToken'),
        chunkEncoding: url.searchParams.get('chunkEncoding') || 'aes-gcm'
      })
    },
    downloadDir: recvDir,
    tmpDir,
    maxChunkBytes: 4096
  })

  const ok = await receiver.startIncomingPull(offered.manifest, { targetDir: recvDir, parallelism: 2 })
  assert.equal(ok, true)

  const received = fs.readFileSync(path.join(recvDir, 'payload.txt'))
  assert.deepEqual(received, content)
})
