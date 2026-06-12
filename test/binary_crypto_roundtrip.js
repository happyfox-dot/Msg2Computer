// 验证二进制 GCM 变体：自洽 round-trip + 与 utf8 版同布局可互解（跨端兼容证明）
const crypto = require('crypto')

function encryptMessage(plaintext, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64')
}
function decryptMessage(encB64, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const data = Buffer.from(encB64, 'base64')
  const iv = data.subarray(0, 12), tag = data.subarray(data.length - 16), ct = data.subarray(12, data.length - 16)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag)
  return d.update(ct, null, 'utf8') + d.final('utf8')
}
function encryptBytes(plainBuffer, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plainBuffer), cipher.final()])
  return Buffer.concat([iv, ct, cipher.getAuthTag()])
}
function decryptBytes(buf, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const iv = buf.subarray(0, 12), tag = buf.subarray(buf.length - 16), ct = buf.subarray(12, buf.length - 16)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

const key = crypto.randomBytes(32).toString('base64')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++ } else { fail++; console.error('FAIL:', m) } }

// 1. 二进制自洽：1MB 随机数据
const blob = crypto.randomBytes(1024 * 1024)
ok(Buffer.compare(decryptBytes(encryptBytes(blob, key), key), blob) === 0, '1MB binary round-trip')

// 2. 空 + 1 字节边界
ok(Buffer.compare(decryptBytes(encryptBytes(Buffer.alloc(0), key), key), Buffer.alloc(0)) === 0, 'empty buffer')
ok(decryptBytes(encryptBytes(Buffer.from([0x42]), key), key)[0] === 0x42, 'single byte')

// 3. 同布局：encryptBytes 产出可被 utf8 版 decryptMessage 解（内容是 utf8 文本时）
const text = '验证码 file-transfer 测试 🔐'
const encBytes = encryptBytes(Buffer.from(text, 'utf8'), key)
ok(decryptMessage(encBytes.toString('base64'), key) === text, 'encryptBytes -> decryptMessage (same layout)')

// 4. 反向：encryptMessage 产出可被 decryptBytes 解
ok(decryptBytes(Buffer.from(encryptMessage(text, key), 'base64'), key).toString('utf8') === text, 'encryptMessage -> decryptBytes')

// 5. 篡改 tag 应失败（GCM 认证失败抛异常；生产代码 try/catch 返回 null，此处直接断言抛出）
const tampered = encryptBytes(blob, key); tampered[tampered.length - 1] ^= 0xff
let tamperRejected = false
try { decryptBytes(tampered, key) } catch { tamperRejected = true }
ok(tamperRejected, 'tamper detection')

console.log(`\n二进制 crypto: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
