const test = require('node:test')
const assert = require('node:assert/strict')

const { createPersistenceReadiness } = require('../src/main/persistence-readiness')

test('user state persistence is blocked until pairing state has loaded', () => {
  const readiness = createPersistenceReadiness()

  assert.equal(readiness.canPersistUserState(), false)
})

test('user state persistence remains enabled after pairing state has loaded', () => {
  const readiness = createPersistenceReadiness()

  readiness.markPairingStateLoaded()
  assert.equal(readiness.canPersistUserState(), true)

  readiness.markPairingStateLoaded()
  assert.equal(readiness.canPersistUserState(), true)
})

test('a guarded writer cannot replace persisted data before initialization', () => {
  const readiness = createPersistenceReadiness()
  const writes = []
  const persist = value => {
    if (!readiness.canPersistUserState()) return false
    writes.push(value)
    return true
  }

  assert.equal(persist({ totpSeeds: [] }), false)
  assert.deepEqual(writes, [])

  readiness.markPairingStateLoaded()
  assert.equal(persist({ totpSeeds: ['loaded'] }), true)
  assert.deepEqual(writes, [{ totpSeeds: ['loaded'] }])
})
