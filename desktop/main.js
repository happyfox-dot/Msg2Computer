const { app, BrowserWindow, Tray, Menu, Notification, clipboard, ipcMain, nativeImage, screen, safeStorage, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const dgram = require('dgram')
const http = require('http')
const { execFile } = require('child_process')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')
const storage = require('./src/storage')
const qrCodeParser = require('./src/qrCodeParser')
const messageRouter = require('./src/main/message-router')
const topologyManager = require('./src/main/topology-manager')
const totpStore = require('./src/main/totp-store')
const relayClient = require('./src/main/relay-client')
const busEnvelope = require('./src/main/bus-envelope')
const { createContentBus } = require('./src/main/content-bus')
const { createBusReliabilityStore } = require('./src/main/bus-reliability')
const { createRouteHealthTracker } = require('./src/main/route-manager')
const { registerDesktopIpc } = require('./src/main/desktop-ipc')
const updater = require('./src/main/updater')
const { createFileTransfer } = require('./src/main/file-transfer')
const clipboardVersion = require('./src/main/clipboard-version')
const trustedNode = require('./src/main/trusted-node')

let mainWindow = null
let bubbleWindow = null
let bubbleTimer = null

// The main process is split into ordered runtime parts to keep each source file manageable.
// The parts are concatenated and evaluated once so existing top-level state keeps its original scope.
const MAIN_RUNTIME_PARTS = [
  "main-part-001.js",
  "main-part-002.js",
  "main-part-003.js",
  "main-part-004.js",
  "main-part-005.js",
  "main-part-006.js"
]

const mainRuntimeCode = MAIN_RUNTIME_PARTS
  .map(part => fs.readFileSync(path.join(__dirname, 'src', 'main', 'main-runtime-parts', part), 'utf8'))
  .join('\n')

eval(mainRuntimeCode)
