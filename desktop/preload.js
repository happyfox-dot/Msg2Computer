const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getPairingInfo: () => ipcRenderer.invoke('get-pairing-info'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  regeneratePairing: () => ipcRenderer.invoke('regenerate-pairing'),
  getAuthorizedPhones: () => ipcRenderer.invoke('get-authorized-phones'),
  getDesktopTotps: () => ipcRenderer.invoke('get-desktop-totps'),
  getTopology: () => ipcRenderer.invoke('get-topology'),
  getMessageSettings: () => ipcRenderer.invoke('get-message-settings'),
  setMessageSettings: (updates) => ipcRenderer.invoke('set-message-settings', updates),
  selectAndSendFile: (targetIds) => ipcRenderer.invoke('file-select-and-send', targetIds),
  getLanJoinSettings: () => ipcRenderer.invoke('get-lan-join-settings'),
  setLanJoinSettings: (updates) => ipcRenderer.invoke('set-lan-join-settings', updates),
  isWindowVisible: () => ipcRenderer.invoke('is-window-visible'),
  setPhoneEnabled: (phoneId, enabled) => ipcRenderer.invoke('set-phone-enabled', phoneId, enabled),
  setPhoneContentPolicy: (phoneId, updates) => ipcRenderer.invoke('set-phone-content-policy', phoneId, updates),
  revokePhone: (phoneId) => ipcRenderer.invoke('revoke-phone', phoneId),
  restorePhone: (phoneId) => ipcRenderer.invoke('restore-phone', phoneId),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data))
  },
  selectAndParseQr: () => ipcRenderer.invoke('qr-select-and-parse'),
  parseQrClipboard: () => ipcRenderer.invoke('qr-parse-clipboard'),
  parseQrFile: (filePath) => ipcRenderer.invoke('qr-parse-file', filePath),
  startQrClipboardWatch: () => ipcRenderer.invoke('qr-start-clipboard-watch'),
  stopQrClipboardWatch: () => ipcRenderer.invoke('qr-stop-clipboard-watch'),
  scanLanDevices: () => ipcRenderer.invoke('scan-lan-devices'),
  getLanDevices: () => ipcRenderer.invoke('get-lan-devices'),
  requestLanJoin: (device, template) => ipcRenderer.invoke('request-lan-join', device, template),
  respondLanJoin: (requestId, accepted, template) => ipcRenderer.invoke('respond-lan-join', requestId, accepted, template),
  addTotpFromQr: (totp) => ipcRenderer.invoke('storage-add-totp', totp),
  updateTotp: (id, updates) => ipcRenderer.invoke('storage-update-totp', id, updates),
  deleteTotp: (id) => ipcRenderer.invoke('storage-delete-totp', id),
  deleteDesktopTotp: (id) => ipcRenderer.invoke('storage-delete-totp', id),
  pairDesktopDevice: (pairingData) => ipcRenderer.invoke('pair-desktop-device', pairingData),

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
  },
  onDesktopTotpsChanged: (callback) => {
    ipcRenderer.on('desktop-totps-changed', (event, data) => callback(data))
  },
  onDesktopPeersChanged: (callback) => {
    ipcRenderer.on('desktop-peers-changed', (event, data) => callback(data))
  },
  onLanDevicesChanged: (callback) => {
    ipcRenderer.on('lan-devices-changed', (event, data) => callback(data))
  },
  onLanJoinRequest: (callback) => {
    ipcRenderer.on('lan-join-request', (event, data) => callback(data))
  },
  onQrCodeDetected: (callback) => {
    ipcRenderer.on('qr-code-detected', (event, data) => callback(data))
  },
  onFileTransferProgress: (callback) => {
    ipcRenderer.on('file-transfer-progress', (event, data) => callback(data))
  },
  onFileTransferComplete: (callback) => {
    ipcRenderer.on('file-transfer-complete', (event, data) => callback(data))
  }
})
