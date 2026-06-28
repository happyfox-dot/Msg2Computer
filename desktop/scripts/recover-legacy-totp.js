const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { app, safeStorage } = require('electron')

const LOCAL_TOTP_SOURCE_ID = 'desktop-local'

function parseArgs(argv) {
  const args = {
    apply: false,
    legacyDir: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codebridge'),
    currentDir: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'code-sync-desktop'),
    keyFile: path.join(os.homedir(), '.codebridge-key'),
    sourcePairing: ''
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') args.apply = true
    else if (arg === '--legacy-dir') args.legacyDir = path.resolve(argv[++i] || '')
    else if (arg === '--current-dir') args.currentDir = path.resolve(argv[++i] || '')
    else if (arg === '--key-file') args.keyFile = path.resolve(argv[++i] || '')
    else if (arg === '--source-pairing') args.sourcePairing = path.resolve(argv[++i] || '')
  }
  return args
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : ''
}

function decryptSafeStorageValue(raw) {
  if (!raw.startsWith('safe:')) return raw
  if (!safeStorage?.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage is not available, cannot decrypt legacy key')
  }
  return safeStorage.decryptString(Buffer.from(raw.slice(5), 'base64'))
}

function collectKeyCandidates(keyFile) {
  const keys = []
  const add = (value, source) => {
    const key = String(value || '').trim()
    if (/^[a-fA-F0-9]{64}$/.test(key) && !keys.some(item => item.key === key)) {
      keys.push({ key, source })
    }
  }

  const raw = readText(keyFile)
  if (raw) {
    try {
      add(decryptSafeStorageValue(raw), raw.startsWith('safe:') ? 'safeStorage key file' : 'plain key file')
    } catch (error) {
      console.error(`[recover-legacy-totp] Cannot read legacy key: ${error.message}`)
    }
  }

  add(crypto.createHash('sha256').update('codebridge-default-key').digest('hex'), 'old fallback key')
  return keys
}

function decryptLegacyData(encrypted, keyHex) {
  if (encrypted.startsWith('gcm:')) {
    const parts = encrypted.split(':')
    if (parts.length < 4) throw new Error('invalid gcm payload')
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(keyHex, 'hex'),
      Buffer.from(parts[1], 'hex')
    )
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'))
    return decipher.update(parts[3], 'hex', 'utf8') + decipher.final('utf8')
  }

  const parts = encrypted.split(':')
  if (parts.length < 2) throw new Error('invalid cbc payload')
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(keyHex, 'hex'),
    Buffer.from(parts[0], 'hex')
  )
  return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8')
}

function loadLegacyTotps(legacyFile, keyFile) {
  const encrypted = readText(legacyFile)
  if (!encrypted) return { entries: [], keySource: '', error: `missing legacy file: ${legacyFile}` }

  const errors = []
  for (const candidate of collectKeyCandidates(keyFile)) {
    try {
      const parsed = JSON.parse(decryptLegacyData(encrypted, candidate.key))
      return {
        entries: Array.isArray(parsed.totps) ? parsed.totps : [],
        keySource: candidate.source,
        error: ''
      }
    } catch (error) {
      errors.push(`${candidate.source}: ${error.message}`)
    }
  }

  return {
    entries: [],
    keySource: '',
    error: `unable to decrypt legacy store (${errors.join('; ')})`
  }
}

function normalizeSecret(secret) {
  const value = String(secret || '').toUpperCase().replace(/[\s-=]/g, '')
  return /^[A-Z2-7]{16,}$/.test(value) ? value : ''
}

function normalizeAlgorithm(algorithm) {
  const value = String(algorithm || '').toUpperCase().replace(/[-_]/g, '')
  if (value === 'SHA256') return 'SHA256'
  if (value === 'SHA512') return 'SHA512'
  return 'SHA1'
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function comparable(value) {
  return String(value || '').trim().toLowerCase()
}

function isSameTotp(a, b) {
  if (normalizeSecret(a.secret) !== normalizeSecret(b.secret)) return false
  if (normalizeAlgorithm(a.algorithm) !== normalizeAlgorithm(b.algorithm)) return false
  if (Number(a.digits || 6) !== Number(b.digits || 6)) return false
  if (Number(a.period || 30) !== Number(b.period || 30)) return false

  const issuerA = comparable(a.issuer)
  const issuerB = comparable(b.issuer)
  const accountA = comparable(a.accountName)
  const accountB = comparable(b.accountName)
  const labelA = comparable(a.label)
  const labelB = comparable(b.label)
  if (issuerA && issuerB && issuerA === issuerB && (!accountA || !accountB || accountA === accountB)) return true
  if (accountA && accountB && accountA === accountB && (!issuerA || !issuerB || issuerA === issuerB)) return true
  return !!labelA && labelA === labelB
}

function protectSecret(secret) {
  const value = String(secret || '')
  if (!value) return ''
  try {
    if (safeStorage?.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(value).toString('base64')}`
    }
  } catch (_) {
    // Fall through to portable plain wrapper.
  }
  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
}

function unprotectSecret(value) {
  const stored = String(value || '')
  if (!stored) return ''
  try {
    if (stored.startsWith('safe:')) return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
    if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  } catch (_) {
    return ''
  }
  return stored
}

function findLocalIdentity(pairing) {
  const localNode = pairing?.topologyLsdb?.nodes?.find(node =>
    node && (node.role === 'local_desktop' || node.authority === 'local_desktop')
  )
  const id = String(localNode?.id || '').trim() || `desktop-${crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 16)}`
  const name = String(localNode?.name || os.hostname() || 'Desktop').trim()
  return { id, name, type: 'WINDOWS_DESKTOP' }
}

function normalizeLegacyTotp(item, identity) {
  const secret = normalizeSecret(item.secret)
  if (!secret) return null
  const issuer = String(item.issuer || '').trim()
  const accountName = String(item.accountName || '').trim()
  const label = String(item.label || [issuer, accountName].filter(Boolean).join(': ') || 'TOTP').trim()
  const algorithm = normalizeAlgorithm(item.algorithm)
  const digits = clampInt(item.digits, 6, 8, 6)
  const period = clampInt(item.period, 15, 120, 30)
  const id = item.id || `totp-${crypto
    .createHash('sha256')
    .update([secret, issuer, accountName, label, algorithm, digits, period].join('|'))
    .digest('hex')
    .slice(0, 20)}`
  const now = Date.now()

  return {
    id,
    label,
    issuer,
    accountName,
    secret,
    algorithm,
    digits,
    period,
    phoneId: LOCAL_TOTP_SOURCE_ID,
    phoneName: `${identity.name} (本机)`,
    sourceDeviceId: identity.id,
    sourceDeviceName: identity.name,
    sourceDeviceType: identity.type,
    targetDevices: Array.isArray(item.targetDevices) ? item.targetDevices : [],
    pushAuthority: 'local_desktop',
    pushAuthorityDeviceId: identity.id,
    createdAt: Number(item.createdAt || now) || now,
    updatedAt: Number(item.updatedAt || now) || now,
    pinnedAt: Number(item.pinnedAt || 0) || 0
  }
}

function normalizePairingTotp(item, identity) {
  const seed = normalizeLegacyTotp({
    ...item,
    secret: unprotectSecret(item.secret) || item.secret
  }, identity)
  if (!seed) return null

  const isLocal = item.phoneId === LOCAL_TOTP_SOURCE_ID ||
    item.sourceDeviceId === identity.id ||
    String(item.sourceDeviceType || '').toUpperCase().includes('DESKTOP')
  return {
    ...seed,
    phoneId: isLocal ? LOCAL_TOTP_SOURCE_ID : String(item.phoneId || '').trim(),
    phoneName: item.phoneName || (isLocal ? `${identity.name} (本机)` : item.sourceDeviceName || '未知手机'),
    sourceDeviceId: isLocal ? identity.id : String(item.sourceDeviceId || item.phoneId || '').trim(),
    sourceDeviceName: isLocal ? identity.name : String(item.sourceDeviceName || item.phoneName || '未知手机').trim(),
    sourceDeviceType: isLocal ? identity.type : String(item.sourceDeviceType || 'ANDROID_PHONE').trim(),
    pushAuthority: item.pushAuthority || (isLocal ? 'local_desktop' : 'source_device'),
    pushAuthorityDeviceId: item.pushAuthorityDeviceId || (isLocal ? identity.id : String(item.sourceDeviceId || item.phoneId || '').trim())
  }
}

function toPublicSummary(seed) {
  return {
    id: seed.id,
    label: seed.label,
    issuer: seed.issuer,
    accountName: seed.accountName,
    sourceDeviceName: seed.sourceDeviceName
  }
}

function runRecovery(args) {
  const legacyFile = path.join(args.legacyDir, 'totp-store.json')
  const pairingFile = path.join(args.currentDir, 'pairing.json')
  const pairing = fs.existsSync(pairingFile)
    ? JSON.parse(fs.readFileSync(pairingFile, 'utf8'))
    : { policyVersion: 4, totpSeeds: [] }
  const identity = findLocalIdentity(pairing)
  const legacy = loadLegacyTotps(legacyFile, args.keyFile)
  const sourcePairing = args.sourcePairing && fs.existsSync(args.sourcePairing)
    ? JSON.parse(fs.readFileSync(args.sourcePairing, 'utf8'))
    : null

  const existing = Array.isArray(pairing.totpSeeds) ? pairing.totpSeeds : []
  const existingPlain = existing.map(seed => ({ ...seed, secret: unprotectSecret(seed.secret) })).filter(seed => seed.secret)
  const recoveredFromLegacy = legacy.entries
    .map(item => normalizeLegacyTotp(item, identity))
    .filter(Boolean)
  const recoveredFromPairing = Array.isArray(sourcePairing?.totpSeeds)
    ? sourcePairing.totpSeeds.map(item => normalizePairingTotp(item, identity)).filter(Boolean)
    : []
  const recovered = [...recoveredFromLegacy, ...recoveredFromPairing]

  const toImport = []
  for (const seed of recovered) {
    if (toImport.some(item => item.id === seed.id || isSameTotp(item, seed))) continue
    if (existingPlain.some(item => item.id === seed.id || isSameTotp(item, seed))) continue
    toImport.push(seed)
  }

  const result = {
    ok: true,
    apply: args.apply,
    legacyFile,
    sourcePairingFile: args.sourcePairing || '',
    pairingFile,
    keySource: legacy.keySource || '',
    legacyError: legacy.error || '',
    legacyCount: legacy.entries.length,
    sourcePairingCount: Array.isArray(sourcePairing?.totpSeeds) ? sourcePairing.totpSeeds.length : 0,
    existingCount: existing.length,
    importCount: toImport.length,
    imports: toImport.map(toPublicSummary)
  }

  if (!args.apply || toImport.length === 0) return result

  fs.mkdirSync(path.dirname(pairingFile), { recursive: true })
  if (fs.existsSync(pairingFile)) {
    const backupFile = `${pairingFile}.backup-before-legacy-totp-${Date.now()}`
    fs.copyFileSync(pairingFile, backupFile)
    result.backupFile = backupFile
  }

  pairing.policyVersion = Math.max(Number(pairing.policyVersion || 0), 4)
  pairing.totpSeeds = [
    ...existing,
    ...toImport.map(seed => ({ ...seed, secret: protectSecret(seed.secret), updatedAt: Date.now() }))
  ]
  pairing.updatedAt = Date.now()
  fs.writeFileSync(pairingFile, JSON.stringify(pairing, null, 0), 'utf8')
  return result
}

const parsedArgs = parseArgs(process.argv.slice(2))
app.setName('code-sync-desktop')
app.setPath('userData', parsedArgs.currentDir)

app.whenReady()
  .then(() => {
    const result = runRecovery(parsedArgs)
    console.log(JSON.stringify(result, null, 2))
    app.quit()
  })
  .catch(error => {
    console.error(`[recover-legacy-totp] ${error.stack || error.message}`)
    app.exit(1)
  })
