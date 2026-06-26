'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const rootDir = join(__dirname, '..')

function assertScriptParses(relativePath) {
  const filePath = join(rootDir, relativePath)
  const source = readFileSync(filePath, 'utf8')
  assert.doesNotThrow(() => {
    new vm.Script(source, { filename: relativePath })
  }, `${relativePath} should parse as an independent browser script`)
}

test('renderer split scripts parse independently', () => {
  assertScriptParses('src/renderer-parts/renderer-part-001.js')
  assertScriptParses('src/renderer-parts/renderer-part-002.js')
  assertScriptParses('src/qr-handler.js')
})

test('renderer html keeps valid title and closing tags', () => {
  const html = readFileSync(join(rootDir, 'src/index.html'), 'utf8')

  assert.match(html, /<title>验证码同步<\/title>/)
  assert.doesNotMatch(html, /\?\/(?:title|button|span|div|h[1-6]|p)>/)
  assert.match(html, /renderer-parts\/renderer-part-001\.js/)
  assert.match(html, /renderer-parts\/renderer-part-002\.js/)
})
