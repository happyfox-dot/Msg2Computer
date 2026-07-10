'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { incomingClipboardFileKey } = require('../src/main/clipboard-file-session')

test('shared clipboard batch id wins over per-file clipVersion timestamps', () => {
  const first = incomingClipboardFileKey({
    originDeviceId: 'phone-a',
    batchId: 'batch-42',
    batchCount: 2,
    clipVersion: { ts: 100, origin: 'phone-a', hash: 'first' }
  }, {}, { fileId: 'file-1' })
  const second = incomingClipboardFileKey({
    originDeviceId: 'phone-a',
    batchId: 'batch-42',
    batchCount: 2,
    clipVersion: { ts: 101, origin: 'phone-a', hash: 'second' }
  }, {}, { fileId: 'file-2' })

  assert.equal(first, second)
  assert.equal(first, 'batch|phone-a|batch-42')
})

test('clipboard batches from different origins cannot collide', () => {
  const a = incomingClipboardFileKey({ originDeviceId: 'a', batchId: 'same' }, {}, {})
  const b = incomingClipboardFileKey({ originDeviceId: 'b', batchId: 'same' }, {}, {})
  assert.notEqual(a, b)
})
