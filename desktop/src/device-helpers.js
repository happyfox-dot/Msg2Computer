
// ========== 设备类型图标辅助函数 ==========

function getDeviceIcon(deviceType) {
  const icons = {
    'ANDROID_PHONE': '📱',
    'IOS_PHONE': '📱',
    'WINDOWS_DESKTOP': '💻',
    'MAC_DESKTOP': '💻',
    'LINUX_DESKTOP': '💻',
    'TABLET': '📲',
    'WEB_BROWSER': '🌐'
  }
  return icons[deviceType] || '📱'
}

function getDeviceTypeName(deviceType) {
  const names = {
    'ANDROID_PHONE': 'Android 手机',
    'IOS_PHONE': 'iPhone',
    'WINDOWS_DESKTOP': 'Windows PC',
    'MAC_DESKTOP': 'Mac',
    'LINUX_DESKTOP': 'Linux PC',
    'TABLET': '平板',
    'WEB_BROWSER': '浏览器'
  }
  return names[deviceType] || '未知设备'
}

// 导出到全局
window.getDeviceIcon = getDeviceIcon
window.getDeviceTypeName = getDeviceTypeName
