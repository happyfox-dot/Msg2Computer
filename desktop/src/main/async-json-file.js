const fs = require('fs')
const path = require('path')

function makeTempPath(filePath) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  return `${filePath}.${suffix}.tmp`
}

async function writeJsonAtomic(filePath, state, options = {}) {
  const tmpPath = makeTempPath(filePath)
  const json = JSON.stringify(state || {}, null, options.space || 0)
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(tmpPath, json, 'utf8')
  await fs.promises.rename(tmpPath, filePath)
}

function writeJsonAtomicSync(filePath, state, options = {}) {
  const tmpPath = makeTempPath(filePath)
  const json = JSON.stringify(state || {}, null, options.space || 0)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmpPath, json, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

function readJsonSync(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_) {
    return fallback
  }
}

module.exports = {
  readJsonSync,
  writeJsonAtomic,
  writeJsonAtomicSync
}
