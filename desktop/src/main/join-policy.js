'use strict'

const { normalizePushContentPolicy } = require('./message-router')

function getNodeCapabilities() {
  return {
    topology: true,
    relay: true,
    sms: true,
    totp: true,
    clipboardText: true,
    clipboardImage: true,
    clipboardFile: true,
    fileTransfer: true,
    softBus: true,
    p2pDirect: true,
    externalEvents: true,
    joinRequest: true
  }
}

function contentPolicyForJoinTemplate(template = 'basic') {
  if (template === 'topology_only') {
    return normalizePushContentPolicy({
      allowSmsCodes: false,
      allowSmsMessages: false,
      allowNotifications: false,
      allowTotp: false,
      allowClipboard: false,
      allowClipboardText: false,
      allowClipboardImage: false,
      allowClipboardFile: false,
      allowFileTransfer: false,
      allowExternalEvents: false,
      maxFileSizeMb: 50,
      autoAcceptFiles: false
    })
  }

  if (template === 'full') {
    return normalizePushContentPolicy({
      allowSmsCodes: true,
      allowSmsMessages: true,
      allowNotifications: true,
      allowTotp: true,
      allowClipboard: true,
      allowClipboardText: true,
      allowClipboardImage: true,
      allowClipboardFile: true,
      allowFileTransfer: true,
      allowExternalEvents: true,
      maxFileSizeMb: 50,
      autoAcceptFiles: false
    })
  }

  return normalizePushContentPolicy({
    allowSmsCodes: true,
    allowSmsMessages: false,
    allowNotifications: true,
    allowTotp: true,
    allowClipboard: true,
    allowClipboardText: true,
    allowClipboardImage: true,
    allowClipboardFile: false,
    allowFileTransfer: false,
    allowExternalEvents: true,
    maxFileSizeMb: 50,
    autoAcceptFiles: false
  })
}

module.exports = {
  getNodeCapabilities,
  contentPolicyForJoinTemplate
}
