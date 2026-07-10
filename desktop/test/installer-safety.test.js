const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const installerScript = fs.readFileSync(
  path.join(__dirname, '..', 'build', 'installer.nsh'),
  'utf8'
)

test('installer never launches an older executable to request update shutdown', () => {
  assert.doesNotMatch(installerScript, /^\s*Exec(?:Wait)?\b/im)
  assert.doesNotMatch(installerScript, /--quit-for-update/i)
})

test('installer still closes running processes before replacing files', () => {
  assert.match(installerScript, /!macro\s+customCheckAppRunning/i)
  assert.match(installerScript, /taskkill\s+\/im\s+"\$\{APP_EXECUTABLE_FILENAME\}"/i)
})
