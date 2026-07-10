'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  normalizeFileDropPaths,
  hasWindowsFileDropFormat,
  readClipboardFilePathsFromClipboard,
  powershellEncodedCommand,
  writeWindowsFileDropList,
  readWindowsFileDropList,
  readWindowsFileDropSnapshot
} = require('../src/main/windows-file-clipboard')

test('windows file clipboard normalizes existing files only', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-files-'))
  const filePath = path.join(tmpRoot, 'payload.py')
  const dirPath = path.join(tmpRoot, 'folder')
  fs.writeFileSync(filePath, 'print("ok")')
  fs.mkdirSync(dirPath)

  assert.deepEqual(normalizeFileDropPaths([filePath, dirPath, filePath, path.join(tmpRoot, 'missing.exe')]), [
    path.resolve(filePath)
  ])
})

test('windows file clipboard can include directories when explicitly enabled', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-dirs-'))
  const filePath = path.join(tmpRoot, 'payload.py')
  const dirPath = path.join(tmpRoot, 'folder')
  fs.writeFileSync(filePath, 'print("ok")')
  fs.mkdirSync(dirPath)

  assert.deepEqual(
    normalizeFileDropPaths([dirPath, filePath, dirPath], { allowDirectories: true }),
    [path.resolve(dirPath), path.resolve(filePath)]
  )
})

test('windows file clipboard invokes PowerShell STA with a JSON path list', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-write-'))
  const filePath = path.join(tmpRoot, 'payload.exe')
  fs.writeFileSync(filePath, 'binary')
  let called = false

  const ok = writeWindowsFileDropList([filePath], {
    tmpDir: tmpRoot,
    execFileSync: (exe, args, options) => {
      called = true
      assert.equal(exe, 'powershell.exe')
      assert.ok(args.includes('-STA'))
      assert.ok(args.includes('-EncodedCommand'))
      const payload = JSON.parse(fs.readFileSync(options.env.CODEBRIDGE_FILE_DROP_JSON, 'utf8'))
      assert.deepEqual(payload, [path.resolve(filePath)])
      return Buffer.alloc(0)
    }
  })

  assert.equal(ok, true)
  assert.equal(called, true)
})

test('windows file clipboard detects native file drop formats', () => {
  assert.equal(hasWindowsFileDropFormat(['text/plain', 'image/png']), false)
  assert.equal(hasWindowsFileDropFormat(['Shell IDList Array', 'Preferred DropEffect']), true)
  assert.equal(hasWindowsFileDropFormat(['FileNameW']), true)
})

test('windows file clipboard reads PowerShell file drop list output', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-read-'))
  const filePath = path.join(tmpRoot, 'payload.py')
  const missingPath = path.join(tmpRoot, 'missing.exe')
  fs.writeFileSync(filePath, 'print("ok")')
  let called = false

  const paths = readWindowsFileDropList({
    execFileSync: (exe, args) => {
      called = true
      assert.equal(exe, 'powershell.exe')
      assert.ok(args.includes('-STA'))
      assert.ok(args.includes('-EncodedCommand'))
      return Buffer.from(JSON.stringify([filePath, missingPath]), 'utf8')
    }
  })

  assert.equal(called, true)
  assert.deepEqual(paths, [path.resolve(filePath)])
})

test('async native clipboard snapshot returns sequence and paths without a synchronous wait', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-snapshot-'))
  const filePath = path.join(tmpRoot, 'payload.py')
  fs.writeFileSync(filePath, 'print("ok")')
  let callerReturned = false
  let callbackObservedReturn = false

  const pending = readWindowsFileDropSnapshot({
    force: true,
    execFile: (exe, args, options, callback) => {
      assert.equal(exe, 'powershell.exe')
      assert.ok(args.includes('-STA'))
      assert.equal(options.encoding, 'utf8')
      setImmediate(() => {
        callbackObservedReturn = callerReturned
        callback(null, JSON.stringify({ sequence: 42, paths: [filePath] }))
      })
      return { kill() {} }
    }
  })
  callerReturned = true

  assert.deepEqual(await pending, {
    sequence: 42,
    paths: [path.resolve(filePath)]
  })
  assert.equal(callbackObservedReturn, true)
})

test('clipboard file reader accepts legacy FileNameW buffer paths', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-filenamew-'))
  const filePath = path.join(tmpRoot, 'payload.exe')
  fs.writeFileSync(filePath, 'binary')
  const buffer = Buffer.from(`${filePath}\u0000\u0000`, 'utf16le')

  const paths = readClipboardFilePathsFromClipboard({
    availableFormats: () => ['FileNameW'],
    readBuffer: name => name === 'FileNameW' ? buffer : Buffer.alloc(0)
  }, {
    readNativeFileDropList: () => {
      throw new Error('native fallback should not be used')
    }
  })

  assert.deepEqual(paths, [path.resolve(filePath)])
})

test('clipboard file reader falls back to native FileDropList for Explorer clipboard', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-native-'))
  const filePath = path.join(tmpRoot, 'payload.py')
  fs.writeFileSync(filePath, 'print("ok")')
  let fallbackCalled = false

  const paths = readClipboardFilePathsFromClipboard({
    availableFormats: () => ['Shell IDList Array', 'Preferred DropEffect'],
    readBuffer: () => Buffer.alloc(0)
  }, {
    readNativeFileDropList: () => {
      fallbackCalled = true
      return [filePath]
    }
  })

  assert.equal(fallbackCalled, true)
  assert.deepEqual(paths, [path.resolve(filePath)])
})

test('clipboard file reader can return folder paths from native FileDropList', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebridge-clip-native-dir-'))
  const dirPath = path.join(tmpRoot, 'folder')
  fs.mkdirSync(dirPath)

  const paths = readClipboardFilePathsFromClipboard({
    availableFormats: () => ['Shell IDList Array', 'Preferred DropEffect'],
    readBuffer: () => Buffer.alloc(0)
  }, {
    allowDirectories: true,
    readNativeFileDropList: () => [dirPath]
  })

  assert.deepEqual(paths, [path.resolve(dirPath)])
})

test('clipboard file reader reports unreadable native file clipboard', () => {
  let reportedFormats = null
  const paths = readClipboardFilePathsFromClipboard({
    availableFormats: () => ['Shell IDList Array'],
    readBuffer: () => Buffer.alloc(0)
  }, {
    readNativeFileDropList: () => [],
    onUnreadableFileDrop: formats => {
      reportedFormats = formats
    }
  })

  assert.deepEqual(paths, [])
  assert.deepEqual(reportedFormats, ['Shell IDList Array'])
})

test('powershell encoded command uses UTF-16LE encoding', () => {
  const encoded = powershellEncodedCommand('Write-Output ok')
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), 'Write-Output ok')
})
