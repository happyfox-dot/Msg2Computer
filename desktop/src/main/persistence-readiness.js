'use strict'

function createPersistenceReadiness() {
  let pairingStateLoaded = false

  return Object.freeze({
    markPairingStateLoaded() {
      pairingStateLoaded = true
    },

    canPersistUserState() {
      return pairingStateLoaded
    }
  })
}

module.exports = {
  createPersistenceReadiness
}
