function normalizeMessageSettings(settings = {}) {
  const legacyClipboard = settings.syncClipboard === true
  return {
    receiveSmsCodes: settings.receiveSmsCodes !== false,
    receiveAllSms: settings.receiveAllSms !== false,
    receiveNotifications: settings.receiveNotifications !== false,
    syncClipboard: legacyClipboard,
    syncClipboardText: settings.syncClipboardText === true || legacyClipboard,
    syncClipboardImage: settings.syncClipboardImage === true,
    syncClipboardFile: settings.syncClipboardFile === true,
    receiveFileTransfer: settings.receiveFileTransfer === true,
    autoAcceptFiles: settings.autoAcceptFiles === true,
    maxFileSizeMb: Number.isFinite(Number(settings.maxFileSizeMb))
      ? Math.max(1, Math.min(512, Math.round(Number(settings.maxFileSizeMb))))
      : 50
  }
}

function normalizePushContentPolicy(policy = {}) {
  const legacyClipboard = policy.allowClipboard !== false
  const hasPolicyFlag = key => Object.prototype.hasOwnProperty.call(policy, key)
  const hasExplicitClipboardImagePolicy = hasPolicyFlag('allowClipboardImage') || hasPolicyFlag('allowImages')
  const maxFileSizeMb = Number.isFinite(Number(policy.maxFileSizeMb))
    ? Math.max(1, Math.min(512, Math.round(Number(policy.maxFileSizeMb))))
    : 50
  return {
    allowSmsCodes: policy.allowSmsCodes !== false,
    allowSmsMessages: policy.allowSmsMessages !== false,
    allowNotifications: policy.allowNotifications !== false,
    allowTotp: policy.allowTotp !== false,
    // v2 起默认允许：剪贴板是否同步由两端的全局总开关（默认关）决定，
    // per-device 位仅作为针对个别设备的显式关闭。旧默认 false 导致
    // 全局开关打开后剪贴板同步依然永远没有可推送目标（用户极难发现）。
    allowClipboard: legacyClipboard,
    allowClipboardText: policy.allowClipboardText !== false && legacyClipboard,
    allowClipboardImage: hasExplicitClipboardImagePolicy
      ? policy.allowClipboardImage !== false && policy.allowImages !== false && legacyClipboard
      : legacyClipboard,
    allowClipboardFile: policy.allowClipboardFile === true,
    allowFileTransfer: policy.allowFileTransfer === true,
    allowExternalEvents: policy.allowExternalEvents !== false,
    externalEventChannels: Array.isArray(policy.externalEventChannels)
      ? policy.externalEventChannels.map(channel => String(channel || '').trim()).filter(Boolean)
      : [],
    maxFileSizeMb,
    autoAcceptFiles: policy.autoAcceptFiles === true
  }
}

function canPushContentToNode(target, type, codeTypes = {}) {
  if (!target) return false
  const policy = normalizePushContentPolicy(target.contentPolicy || target)
  if (type === codeTypes.SMS || type === 'sms') return policy.allowSmsCodes
  if (type === codeTypes.SMS_MESSAGE || type === 'sms_message') return policy.allowSmsMessages
  if (type === codeTypes.APP_NOTIFICATION || type === 'app_notification') return policy.allowNotifications
  if (type === codeTypes.CLIPBOARD_TEXT || type === 'clipboard_text' || type === codeTypes.CLIPBOARD || type === 'clipboard') {
    return policy.allowClipboardText
  }
  if (type === codeTypes.CLIPBOARD_IMAGE || type === 'clipboard_image') return policy.allowClipboardImage
  if (type === codeTypes.CLIPBOARD_FILE || type === 'clipboard_file') return policy.allowClipboardFile
  if (type === codeTypes.FILE_TRANSFER || type === 'file_transfer') return policy.allowFileTransfer
  if (type === codeTypes.EXTERNAL_EVENT || type === 'external_event') return policy.allowExternalEvents
  if (type === 'totp' || type === 'totp_sync' || type === 'totp_seed' || type === 'totp_revoke') {
    return policy.allowTotp
  }
  return true
}

function canReceiveContentType(type, settings = {}, codeTypes = {}) {
  const normalized = normalizeMessageSettings(settings)
  const contentType = type || codeTypes.SMS || 'sms'
  if (contentType === codeTypes.SMS || contentType === 'sms') return normalized.receiveSmsCodes !== false
  if (contentType === codeTypes.SMS_MESSAGE || contentType === 'sms_message') return normalized.receiveAllSms !== false
  if (contentType === codeTypes.APP_NOTIFICATION || contentType === 'app_notification') {
    return normalized.receiveNotifications !== false
  }
  if (contentType === codeTypes.CLIPBOARD_TEXT || contentType === 'clipboard_text' || contentType === codeTypes.CLIPBOARD || contentType === 'clipboard') {
    return normalized.syncClipboardText === true
  }
  if (contentType === codeTypes.CLIPBOARD_IMAGE || contentType === 'clipboard_image') return normalized.syncClipboardImage === true
  if (contentType === codeTypes.CLIPBOARD_FILE || contentType === 'clipboard_file') return normalized.syncClipboardFile === true
  if (contentType === codeTypes.FILE_TRANSFER || contentType === 'file_transfer') return normalized.receiveFileTransfer === true
  return true
}

function createRecentDeliveryTracker(limit = 300) {
  const seen = new Set()
  const order = []

  return {
    has(key) {
      return !!key && seen.has(key)
    },
    remember(key) {
      if (!key || seen.has(key)) return
      seen.add(key)
      order.push(key)
      while (order.length > limit) {
        const oldKey = order.shift()
        if (oldKey) seen.delete(oldKey)
      }
    }
  }
}

module.exports = {
  normalizeMessageSettings,
  normalizePushContentPolicy,
  canPushContentToNode,
  canReceiveContentType,
  createRecentDeliveryTracker
}
