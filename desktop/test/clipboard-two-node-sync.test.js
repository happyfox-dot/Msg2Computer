'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const busEnvelope = require('../src/main/bus-envelope')
const { createContentBus } = require('../src/main/content-bus')
const { createBusReliabilityStore } = require('../src/main/bus-reliability')
const clipboardVersion = require('../src/main/clipboard-version')
const messageRouter = require('../src/main/message-router')

const CODE_TYPES = Object.freeze({
  CLIPBOARD: 'clipboard',
  CLIPBOARD_TEXT: 'clipboard_text',
  CLIPBOARD_IMAGE: 'clipboard_image',
  CLIPBOARD_FILE: 'clipboard_file',
  FILE_TRANSFER: 'file_transfer'
})

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24)
}

function topicToContentType(topic) {
  if (topic === busEnvelope.TOPICS.CLIPBOARD_TEXT) return CODE_TYPES.CLIPBOARD_TEXT
  if (topic === busEnvelope.TOPICS.CLIPBOARD_IMAGE) return CODE_TYPES.CLIPBOARD_IMAGE
  if (topic === busEnvelope.TOPICS.CLIPBOARD_FILE) return CODE_TYPES.CLIPBOARD_FILE
  if (topic === busEnvelope.TOPICS.FILE_MANIFEST) return CODE_TYPES.FILE_TRANSFER
  return busEnvelope.legacyTypeForTopic(topic)
}

function clipboardPolicy() {
  return {
    allowClipboard: true,
    allowClipboardText: true,
    allowClipboardImage: true,
    allowClipboardFile: true,
    allowFileTransfer: true,
    maxFileSizeMb: 50
  }
}

function clipboardSettings() {
  return {
    syncClipboardText: true,
    syncClipboardImage: true,
    syncClipboardFile: true,
    receiveFileTransfer: true
  }
}

class SimulatedClipboardNetwork {
  constructor(networkId = 'test-network') {
    this.networkId = networkId
    this.nodes = new Map()
    this.deliveryLog = []
  }

  addNode(id, name = id) {
    const node = new SimulatedClipboardNode(this, id, name)
    for (const peer of this.nodes.values()) {
      node.addPeer(peer)
      peer.addPeer(node)
    }
    this.nodes.set(id, node)
    return node
  }

  async deliverDirect(fromId, target, envelope, route) {
    const targetNode = this.nodes.get(String(target.id || ''))
    this.deliveryLog.push({
      fromId,
      targetId: target.id,
      topic: envelope.topic,
      messageId: envelope.messageId,
      route: route?.transportType || ''
    })
    if (!targetNode) return false
    return targetNode.receiveEnvelope(envelope, { lastHopDeviceId: fromId, route })
  }
}

class SimulatedClipboardNode {
  constructor(network, id, name) {
    this.network = network
    this.identity = { id, name, type: 'WINDOWS_DESKTOP' }
    this.networkId = network.networkId
    this.peers = new Map()
    this.settings = clipboardSettings()
    this.clipboard = { kind: '', text: '', imageHash: '', files: [], version: clipboardVersion.normalizeClipboardVersion() }
    this.applied = []
    this.rejected = []
    this.bus = createContentBus({
      getIdentity: () => this.identity,
      getNetworkId: () => this.networkId,
      getTargetNode: targetId => this.peers.get(String(targetId || '')),
      getTopologyRoutes: () => [],
      hasActiveWs: () => false,
      canPush: (target, topic) => messageRouter.canPushContentToNode(target, topicToContentType(topic), CODE_TYPES),
      canReceive: (topic, envelope) => {
        if (String(envelope.networkId || '') !== this.networkId) return false
        if (Array.isArray(envelope.targetNodeIds) && envelope.targetNodeIds.length > 0) {
          if (!envelope.targetNodeIds.includes(this.identity.id)) return false
        }
        return messageRouter.canReceiveContentType(topicToContentType(topic), this.settings, CODE_TYPES)
      },
      sendDirect: (target, envelope, route) => this.network.deliverDirect(this.identity.id, target, envelope, route),
      onReceive: envelope => this.applyEnvelope(envelope),
      reliabilityStore: createBusReliabilityStore({
        retryBaseMs: 1,
        retryMaxMs: 5,
        maxAttempts: 2
      })
    })
  }

  addPeer(peer) {
    this.peers.set(peer.identity.id, {
      id: peer.identity.id,
      name: peer.identity.name,
      type: peer.identity.type,
      host: `192.0.2.${this.peers.size + 10}`,
      relayPort: 19529,
      pairingKey: `pair-${this.identity.id}-${peer.identity.id}`,
      contentPolicy: clipboardPolicy()
    })
  }

  receiveEnvelope(envelope, context = {}) {
    return this.bus.receiveEnvelope(envelope, context)
  }

  applyEnvelope(envelope) {
    const payload = envelope.payload || {}
    const incomingVersion = this.versionFromPayload(envelope)
    if (!clipboardVersion.isNewerClipboardVersion(this.clipboard.version, incomingVersion)) {
      this.rejected.push({ topic: envelope.topic, version: incomingVersion })
      return true
    }

    if (envelope.topic === busEnvelope.TOPICS.CLIPBOARD_TEXT) {
      this.clipboard = {
        kind: 'text',
        text: String(payload.text || payload.rawMessage || ''),
        imageHash: '',
        files: [],
        version: incomingVersion
      }
    } else if (envelope.topic === busEnvelope.TOPICS.CLIPBOARD_IMAGE) {
      this.clipboard = {
        kind: 'image',
        text: '',
        imageHash: String(payload.sha256 || payload.fileManifest?.sha256 || incomingVersion.hash || ''),
        files: [],
        version: incomingVersion
      }
    } else if (envelope.topic === busEnvelope.TOPICS.CLIPBOARD_FILE) {
      const files = payload.localFilePaths || payload.filePaths || payload.files || payload.fileManifest?.localPaths || []
      this.clipboard = {
        kind: 'file',
        text: '',
        imageHash: '',
        files: Array.isArray(files) ? files.map(String) : [],
        version: incomingVersion
      }
    } else {
      return false
    }

    this.applied.push({ topic: envelope.topic, version: incomingVersion, messageId: envelope.messageId })
    return true
  }

  versionFromPayload(envelope) {
    const payload = envelope.payload || {}
    const kind = envelope.topic === busEnvelope.TOPICS.CLIPBOARD_IMAGE
      ? 'image'
      : envelope.topic === busEnvelope.TOPICS.CLIPBOARD_FILE
        ? 'file'
        : 'text'
    return clipboardVersion.normalizeClipboardVersion({
      ts: Number(payload.clipVersion?.ts || payload.timestamp || envelope.timestamp),
      origin: String(payload.clipVersion?.origin || envelope.originNodeId || envelope.sourceNodeId || ''),
      hash: String(payload.clipVersion?.hash || payload.sha256 || payload.fileManifest?.sha256 || ''),
      kind: String(payload.clipVersion?.kind || kind)
    })
  }

  targetIds() {
    return Array.from(this.peers.keys())
  }

  rememberLocalClipboard(kind, ts, hash, extra = {}) {
    this.clipboard = {
      kind,
      text: extra.text || '',
      imageHash: extra.imageHash || '',
      files: extra.files || [],
      version: clipboardVersion.normalizeClipboardVersion({
        ts,
        origin: this.identity.id,
        hash,
        kind
      })
    }
  }

  async copyText(text, ts = Date.now(), targetNodeIds = this.targetIds()) {
    const hash = hashValue(text)
    this.rememberLocalClipboard('text', ts, hash, { text })
    return this.bus.publish(busEnvelope.TOPICS.CLIPBOARD_TEXT, {
      type: CODE_TYPES.CLIPBOARD_TEXT,
      text,
      rawMessage: text,
      timestamp: ts,
      sourceDeviceId: this.identity.id,
      originDeviceId: this.identity.id,
      targetDeviceIds: targetNodeIds,
      originMessageId: `clip-text-${this.identity.id}-${ts}-${hash}`,
      clipVersion: { ts, origin: this.identity.id, hash, kind: 'text' }
    }, { targetNodeIds })
  }

  async copyImage(imageHash, ts = Date.now(), targetNodeIds = this.targetIds()) {
    const hash = String(imageHash || hashValue(`image:${ts}`))
    this.rememberLocalClipboard('image', ts, hash, { imageHash: hash })
    return this.bus.publish(busEnvelope.TOPICS.CLIPBOARD_IMAGE, {
      type: CODE_TYPES.CLIPBOARD_IMAGE,
      timestamp: ts,
      sha256: hash,
      sourceDeviceId: this.identity.id,
      originDeviceId: this.identity.id,
      targetDeviceIds: targetNodeIds,
      originMessageId: `clip-image-${this.identity.id}-${ts}-${hash}`,
      clipVersion: { ts, origin: this.identity.id, hash, kind: 'image' }
    }, { targetNodeIds })
  }

  async copyFiles(filePaths, ts = Date.now(), targetNodeIds = this.targetIds()) {
    const normalized = filePaths.map(item => path.resolve(String(item)))
    const hash = hashValue(normalized.join('\n'))
    this.rememberLocalClipboard('file', ts, hash, { files: normalized })
    return this.bus.publish(busEnvelope.TOPICS.CLIPBOARD_FILE, {
      type: CODE_TYPES.CLIPBOARD_FILE,
      timestamp: ts,
      localFilePaths: normalized,
      fileManifest: {
        fileId: `clip-files-${this.identity.id}-${ts}-${hash}`,
        name: normalized.map(item => path.basename(item)).join(', '),
        count: normalized.length,
        sha256: hash
      },
      sourceDeviceId: this.identity.id,
      originDeviceId: this.identity.id,
      targetDeviceIds: targetNodeIds,
      originMessageId: `clip-files-${this.identity.id}-${ts}-${hash}`,
      clipVersion: { ts, origin: this.identity.id, hash, kind: 'file' }
    }, { targetNodeIds })
  }
}

test('two simulated nodes sync clipboard text once without echoing it back', async () => {
  const network = new SimulatedClipboardNetwork()
  const nodeA = network.addNode('node-a', 'Desktop A')
  const nodeB = network.addNode('node-b', 'Desktop B')

  const result = await nodeA.copyText('hello from A', 1000)

  assert.equal(result.delivered, 1)
  assert.equal(nodeB.clipboard.kind, 'text')
  assert.equal(nodeB.clipboard.text, 'hello from A')
  assert.equal(nodeB.clipboard.version.origin, 'node-a')
  assert.equal(nodeB.applied.length, 1)
  assert.equal(network.deliveryLog.length, 1)

  nodeB.receiveEnvelope(result.envelope, { lastHopDeviceId: 'node-a' })
  assert.equal(nodeB.applied.length, 1)
  assert.equal(network.deliveryLog.length, 1)
})

test('two simulated nodes use clipboard LWW ordering for concurrent text copies', async () => {
  const network = new SimulatedClipboardNetwork()
  const nodeA = network.addNode('node-a', 'Desktop A')
  const nodeB = network.addNode('node-b', 'Desktop B')

  await nodeA.copyText('A at 2000', 2000)
  await nodeB.copyText('B at 3000', 3000)

  assert.equal(nodeA.clipboard.text, 'B at 3000')
  assert.equal(nodeB.clipboard.text, 'B at 3000')
  assert.equal(nodeA.clipboard.version.origin, 'node-b')
  assert.equal(nodeB.clipboard.version.origin, 'node-b')
})

test('two simulated nodes resolve same timestamp clipboard writes by origin id', async () => {
  const network = new SimulatedClipboardNetwork()
  const nodeA = network.addNode('node-a', 'Desktop A')
  const nodeB = network.addNode('node-b', 'Desktop B')

  await nodeA.copyText('same timestamp from A', 5000)
  await nodeB.copyText('same timestamp from B', 5000)

  assert.equal(nodeA.clipboard.text, 'same timestamp from B')
  assert.equal(nodeB.clipboard.text, 'same timestamp from B')
  assert.equal(nodeA.clipboard.version.origin, 'node-b')
  assert.equal(nodeB.clipboard.version.origin, 'node-b')
})

test('two simulated nodes sync clipboard image as image content, not text', async () => {
  const network = new SimulatedClipboardNetwork()
  const nodeA = network.addNode('node-a', 'Desktop A')
  const nodeB = network.addNode('node-b', 'Desktop B')

  const imageHash = hashValue('fake-png-bytes')
  await nodeA.copyImage(imageHash, 6000)

  assert.equal(nodeB.clipboard.kind, 'image')
  assert.equal(nodeB.clipboard.imageHash, imageHash)
  assert.equal(nodeB.clipboard.text, '')
})

test('two simulated nodes sync copied Explorer files as file clipboard entries', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-two-node-clip-'))
  const exePath = path.join(tmpRoot, 'setup.exe')
  const pyPath = path.join(tmpRoot, 'tool.py')
  fs.writeFileSync(exePath, 'binary')
  fs.writeFileSync(pyPath, 'print("ok")')

  const network = new SimulatedClipboardNetwork()
  const nodeA = network.addNode('node-a', 'Desktop A')
  const nodeB = network.addNode('node-b', 'Desktop B')

  const result = await nodeA.copyFiles([exePath, pyPath], 7000)

  assert.equal(result.delivered, 1)
  assert.equal(nodeB.clipboard.kind, 'file')
  assert.deepEqual(nodeB.clipboard.files, [path.resolve(exePath), path.resolve(pyPath)])
  assert.equal(nodeB.clipboard.text, '')
  assert.equal(nodeB.applied.at(-1).topic, busEnvelope.TOPICS.CLIPBOARD_FILE)
})
