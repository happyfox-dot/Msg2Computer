const { readdirSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const testDir = join(__dirname, '..', 'test')
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(testDir, name))

if (testFiles.length === 0) {
  console.error('No desktop test files found')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
