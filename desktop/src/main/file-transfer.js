// 文件传输通道（Manifest 扩散 + 分片拉取）。
//
// 设计：发送方只通过现有 relay 通道广播一条小 manifest（type=file_transfer，
// inline:false），不主动推数据本体；接收方决定接收后，回连发送方逐片
// `GET /file/{fileId}?from=&to=&senderId=&nonce=&authToken=` 拉取，每片响应体
// 用两端共享的 pairingKey 加密（与 relay 信封同一把 key）。落盘 .part、累计
// sha256，全部到齐后校验重组、移动到下载目录。
//
// 安全：
//   - GET 只服务 outgoingTransfers 登记表里的 fileId（含 hash 不可枚举），绝不
//     接受任意路径 → 杜绝路径穿越 / 任意文件读取。
//   - authToken = hmac(peerPairingKey, `${senderId}|${nonce}|${fileId}|${from}-${to}`)
//     + nonce 防重放窗口 + fileId expiresAt 过期，三重防护。
//   - 分片读取（fs.read 指定 offset/length），单片 ≤ chunkSize，不把整文件读进内存。
//
// 该模块用工厂函数 + 依赖注入，不直接依赖 Electron，可脱离主进程单测。
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024 // 4MB
const DEFAULT_OFFER_TTL_MS = 30 * 60 * 1000 // offer 30 分钟过期
const NONCE_TTL_MS = 5 * 60 * 1000
const NONCE_LIMIT = 500
const DEFAULT_PARALLEL_PULLS = 4

// 极简扩展名 → mime（仅用于展示，不参与安全判定）
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

function guessMime(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

function sanitizeFileName(name) {
  // 去掉路径分隔与控制字符，落盘时再不信任远端名
  const base = path.basename(String(name || '').replace(/[\\/]/g, '_'))
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim().replace(/^[._\s-]+/, '')
  return cleaned.slice(0, 180) || 'file'
}

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8')
  const bufB = Buffer.from(String(b || ''), 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// relativePath 的目录部分（最后一段是文件名，由 manifest.name 决定）。
// 逐段消毒并丢弃 ".."/"."，杜绝远端构造路径穿越。
function safeRelativeDir(relativePath) {
  return String(relativePath || '')
    .split(/[\\/]+/)
    .slice(0, -1)
    .map(part => sanitizeFileName(part))
    .filter(part => part && part !== '.' && part !== '..')
    .slice(0, 8)
    .join(path.sep)
}

// 流式算 sha256 + size，不把整文件读进内存
function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    let size = 0
    const stream = fs.createReadStream(absPath)
    stream.on('data', chunk => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }))
    stream.on('error', reject)
  })
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function hashFileBlocks(absPath, chunkSize) {
  return new Promise((resolve, reject) => {
    const hashes = []
    let pending = Buffer.alloc(0)
    const stream = fs.createReadStream(absPath, { highWaterMark: chunkSize })
    stream.on('data', chunk => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      while (pending.length >= chunkSize) {
        const block = pending.subarray(0, chunkSize)
        hashes.push(sha256Buffer(block))
        pending = pending.subarray(chunkSize)
      }
    })
    stream.on('end', () => {
      if (pending.length > 0) hashes.push(sha256Buffer(pending))
      resolve(hashes)
    })
    stream.on('error', reject)
  })
}

// 读源文件 [from, to]（含端点）一段，返回 Buffer
function readFileRange(absPath, from, to) {
  return new Promise((resolve, reject) => {
    const length = to - from + 1
    if (length <= 0) {
      resolve(Buffer.alloc(0))
      return
    }
    fs.open(absPath, 'r', (openErr, fd) => {
      if (openErr) {
        reject(openErr)
        return
      }
      const buffer = Buffer.alloc(length)
      fs.read(fd, buffer, 0, length, from, (readErr, bytesRead) => {
        fs.close(fd, () => {})
        if (readErr) {
          reject(readErr)
          return
        }
        resolve(bytesRead === length ? buffer : buffer.subarray(0, bytesRead))
      })
    })
  })
}

function buildBlockPlan(size, chunkSize) {
  const blocks = []
  let offset = 0
  let index = 0
  while (offset < size) {
    const to = Math.min(offset + chunkSize - 1, size - 1)
    blocks.push({ index, from: offset, to, length: to - offset + 1 })
    offset = to + 1
    index += 1
  }
  return blocks
}

function loadIncomingSidecar(sidecarPath, manifest, size, chunkSize) {
  try {
    if (!fs.existsSync(sidecarPath)) return new Set()
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
    if (parsed.fileId !== manifest.fileId) return new Set()
    if (String(parsed.sha256 || '') !== String(manifest.sha256 || '')) return new Set()
    if (Number(parsed.size || 0) !== Number(size)) return new Set()
    if (Number(parsed.chunkSize || 0) !== Number(chunkSize)) return new Set()
    return new Set(Array.isArray(parsed.completedBlocks)
      ? parsed.completedBlocks.map(Number).filter(Number.isInteger)
      : [])
  } catch (_) {
    return new Set()
  }
}

function saveIncomingSidecar(sidecarPath, manifest, size, chunkSize, completedBlocks) {
  try {
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true })
    fs.writeFileSync(sidecarPath, JSON.stringify({
      version: 1,
      fileId: manifest.fileId,
      sha256: manifest.sha256 || '',
      size,
      chunkSize,
      completedBlocks: Array.from(completedBlocks).sort((a, b) => a - b),
      updatedAt: Date.now()
    }), 'utf8')
  } catch (_) {}
}

function createFileTransfer(deps = {}) {
  const {
    getIdentity,
    encryptBytes,
    decryptBytes,
    hmacBase64,
    generateNonce,
    sendManifest, // async (targetIds, basePayload) => deliveredCount
    lookupPeerKey, // (deviceId) => pairingKeyB64 | null   服务分片时验签+加密用
    resolveSource, // (originDeviceId, manifest) => {host, hosts, port, pairingKey, id, name} | null  拉取时用
    resolveRelayCandidates = () => [], // (originId) => [{id, host, port, name}] 源不可直达时的代理节点
    httpGet, // async ({host, port, path, timeoutMs}) => {status, body:Buffer} | null
    downloadDir,
    tmpDir,
    maxChunkBytes = DEFAULT_CHUNK_BYTES,
    maxParallelPulls = DEFAULT_PARALLEL_PULLS,
    offerTtlMs = DEFAULT_OFFER_TTL_MS,
    onComplete = () => {},
    onProgress = () => {},
    onError = () => {},
    log = () => {}
  } = deps

  // fileId -> { path, name, mime, size, sha256, chunkSize, expiresAt, targetDeviceIds:Set }
  const outgoingTransfers = new Map()
  // fileId -> { tmpPath, name, mime, size, sha256, chunkSize, received, source, hash, active }
  const incomingTransfers = new Map()
  // senderId -> Map<nonce, firstSeenAt>   分片 GET 防重放
  const recentChunkNonces = new Map()

  function pruneExpired(now = Date.now()) {
    for (const [fileId, t] of outgoingTransfers) {
      if (t.expiresAt && now > t.expiresAt) outgoingTransfers.delete(fileId)
    }
    // 入站表只在完成/失败时清理；这里清理早已无进展的（用 offerTtl 的两倍兜底）
    for (const [fileId, t] of incomingTransfers) {
      if (t.expiresAt && now > t.expiresAt + offerTtlMs) {
        cleanupIncoming(fileId)
      }
    }
    // 回收分片 nonce 去重表：内层条目按 TTL 过期，外层 senderId 桶在内层清空后
    // 也需删除，否则每个曾交互过的 senderId 会留一个永不回收的空桶（内存泄漏）
    for (const [senderId, seen] of recentChunkNonces) {
      for (const [n, firstSeen] of seen) {
        if (now - firstSeen > NONCE_TTL_MS) seen.delete(n)
      }
      if (seen.size === 0) recentChunkNonces.delete(senderId)
    }
  }

  function isReplayedChunkNonce(senderId, nonce) {
    if (!senderId || !nonce) return true
    const now = Date.now()
    let seen = recentChunkNonces.get(senderId)
    if (!seen) {
      seen = new Map()
      recentChunkNonces.set(senderId, seen)
    }
    for (const [n, firstSeen] of seen) {
      if (now - firstSeen > NONCE_TTL_MS) seen.delete(n)
    }
    if (seen.has(nonce)) return true
    seen.set(nonce, now)
    while (seen.size > NONCE_LIMIT) {
      const oldest = seen.keys().next().value
      seen.delete(oldest)
    }
    return false
  }

  // ===== 发送侧 =====

  // offerFile：登记一份本机文件待传，并向 targetIds 广播 manifest。
  async function offerFile(absPath, targetIds, options = {}) {
    const identity = getIdentity()
    let stat
    try {
      stat = fs.statSync(absPath)
    } catch (e) {
      onError({ phase: 'offer', error: `无法读取文件: ${e.message}` })
      return null
    }
    if (!stat.isFile() || stat.size <= 0) {
      onError({ phase: 'offer', error: '不是有效文件或文件为空' })
      return null
    }
    const chunkSize = maxChunkBytes
    const [{ sha256, size }, blockHashes] = await Promise.all([
      hashFile(absPath),
      hashFileBlocks(absPath, chunkSize)
    ])
    const ts = Date.now()
    const shortHash = sha256.slice(0, 24)
    const fileId = `file-${identity.id}-${ts}-${shortHash}`
    const name = path.basename(absPath)
    const mime = guessMime(name)
    const chunkEncodings = options.allowPlainChunks === false ? ['aes-gcm'] : ['none', 'aes-gcm']
    const blockCount = Math.ceil(size / chunkSize)
    const expiresAt = ts + offerTtlMs
    const targets = Array.isArray(targetIds) ? targetIds.map(String).filter(Boolean) : []
    const payloadExtra = options.payloadExtra && typeof options.payloadExtra === 'object'
      ? options.payloadExtra
      : {}

    outgoingTransfers.set(fileId, {
      path: absPath,
      name,
      mime,
      size,
      sha256,
      chunkSize,
      expiresAt,
      targetDeviceIds: new Set(targets),
      chunkEncodings: new Set(chunkEncodings)
    })

    const sourceHost = String(options.sourceHost || payloadExtra.sourceHost || '').trim()
    const sourceTsHost = String(options.sourceTsHost || payloadExtra.sourceTsHost || '').trim()
    const sourceAltHosts = Array.from(new Set([
      ...(Array.isArray(options.sourceAltHosts) ? options.sourceAltHosts : []),
      ...(Array.isArray(payloadExtra.sourceAltHosts) ? payloadExtra.sourceAltHosts : [])
    ].map(host => String(host || '').trim()).filter(Boolean)))
    const manifest = {
      fileId,
      name,
      mime,
      size,
      sha256,
      chunkSize,
      blockSize: chunkSize,
      blockCount,
      blockHashes,
      transferProtocol: 'codebridge-block-v1',
      resumeSupported: true,
      originDeviceId: identity.id,
      expiresAt,
      inline: false,
      chunkEncodings
    }
    if (sourceHost) manifest.host = sourceHost
    if (sourceTsHost) manifest.tsHost = sourceTsHost
    if (sourceAltHosts.length > 0) manifest.altHosts = sourceAltHosts
    // 目录分享：相对路径（含文件名）随 manifest 下发，接收端消毒后重建目录树
    if (options.relativePath) manifest.relativePath = String(options.relativePath)
    const payloadType = String(options.type || 'file_transfer')
    const source = String(options.source || (payloadType === 'clipboard_file' ? '剪贴板文件' : '文件传输'))
    const rawPrefix = String(options.rawPrefix || (payloadType === 'clipboard_file' ? '剪贴板文件' : '文件'))
    // 调用方附加字段（如剪贴板大图的 clipVersion）先铺底，骨架字段不允许被覆盖
    const basePayload = {
      ...payloadExtra,
      type: payloadType,
      code: '',
      source,
      label: name,
      rawMessage: `${rawPrefix} ${name}`,
      timestamp: ts,
      phoneId: identity.id,
      phoneName: identity.name,
      sourceDeviceId: identity.id,
      sourceDeviceName: identity.name,
      sourceDeviceType: identity.type,
      originDeviceId: identity.id,
      originDeviceName: identity.name,
      originMessageId: fileId,
      relayMessageId: fileId,
      fileManifest: manifest,
      targetDeviceIds: targets
    }

    try {
      const delivered = await sendManifest(targets, basePayload)
      log(`文件 offer 已下发 ${name} (${size}B) → ${delivered} 个目标`)
      return { fileId, manifest, delivered }
    } catch (e) {
      onError({ phase: 'offer', error: e.message })
      return { fileId, manifest, delivered: 0 }
    }
  }

  // serveFileChunk：HTTP server 调用，校验鉴权后返回加密分片 Buffer。
  // 返回 { status, body?:Buffer, contentRange?:string, totalSize?:number }
  async function serveFileChunk({ fileId, from, to, senderId, nonce, authToken, chunkEncoding = 'aes-gcm' }) {
    pruneExpired()
    const transfer = outgoingTransfers.get(String(fileId || ''))
    if (!transfer) return { status: 404 }
    if (transfer.expiresAt && Date.now() > transfer.expiresAt) {
      outgoingTransfers.delete(fileId)
      return { status: 410 } // Gone
    }
    // 请求者必须是 offer 的目标之一
    if (transfer.targetDeviceIds.size > 0 && !transfer.targetDeviceIds.has(String(senderId || ''))) {
      return { status: 403 }
    }
    const peerKey = lookupPeerKey(senderId)
    if (!peerKey) return { status: 403 }

    const fromN = Number(from)
    const toN = Number(to)
    if (!Number.isInteger(fromN) || !Number.isInteger(toN) || fromN < 0 || toN < fromN) {
      return { status: 400 }
    }
    if (fromN >= transfer.size) return { status: 416 } // Range Not Satisfiable
    const clampedTo = Math.min(toN, transfer.size - 1)
    if (clampedTo - fromN + 1 > transfer.chunkSize) return { status: 400 } // 单片不得超过约定 chunkSize

    // 验签：authToken 绑定 fileId + range，防止换片重放
    const expected = hmacBase64(peerKey, `${senderId}|${nonce}|${fileId}|${fromN}-${clampedTo}`)
    if (!timingSafeStrEqual(expected, authToken)) return { status: 403 }
    if (isReplayedChunkNonce(senderId, nonce)) return { status: 409 } // 重放

    let plainSlice
    try {
      plainSlice = await readFileRange(transfer.path, fromN, clampedTo)
    } catch (e) {
      onError({ phase: 'serve', fileId, error: e.message })
      return { status: 500 }
    }
    const usePlainChunk = chunkEncoding === 'none' && transfer.chunkEncodings?.has('none')
    const body = usePlainChunk ? plainSlice : encryptBytes(plainSlice, peerKey)
    if (!body) return { status: 500 }
    return {
      status: 206,
      body,
      contentRange: `bytes ${fromN}-${clampedTo}/${transfer.size}`,
      totalSize: transfer.size
    }
  }

  // ===== 接收侧 =====

  function cleanupIncoming(fileId) {
    const t = incomingTransfers.get(fileId)
    if (t) {
      t.active = false
      try {
        if (t.tmpPath && fs.existsSync(t.tmpPath)) fs.unlinkSync(t.tmpPath)
      } catch (_) {}
      try {
        const sidecarPath = `${t.tmpPath}.json`
        if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath)
      } catch (_) {}
    }
    incomingTransfers.delete(fileId)
  }

  // startIncomingPull：收到 manifest 且决定接收后，逐片回连源设备拉取。
  // maxBytes：接收方策略上限（maxFileSizeMb 换算），超限直接拒绝。
  // targetDir / onComplete 可按调用覆盖（剪贴板大图：不落下载目录、
  // 完成后写剪贴板而非弹"文件接收完成"通知）。
  async function startIncomingPull(manifest, options = {}) {
    const fileId = String(manifest.fileId || '')
    if (!fileId) return false
    if (incomingTransfers.has(fileId)) return false // 已在传

    const saveDir = String(options.targetDir || downloadDir)
    const completeHook = typeof options.onComplete === 'function' ? options.onComplete : onComplete
    const size = Number(manifest.size || 0)
    const chunkSize = Math.min(Number(manifest.chunkSize) || maxChunkBytes, maxChunkBytes)
    const maxBytes = Number(options.maxBytes) || Infinity
    if (size <= 0 || size > maxBytes) {
      onError({ phase: 'pull', fileId, error: `文件超出接收上限或大小无效 (${size}B)` })
      return false
    }
    const source = resolveSource(manifest.originDeviceId, manifest)
    // 源没有直达地址时不再立即失败：还可以经可信节点代理拉取（多跳场景）
    const relayCandidates = (resolveRelayCandidates(manifest.originDeviceId) || [])
      .filter(cand => cand && cand.host)
    const sourceHosts = Array.from(new Set([
      ...(Array.isArray(source?.hosts) ? source.hosts : []),
      source?.host
    ].map(host => String(host || '').trim()).filter(Boolean)))
    if (!source || !source.pairingKey || (sourceHosts.length === 0 && relayCandidates.length === 0)) {
      onError({ phase: 'pull', fileId, error: '找不到源设备的可达地址或密钥' })
      return false
    }

    const identity = getIdentity()
    const name = sanitizeFileName(manifest.name)
    const usePlainChunks = Array.isArray(manifest.chunkEncodings) && manifest.chunkEncodings.includes('none')
    const tmpPath = path.join(tmpDir, `${fileId}.part`)
    const sidecarPath = `${tmpPath}.json`
    const blocks = buildBlockPlan(size, chunkSize)
    const completedBlocks = loadIncomingSidecar(sidecarPath, manifest, size, chunkSize)
    if (!fs.existsSync(tmpPath)) completedBlocks.clear()
    for (const index of Array.from(completedBlocks)) {
      if (!blocks[index]) completedBlocks.delete(index)
    }
    const completedBytes = () => Array.from(completedBlocks)
      .reduce((sum, index) => sum + (blocks[index]?.length || 0), 0)
    try {
      fs.mkdirSync(tmpDir, { recursive: true })
      fs.mkdirSync(saveDir, { recursive: true })
    } catch (_) {}

    const record = {
      tmpPath,
      name,
      mime: manifest.mime || 'application/octet-stream',
      size,
      sha256: String(manifest.sha256 || ''),
      chunkSize,
      received: completedBytes(),
      source,
      active: true,
      expiresAt: Number(manifest.expiresAt) || Date.now() + offerTtlMs
    }
    incomingTransfers.set(fileId, record)

    let fd
    try {
      fd = fs.openSync(tmpPath, fs.existsSync(tmpPath) ? 'r+' : 'w+')
      const stat = fs.fstatSync(fd)
      if (stat.size !== size) fs.ftruncateSync(fd, size)
      saveIncomingSidecar(sidecarPath, manifest, size, chunkSize, completedBlocks)
    } catch (e) {
      onError({ phase: 'pull', fileId, error: `无法创建临时文件: ${e.message}` })
      incomingTransfers.delete(fileId)
      return false
    }

    try {
      const fileIdEnc = encodeURIComponent(fileId)
      const originIdEnc = encodeURIComponent(String(manifest.originDeviceId || ''))
      // 拉取通道：直连源设备优先，其后是可信节点代理（多跳场景，代理只
      // 转发字节，鉴权与分片加密仍在本机与源设备之间端到端完成）。
      // 锁定首个可用通道；中途失败重试两次后顺延切换。
      // 通道：直连源设备优先，其后是可信节点代理（多跳）。每个分片都从首个
      // 通道重新尝试——不再用单调递增的索引锁定通道，否则某片偶发失败切到 proxy
      // 后，即使直连随后恢复也永远回不去。direct 恢复即自动用回 direct。
      const transports = []
      for (const host of sourceHosts) {
        transports.push({ kind: 'direct', host, port: source.port, label: `direct:${host}` })
      }
      for (const cand of relayCandidates) {
        transports.push({ kind: 'proxy', host: cand.host, port: cand.port, label: `proxy:${cand.id}` })
      }
      const transportFailures = new Map()
      const orderedTransports = () => transports.slice().sort((a, b) => {
        const failDiff = (transportFailures.get(a.label) || 0) - (transportFailures.get(b.label) || 0)
        if (failDiff !== 0) return failDiff
        return a.kind === b.kind ? 0 : (a.kind === 'direct' ? -1 : 1)
      })
      const markTransportSuccess = label => transportFailures.set(label, 0)
      const markTransportFailure = label => transportFailures.set(label, (transportFailures.get(label) || 0) + 1)
      const fetchChunk = async (offset, to) => {
        for (const transport of orderedTransports()) {
          for (let attempt = 0; attempt < 2; attempt++) {
            // nonce 每次请求重新生成：上一通道可能已把 nonce 送达源设备
            const nonce = generateNonce()
            const authToken = hmacBase64(source.pairingKey, `${identity.id}|${nonce}|${fileId}|${offset}-${to}`)
            const query =
              `from=${offset}&to=${to}` +
              `&senderId=${encodeURIComponent(identity.id)}` +
              `&nonce=${encodeURIComponent(nonce)}` +
              `&authToken=${encodeURIComponent(authToken)}` +
              (usePlainChunks ? '&chunkEncoding=none' : '')
            const reqPath = transport.kind === 'direct'
              ? `/file/${fileIdEnc}?${query}`
              : `/file/proxy/${originIdEnc}/${fileIdEnc}?${query}&hop=3`
            const resp = await httpGet({ host: transport.host, port: transport.port, path: reqPath, timeoutMs: 20000 })
            if (resp && resp.status === 206 && Buffer.isBuffer(resp.body)) {
              markTransportSuccess(transport.label)
              return resp
            }
            markTransportFailure(transport.label)
          }
          markTransportFailure(transport.label)
          log(`分片通道不可用 ${transport.label}，尝试下一通道`)
        }
        return null
      }

      const pendingBlocks = blocks.filter(block => !completedBlocks.has(block.index))
      let nextPendingIndex = 0
      const parallelism = Math.max(1, Math.min(4, Number(options.parallelism || maxParallelPulls) || 1))
      const blockHashes = Array.isArray(manifest.blockHashes) ? manifest.blockHashes : []
      const worker = async () => {
        while (record.active) {
          const block = pendingBlocks[nextPendingIndex++]
          if (!block) return
          const offset = block.from
          const to = block.to
          let plain = null
          let lastChunkError = ''
          for (let attempt = 0; attempt < 3; attempt++) {
            const resp = await fetchChunk(offset, to)
            if (!resp) {
              lastChunkError = `chunk pull failed: all transports unreachable @${offset}`
              continue
            }
            const candidate = usePlainChunks ? resp.body : decryptBytes(resp.body, source.pairingKey)
            if (!candidate) {
              lastChunkError = `chunk decrypt failed @${offset}`
              continue
            }
            if (candidate.length !== block.length) {
              lastChunkError = `chunk length mismatch expected=${block.length} got=${candidate.length} @${offset}`
              continue
            }
            const expectedHash = String(blockHashes[block.index] || '').toLowerCase()
            if (expectedHash && !timingSafeStrEqual(sha256Buffer(candidate), expectedHash)) {
              lastChunkError = `chunk hash mismatch @${offset}`
              continue
            }
            plain = candidate
            break
          }
          if (!plain) {
            // 标记整次传输失败，令兄弟 worker 在循环顶部退出，避免它们
            // 在 catch 关闭 fd 后仍向已关闭的 fd 写入（EBADF / 未捕获 rejection）
            record.active = false
            throw new Error(lastChunkError || `chunk pull failed @${offset}`)
          }
          // fd 可能已被并发失败的 catch 关闭，写入前复查
          if (!record.active) return
          fs.writeSync(fd, plain, 0, plain.length, offset)
          completedBlocks.add(block.index)
          record.received = completedBytes()
          saveIncomingSidecar(sidecarPath, manifest, size, chunkSize, completedBlocks)
          onProgress({ fileId, name, received: record.received, size })
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(parallelism, pendingBlocks.length || 1) },
        () => worker()
      ))
      if (completedBlocks.size !== blocks.length) {
        throw new Error(`incomplete transfer blocks=${completedBlocks.size}/${blocks.length}`)
      }
    } catch (e) {
      // 先停掉所有在途 worker，再关闭 fd：否则仍在 await fetchChunk 的兄弟
      // worker 返回后会写入已关闭的 fd
      record.active = false
      try { fs.closeSync(fd) } catch (_) {}
      onError({ phase: 'pull', fileId, error: e.message })
      incomingTransfers.delete(fileId)
      return false
    }

    try { fs.closeSync(fd) } catch (_) {}

    if (!record.active) {
      cleanupIncoming(fileId)
      return false
    }

    // 校验 sha256 重组
    const { sha256: actualHash } = await hashFile(tmpPath)
    if (record.sha256 && !timingSafeStrEqual(actualHash, record.sha256)) {
      onError({ phase: 'pull', fileId, error: `sha256 校验失败，丢弃 (期望 ${record.sha256.slice(0, 12)} 实得 ${actualHash.slice(0, 12)})` })
      cleanupIncoming(fileId)
      return false
    }

    // 移动到目标目录（目录分享按消毒后的 relativePath 重建子目录），重名加序号
    try {
      if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath)
    } catch (_) {}
    const relativeDir = safeRelativeDir(manifest.relativePath)
    const finalDir = relativeDir ? path.join(saveDir, relativeDir) : saveDir
    try { fs.mkdirSync(finalDir, { recursive: true }) } catch (_) {}
    const finalPath = uniqueDownloadPath(name, finalDir)
    try {
      fs.renameSync(tmpPath, finalPath)
    } catch (e) {
      // 跨卷 rename 失败时回退为拷贝
      try {
        fs.copyFileSync(tmpPath, finalPath)
        fs.unlinkSync(tmpPath)
      } catch (e2) {
        onError({ phase: 'pull', fileId, error: `落盘失败: ${e2.message}` })
        cleanupIncoming(fileId)
        return false
      }
    }
    incomingTransfers.delete(fileId)
    completeHook({
      fileId,
      name,
      path: finalPath,
      size,
      mime: manifest.mime || '',
      sourceId: source.id || manifest.originDeviceId || '',
      sourceName: source.name || manifest.originDeviceName || '',
      sourceType: source.type || ''
    })
    log(`文件接收完成 ${name} → ${finalPath}`)
    return true
  }

  function uniqueDownloadPath(name, dir = downloadDir) {
    const safe = sanitizeFileName(name)
    let candidate = path.join(dir, safe)
    if (!fs.existsSync(candidate)) return candidate
    const ext = path.extname(safe)
    const stem = safe.slice(0, safe.length - ext.length)
    for (let i = 1; i < 10000; i++) {
      candidate = path.join(dir, `${stem} (${i})${ext}`)
      if (!fs.existsSync(candidate)) return candidate
    }
    return path.join(dir, `${stem}-${Date.now()}${ext}`)
  }

  function cancelAll() {
    for (const fileId of Array.from(incomingTransfers.keys())) {
      cleanupIncoming(fileId)
    }
    outgoingTransfers.clear()
  }

  return {
    offerFile,
    serveFileChunk,
    startIncomingPull,
    pruneExpired,
    cancelAll,
    // 暴露给测试/诊断
    _outgoing: outgoingTransfers,
    _incoming: incomingTransfers
  }
}

module.exports = {
  createFileTransfer,
  guessMime,
  sanitizeFileName,
  hashFile,
  readFileRange,
  DEFAULT_CHUNK_BYTES
}
