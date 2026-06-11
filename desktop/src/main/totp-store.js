const crypto = require('crypto')

function generateTotpCode(seed, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const key = base32ToBuffer(seed.secret)
  const digits = Number(seed.digits) || 6
  const period = Number(seed.period) || 30
  if (key.length === 0) return ''.padStart(digits, '0')

  const counter = BigInt(Math.floor(timestampSeconds / period))
  const counterBuffer = Buffer.alloc(8)
  let value = counter
  for (let i = 7; i >= 0; i -= 1) {
    counterBuffer[i] = Number(value & 0xffn)
    value >>= 8n
  }

  const hmacAlgorithm = seed.algorithm === 'SHA512'
    ? 'sha512'
    : seed.algorithm === 'SHA256'
      ? 'sha256'
      : 'sha1'
  const digest = crypto.createHmac(hmacAlgorithm, key).update(counterBuffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  const otp = binary % (10 ** digits)
  return String(otp).padStart(digits, '0')
}

function base32ToBuffer(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []

  for (const char of String(base32 || '').toUpperCase().replace(/[\s-=]/g, '')) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }

  return Buffer.from(bytes)
}

module.exports = {
  generateTotpCode,
  base32ToBuffer
}
