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
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim()
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
    const { sha256, size } = await hashFile(absPath)
    const ts = Date.now()
    const shortHash = sha256.slice(0, 24)
    const fileId = `file-${identity.id}-${ts}-${shortHash}`
    const name = path.basename(absPath)
    const mime = guessMime(name)
    const chunkSize = maxChunkBytes
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
      chunkEncodings: new Set(['none', 'aes-gcm'])
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
      originDeviceId: identity.id,
      expiresAt,
      inline: false,
      chunkEncodings: ['none', 'aes-gcm']
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
      received: 0,
      source,
      hash: crypto.createHash('sha256'),
      active: true,
      expiresAt: Number(manifest.expiresAt) || Date.now() + offerTtlMs
    }
    incomingTransfers.set(fileId, record)

    let fd
    try {
      fd = fs.openSync(tmpPath, 'w')
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
      const fetchChunk = async (offset, to) => {
        for (const transport of transports) {
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
            if (resp && resp.status === 206 && Buffer.isBuffer(resp.body)) return resp
          }
          log(`分片通道不可用 ${transport.label}，尝试下一通道`)
        }
        return null
      }

      let offset = record.received
      while (offset < size && record.active) {
        const to = Math.min(offset + chunkSize - 1, size - 1)
        const resp = await fetchChunk(offset, to)
        if (!resp) {
          throw new Error(`分片拉取失败（所有通道均不可达）@${offset}`)
        }
        const plain = usePlainChunks ? resp.body : decryptBytes(resp.body, source.pairingKey)
        if (!plain) throw new Error(`分片解密失败 @${offset}`)
        const expectedLen = to - offset + 1
        if (plain.length !== expectedLen) {
          throw new Error(`分片长度不符 expected=${expectedLen} got=${plain.length} @${offset}`)
        }
        fs.writeSync(fd, plain, 0, plain.length, offset)
        record.hash.update(plain)
        record.received = offset + plain.length
        offset = record.received
        onProgress({ fileId, name, received: record.received, size })
      }
    } catch (e) {
      try { fs.closeSync(fd) } catch (_) {}
      onError({ phase: 'pull', fileId, error: e.message })
      cleanupIncoming(fileId)
      return false
    }

    try { fs.closeSync(fd) } catch (_) {}

    if (!record.active) {
      cleanupIncoming(fileId)
      return false
    }

    // 校验 sha256 重组
    const actualHash = record.hash.digest('hex')
    if (record.sha256 && !timingSafeStrEqual(actualHash, record.sha256)) {
      onError({ phase: 'pull', fileId, error: `sha256 校验失败，丢弃 (期望 ${record.sha256.slice(0, 12)} 实得 ${actualHash.slice(0, 12)})` })
      cleanupIncoming(fileId)
      return false
    }

    // 移动到目标目录（目录分享按消毒后的 relativePath 重建子目录），重名加序号
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
