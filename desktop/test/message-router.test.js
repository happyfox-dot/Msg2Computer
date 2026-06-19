'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeMessageSettings,
  normalizePushContentPolicy,
  canPushContentToNode,
  canReceiveContentType,
  createRecentDeliveryTracker
} = require('../src/main/message-router')

test('message settings default to receiving SMS and notifications but not clipboard/file sync', () => {
  const settings = normalizeMessageSettings({})

  assert.equal(settings.receiveSmsCodes, true)
  assert.equal(settings.receiveAllSms, true)
  assert.equal(settings.receiveNotifications, true)
  assert.equal(settings.syncClipboardText, false)
  assert.equal(settings.syncClipboardImage, false)
  assert.equal(settings.syncClipboardFile, false)
  assert.equal(settings.receiveFileTransfer, false)
  assert.equal(settings.maxFileSizeMb, 50)
})

test('legacy clipboard switch enables text clipboard receive only', () => {
  const settings = normalizeMessageSettings({ syncClipboard: true })

  assert.equal(settings.syncClipboardText, true)
  assert.equal(settings.syncClipboardImage, false)
  assert.equal(settings.syncClipboardFile, false)
  assert.equal(canReceiveContentType('clipboard_text', settings), true)
  assert.equal(canReceiveContentType('clipboard_image', settings), false)
})

test('push policy keeps SMS/TOTP enabled and requires explicit file opt-in', () => {
  const policy = normalizePushContentPolicy({})

  assert.equal(policy.allowSmsCodes, true)
  assert.equal(policy.allowSmsMessages, true)
  assert.equal(policy.allowNotifications, true)
  assert.equal(policy.allowTotp, true)
  assert.equal(policy.allowClipboardText, true)
  assert.equal(policy.allowClipboardImage, true)
  assert.equal(policy.allowClipboardFile, false)
  assert.equal(policy.allowFileTransfer, false)
})

test('per-node policy can block individual content types', () => {
  const target = {
    contentPolicy: {
      allowSmsCodes: true,
      allowNotifications: false,
      allowClipboard: true,
      allowClipboardImage: false,
      allowFileTransfer: true
    }
  }

  assert.equal(canPushContentToNode(target, 'sms'), true)
  assert.equal(canPushContentToNode(target, 'app_notification'), false)
  assert.equal(canPushContentToNode(target, 'clipboard_text'), true)
  assert.equal(canPushContentToNode(target, 'clipboard_image'), false)
  assert.equal(canPushContentToNode(target, 'file_transfer'), true)
})

test('recent delivery tracker deduplicates and evicts old keys', () => {
  const tracker = createRecentDeliveryTracker(2)

  assert.equal(tracker.has('a'), false)
  tracker.remember('a')
  tracker.remember('b')
  assert.equal(tracker.has('a'), true)
  tracker.remember('c')
  assert.equal(tracker.has('a'), false)
  assert.equal(tracker.has('b'), true)
  assert.equal(tracker.has('c'), true)
})
