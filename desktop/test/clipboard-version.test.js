'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const clipboardVersion = require('../src/main/clipboard-version')

test('clipboard LWW rejects older cross-type payload after newer payload', () => {
  const current = clipboardVersion.rememberClipboardVersion({}, {
    ts: 2000,
    origin: 'desktop-a',
    hash: 'text-hash',
    kind: 'text'
  })

  assert.equal(clipboardVersion.isNewerClipboardVersion(current, {
    ts: 1500,
    origin: 'phone-b',
    hash: 'image-hash',
    kind: 'image'
  }), false)
})

test('clipboard LWW uses origin tie-breaker for same timestamp', () => {
  const current = { ts: 2000, origin: 'node-b', hash: 'old', kind: 'text' }

  assert.equal(clipboardVersion.isNewerClipboardVersion(current, {
    ts: 2000,
    origin: 'node-a',
    hash: 'older-origin',
    kind: 'image'
  }), false)
  assert.equal(clipboardVersion.isNewerClipboardVersion(current, {
    ts: 2000,
    origin: 'node-c',
    hash: 'newer-origin',
    kind: 'file'
  }), true)
})

test('bestClipboardVersion returns newest state across content types', () => {
  const best = clipboardVersion.bestClipboardVersion(
    { ts: 100, origin: 'a', hash: 'text', kind: 'text' },
    { ts: 300, origin: 'b', hash: 'image', kind: 'image' },
    { ts: 200, origin: 'c', hash: 'file', kind: 'file' }
  )

  assert.deepEqual(best, { ts: 300, origin: 'b', hash: 'image', kind: 'image' })
})

test('local clipboard timestamp remains monotonic when the wall clock is behind', () => {
  assert.equal(
    clipboardVersion.nextLocalClipboardTimestamp({ ts: 5000, origin: 'remote' }, 1000),
    5001
  )
  assert.equal(
    clipboardVersion.nextLocalClipboardTimestamp({ ts: 5000, origin: 'remote' }, 6000),
    6000
  )
})
