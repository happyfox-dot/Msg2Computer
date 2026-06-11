// 桌面端自动更新模块（基于 electron-updater）
//
// 更新源：GitHub Releases（happyfox-dot/Msg2Computer）。electron-builder 打包时
// 会在 dist/ 产出 latest.yml（记录最新版本号、安装包文件名与 sha512 校验值），
// 发版时必须把 latest.yml 与 exe、.blockmap 一起上传到 release，否则客户端拉不到更新。
//
// 流程：app ready 后静默检查 → 发现新版自动后台下载 → 下载完成弹原生对话框，
// 用户确认即 quitAndInstall()。renderer 的「检查更新」按钮走 checkForUpdate()。

const { dialog, app } = require('electron')

let autoUpdater = null
try {
  // electron-updater 是可选依赖：开发环境（electron .）下无 latest.yml，
  // require 失败或检查报错都不应阻断主进程启动。
  ;({ autoUpdater } = require('electron-updater'))
} catch (error) {
  console.warn('[updater] electron-updater 未安装，自动更新功能不可用:', error.message)
}

let mainWindowRef = null
let isManualCheck = false
let updateState = {
  status: 'idle', // idle | checking | available | downloading | downloaded | not-available | error
  version: null,
  percent: 0,
  notes: null,
  error: null
}

function sendStatus() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('update-status', { ...updateState })
  }
}

function setState(patch) {
  updateState = { ...updateState, ...patch }
  sendStatus()
}

// 初始化自动更新。在 app.whenReady() 内、创建主窗口后调用。
function initAutoUpdater(mainWindow) {
  mainWindowRef = mainWindow

  // 未打包（electron . 开发模式）时 electron-updater 会静默跳过且不发任何事件，
  // 注册监听/定时检查没有意义，直接当作不可用
  if (!autoUpdater || !app.isPackaged) return

  // autoInstallOnAppQuit 的「退出时装更新」路径同样要放行主窗口 close 拦截：
  // electron-updater 在为更新而退出前会发 before-quit-for-update
  app.on('before-quit-for-update', () => {
    app.isQuitting = true
  })

  // 自动下载，但不自动安装（安装时机交给用户确认）
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: null })
  })

  autoUpdater.on('update-available', info => {
    setState({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    })
  })

  autoUpdater.on('update-not-available', () => {
    setState({ status: 'not-available' })
    // 仅手动检查时才弹「已是最新版本」，避免开机自动检查打扰用户
    if (isManualCheck && mainWindowRef && !mainWindowRef.isDestroyed()) {
      dialog.showMessageBox(mainWindowRef, {
        type: 'info',
        title: '检查更新',
        message: '当前已是最新版本',
        buttons: ['好的']
      })
    }
    isManualCheck = false
  })

  autoUpdater.on('download-progress', progress => {
    setState({ status: 'downloading', percent: Math.round(progress.percent || 0) })
  })

  autoUpdater.on('update-downloaded', info => {
    setState({ status: 'downloaded', version: info.version })
    isManualCheck = false
    promptInstall(info)
  })

  autoUpdater.on('error', error => {
    console.warn('[updater] 更新出错:', error == null ? 'unknown' : (error.message || error))
    setState({ status: 'error', error: error == null ? 'unknown' : (error.message || String(error)) })
    if (isManualCheck && mainWindowRef && !mainWindowRef.isDestroyed()) {
      dialog.showMessageBox(mainWindowRef, {
        type: 'error',
        title: '检查更新失败',
        message: '无法检查更新，请稍后重试或前往 GitHub 手动下载。',
        detail: error == null ? '' : (error.message || String(error)),
        buttons: ['好的']
      })
    }
    isManualCheck = false
  })

  // 开机静默检查（延迟若干秒，避开启动高峰）
  setTimeout(() => {
    checkForUpdate(false)
  }, 8000)
}

function promptInstall(info) {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return
  dialog
    .showMessageBox(mainWindowRef, {
      type: 'info',
      title: '发现新版本',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '是否立即重启并安装？也可以稍后退出程序时自动安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1
    })
    .then(({ response }) => {
      if (response === 0) {
        quitAndInstall()
      }
    })
}

function quitAndInstall() {
  if (!autoUpdater) return
  // 关键：主窗口的 close 在非退出状态会 preventDefault 并隐藏窗口（托盘常驻设计），
  // 这会拦截 quitAndInstall 内部的 app.quit()，退出流程中止、安装器永远不会启动
  // ——用户点了「立即重启安装」却毫无反应。必须先标记退出状态放行 close 拦截。
  app.isQuitting = true
  // isSilent=true 静默安装（沿用原安装目录，无需用户再点一遍安装向导），
  // isForceRunAfter=true 安装完成后自动重启应用
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}

// 触发一次更新检查。manual=true 表示用户在设置页手动点击，会在「已是最新」「出错」时弹框。
function checkForUpdate(manual = false) {
  if (!autoUpdater || !app.isPackaged) {
    if (manual && mainWindowRef && !mainWindowRef.isDestroyed()) {
      dialog.showMessageBox(mainWindowRef, {
        type: 'info',
        title: '检查更新',
        message: '当前为开发模式，自动更新不可用。',
        buttons: ['好的']
      })
    }
    return Promise.resolve({ status: 'unavailable' })
  }
  isManualCheck = manual
  return autoUpdater.checkForUpdates().catch(error => {
    // 错误已由 'error' 事件处理，这里仅吞掉避免未捕获 rejection
    console.warn('[updater] checkForUpdates 调用失败:', error && error.message)
  })
}

function getUpdateState() {
  return { ...updateState }
}

module.exports = {
  initAutoUpdater,
  checkForUpdate,
  getUpdateState
}
