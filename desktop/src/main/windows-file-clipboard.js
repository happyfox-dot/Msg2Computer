'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, execFileSync } = require('child_process')

function normalizeFileDropPaths(filePaths, options = {}) {
  const allowDirectories = options.allowDirectories === true
  const seen = new Set()
  const result = []
  for (const item of Array.isArray(filePaths) ? filePaths : []) {
    const normalized = path.resolve(String(item || ''))
    if (!normalized || seen.has(normalized)) continue
    try {
      const stat = fs.statSync(normalized)
      if (!stat.isFile() && !(allowDirectories && stat.isDirectory())) continue
    } catch (_) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function powershellEncodedCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64')
}

function hasWindowsFileDropFormat(formats) {
  return (Array.isArray(formats) ? formats : []).some(format => {
    const value = String(format || '').toLowerCase()
    return value === 'filenamew' ||
      value === 'filename' ||
      value.includes('filedrop') ||
      value.includes('file drop') ||
      value.includes('hdrop') ||
      value.includes('dropfiles') ||
      value.includes('shell idlist') ||
      value.includes('file group descriptor') ||
      value.includes('preferred dropeffect')
  })
}

function decodeUtf16ClipboardPaths(buffer) {
  if (!buffer || buffer.length < 4) return []
  return buffer.toString('utf16le')
    .split('\u0000')
    .map(item => item.trim())
    .filter(Boolean)
}

function decodeAnsiClipboardPaths(buffer) {
  if (!buffer || buffer.length < 2) return []
  return buffer.toString('utf8')
    .split('\u0000')
    .map(item => item.trim())
    .filter(Boolean)
}

function readClipboardFilePathsFromClipboard(clipboard, options = {}) {
  if (!clipboard || process.platform !== 'win32') return []
  const normalizeOptions = { allowDirectories: options.allowDirectories === true }
  const onUnreadableFileDrop = typeof options.onUnreadableFileDrop === 'function'
    ? options.onUnreadableFileDrop
    : null
  const readNativeFileDropList = typeof options.readNativeFileDropList === 'function'
    ? options.readNativeFileDropList
    : () => readWindowsFileDropList({
        timeoutMs: Number(options.timeoutMs || 2500),
        allowDirectories: options.allowDirectories === true
      })
  const availableFormats = (() => {
    try {
      return typeof clipboard.availableFormats === 'function' ? clipboard.availableFormats() : []
    } catch (_) {
      return []
    }
  })()

  try {
    const paths = normalizeFileDropPaths(decodeUtf16ClipboardPaths(clipboard.readBuffer('FileNameW')), normalizeOptions)
    if (paths.length > 0) return paths
  } catch (_) {}

  try {
    const paths = normalizeFileDropPaths(decodeAnsiClipboardPaths(clipboard.readBuffer('FileName')), normalizeOptions)
    if (paths.length > 0) return paths
  } catch (_) {}

  if (hasWindowsFileDropFormat(availableFormats)) {
    const paths = normalizeFileDropPaths(readNativeFileDropList(), normalizeOptions)
    if (paths.length > 0) return paths
    if (onUnreadableFileDrop) onUnreadableFileDrop(availableFormats)
  }
  return []
}

function writeWindowsFileDropList(filePaths, options = {}) {
  const paths = normalizeFileDropPaths(filePaths, { allowDirectories: options.allowDirectories === true })
  if (paths.length === 0) return false
  const tmpDir = String(options.tmpDir || os.tmpdir())
  const jsonPath = path.join(tmpDir, `codebridge-file-drop-${process.pid}-${Date.now()}.json`)
  const execFileSyncImpl = options.execFileSync || execFileSync
  const fsImpl = options.fs || fs
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$raw = [System.IO.File]::ReadAllText($env:CODEBRIDGE_FILE_DROP_JSON, [System.Text.Encoding]::UTF8)
$paths = $raw | ConvertFrom-Json
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) {
  $s = [string]$p
  if ([System.IO.File]::Exists($s) -or [System.IO.Directory]::Exists($s)) { [void]$list.Add($s) }
}
if ($list.Count -le 0) { exit 2 }
[System.Windows.Forms.Clipboard]::Clear()
[System.Windows.Forms.Clipboard]::SetFileDropList($list)
`
  try {
    fsImpl.writeFileSync(jsonPath, JSON.stringify(paths), 'utf8')
    execFileSyncImpl('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      powershellEncodedCommand(script)
    ], {
      env: {
        ...process.env,
        CODEBRIDGE_FILE_DROP_JSON: jsonPath
      },
      windowsHide: true,
      timeout: Number(options.timeoutMs || 5000),
      stdio: 'pipe'
    })
    return true
  } catch (_) {
    return false
  } finally {
    try { fsImpl.unlinkSync(jsonPath) } catch (_) {}
  }
}

function readWindowsFileDropList(options = {}) {
  if (process.platform !== 'win32') return []
  const execFileSyncImpl = options.execFileSync || execFileSync
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
$paths = @()
foreach ($p in $list) {
  $s = [string]$p
  if ([System.IO.File]::Exists($s) -or [System.IO.Directory]::Exists($s)) { $paths += $s }
}
$paths | ConvertTo-Json -Compress
`
  try {
    const output = execFileSyncImpl('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      powershellEncodedCommand(script)
    ], {
      windowsHide: true,
      timeout: Number(options.timeoutMs || 2500),
      stdio: 'pipe'
    }).toString('utf8').trim()
    if (!output) return []
    const parsed = JSON.parse(output)
    return normalizeFileDropPaths(Array.isArray(parsed) ? parsed : [parsed], {
      allowDirectories: options.allowDirectories === true
    })
  } catch (_) {
    return []
  }
}

/**
 * Reads the native Windows file-drop clipboard without blocking Electron's
 * main thread. The sequence number and paths are captured in the same STA
 * process, so callers can ignore unchanged snapshots without guessing from
 * filenames or repeatedly treating cached paths as a new clipboard value.
 */
function readWindowsFileDropSnapshot(options = {}) {
  if (process.platform !== 'win32' && options.force !== true) {
    return Promise.resolve({ sequence: 0, paths: [] })
  }
  const execFileImpl = options.execFile || execFile
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodeBridgeClipboardNative {
  [DllImport("user32.dll")]
  public static extern uint GetClipboardSequenceNumber();
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
$paths = @()
foreach ($p in $list) {
  $s = [string]$p
  if ([System.IO.File]::Exists($s) -or [System.IO.Directory]::Exists($s)) { $paths += $s }
}
[PSCustomObject]@{
  sequence = [UInt64][CodeBridgeClipboardNative]::GetClipboardSequenceNumber()
  paths = @($paths)
} | ConvertTo-Json -Compress -Depth 3
`

  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      powershellEncodedCommand(script)
    ]
    const execOptions = {
      windowsHide: true,
      timeout: Number(options.timeoutMs || 2500),
      maxBuffer: 256 * 1024,
      encoding: 'utf8'
    }
    try {
      execFileImpl('powershell.exe', args, execOptions, (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        try {
          const output = String(stdout || '').replace(/^\uFEFF/, '').trim()
          const parsed = output ? JSON.parse(output) : {}
          const rawPaths = Array.isArray(parsed.paths)
            ? parsed.paths
            : (parsed.paths ? [parsed.paths] : [])
          resolve({
            sequence: Math.max(0, Number(parsed.sequence || 0) || 0),
            paths: normalizeFileDropPaths(rawPaths, {
              allowDirectories: options.allowDirectories === true
            })
          })
        } catch (error) {
          reject(error)
        }
      })
    } catch (error) {
      reject(error)
    }
  })
}

module.exports = {
  normalizeFileDropPaths,
  hasWindowsFileDropFormat,
  readClipboardFilePathsFromClipboard,
  powershellEncodedCommand,
  writeWindowsFileDropList,
  readWindowsFileDropList,
  readWindowsFileDropSnapshot
}
