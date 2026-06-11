function normalizeMessageSettings(settings = {}) {
  return {
    receiveSmsCodes: settings.receiveSmsCodes !== false,
    receiveAllSms: settings.receiveAllSms !== false,
    receiveNotifications: settings.receiveNotifications !== false,
    syncClipboard: settings.syncClipboard === true
  }
}

function normalizePushContentPolicy(policy = {}) {
  return {
    allowSmsCodes: policy.allowSmsCodes !== false,
    allowSmsMessages: policy.allowSmsMessages !== false,
    allowNotifications: policy.allowNotifications !== false,
    allowTotp: policy.allowTotp !== false,
    allowClipboard: policy.allowClipboard === true
  }
}

function canPushContentToNode(target, type, codeTypes = {}) {
  if (!target) return false
  const policy = normalizePushContentPolicy(target.contentPolicy || target)
  if (type === codeTypes.SMS || type === 'sms') return policy.allowSmsCodes
  if (type === codeTypes.SMS_MESSAGE || type === 'sms_message') return policy.allowSmsMessages
  if (type === codeTypes.APP_NOTIFICATION || type === 'app_notification') return policy.allowNotifications
  if (type === codeTypes.CLIPBOARD || type === 'clipboard') return policy.allowClipboard
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
  if (contentType === codeTypes.CLIPBOARD || contentType === 'clipboard') return normalized.syncClipboard === true
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
