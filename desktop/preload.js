const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getPairingInfo: () => ipcRenderer.invoke('get-pairing-info'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  regeneratePairing: () => ipcRenderer.invoke('regenerate-pairing'),
  getAuthorizedPhones: () => ipcRenderer.invoke('get-authorized-phones'),
  setPhoneEnabled: (phoneId, enabled) => ipcRenderer.invoke('set-phone-enabled', phoneId, enabled),
  revokePhone: (phoneId) => ipcRenderer.invoke('revoke-phone', phoneId),
  restorePhone: (phoneId) => ipcRenderer.invoke('restore-phone', phoneId),

  onNewCode: (callback) => {
    ipcRenderer.on('new-code', (event, data) => callback(data))
  },
  onPairingQR: (callback) => {
    ipcRenderer.on('pairing-qr', (event, data) => callback(data))
  },
  onCopyFeedback: (callback) => {
    ipcRenderer.on('copy-feedback', () => callback())
  },
  onDeviceDisconnected: (callback) => {
    ipcRenderer.on('device-disconnected', () => callback())
  },
  onPhonesChanged: (callback) => {
    ipcRenderer.on('phones-changed', (event, data) => callback(data))
  },
  onWindowVisibility: (callback) => {
    ipcRenderer.on('window-visibility', (event, visible) => callback(visible))
  }
})
