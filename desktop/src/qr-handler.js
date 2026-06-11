
// ========== 二维码上传功能 ==========

function setupQRCodeFeatures() {
  const btnUpload = document.getElementById('btn-upload-qr')
  const btnPaste = document.getElementById('btn-paste-qr')
  const chkAutoMonitor = document.getElementById('chk-auto-monitor')
  const dropZone = document.getElementById('qr-drop-zone')

  // 上传按钮
  if (btnUpload) {
    btnUpload.addEventListener('click', async () => {
      const result = await window.electronAPI.selectAndParseQr()
      if (result.canceled) return
      if (result.success && result.result) {
        handleQRResult(result.result)
      } else if (result.success && !result.result) {
        showNotification('未识别二维码', '这张图片里没有找到可识别的二维码')
      } else {
        showNotification('解析失败', result.error || '无法解析该图片')
      }
    })
  }

  // 粘贴按钮
  if (btnPaste) {
    btnPaste.addEventListener('click', async () => {
      const result = await window.electronAPI.parseQrClipboard()
      if (result.success && result.result) {
        handleQRResult(result.result)
      } else if (result.success && !result.result) {
        showNotification('未识别二维码', '剪贴板图片里没有找到可识别的二维码')
      } else {
        showNotification('解析失败', result.error || '剪贴板中没有图片')
      }
    })
  }

  // 自动监听开关
  if (chkAutoMonitor) {
    chkAutoMonitor.addEventListener('change', async (e) => {
      if (e.target.checked) {
        await window.electronAPI.startQrClipboardWatch()
        showNotification('剪贴板监听', '已启动自动监听')
      } else {
        await window.electronAPI.stopQrClipboardWatch()
        showNotification('剪贴板监听', '已停止监听')
      }
    })
  }

  // 拖拽区域
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.stopPropagation()
      dropZone.classList.add('drag-over')
    })

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault()
      e.stopPropagation()
      dropZone.classList.remove('drag-over')
    })

    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      dropZone.classList.remove('drag-over')

      const files = e.dataTransfer.files
      if (files.length > 0) {
        const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'))
        if (imageFiles.length === 0) {
          showNotification('文件类型错误', '请拖拽图片文件')
          return
        }

        const results = []
        let failed = 0
        for (const file of imageFiles) {
          const result = await window.electronAPI.parseQrFile(file.path)
          if (result.success && result.result) results.push(result.result)
          else failed += 1
        }

        const combined = combineQrResults(results)
        if (combined) {
          handleQRResult(combined)
          if (failed > 0) {
            showNotification('部分图片未识别', `${failed} 张图片没有解析到二维码`)
          }
        } else {
          showNotification('未识别二维码', '这些图片里没有找到可识别的二维码')
        }
      }
    })

    // 点击也可以上传
    dropZone.addEventListener('click', () => {
      btnUpload.click()
    })
  }

  // 监听自动检测到的二维码
  window.electronAPI.onQrCodeDetected((result) => {
    handleQRResult(result)
    showNotification('检测到二维码', result.label || result.type || '已自动解析')
  })
}

// 处理二维码解析结果
function handleQRResult(result) {
  if (!result) {
    showNotification('未识别二维码', '没有找到可识别的二维码')
    return
  }
  if (result.type === 'standard-totp') {
    // 标准 TOTP - 显示添加对话框
    showAddTotpDialog(result)
  } else if (result.type === 'google-migration') {
    // Google Authenticator 批量迁移 - 批量导入对话框
    showGoogleMigrationDialog(result)
  } else if (result.type === 'codebridge-pairing') {
    showDesktopPairingDialog(result)
  } else {
    showNotification('未知格式', '无法识别的二维码类型')
  }
}

function getTotpDedupKey(account) {
  return [
    account.secret || '',
    account.issuer || '',
    account.accountName || '',
    account.label || '',
    account.algorithm || 'SHA1',
    account.digits || 6,
    account.period || 30
  ].join('|').toLowerCase()
}

function combineQrResults(results) {
  const validResults = (results || []).filter(Boolean)
  if (validResults.length === 0) return null
  if (validResults.length === 1) return validResults[0]

  const accounts = []
  const seen = new Set()
  const migrationBatches = []

  validResults.forEach(result => {
    if (result.type === 'google-migration') {
      if (result.metadata) migrationBatches.push(result.metadata)
      ;(result.accounts || []).forEach(account => {
        const key = getTotpDedupKey(account)
        if (seen.has(key)) return
        seen.add(key)
        accounts.push(account)
      })
    } else if (result.type === 'standard-totp') {
      const key = getTotpDedupKey(result)
      if (seen.has(key)) return
      seen.add(key)
      accounts.push(result)
    }
  })

  if (accounts.length > 0) {
    const expectedBatchSize = Math.max(1, ...migrationBatches.map(item => item.batchSize || 1))
    const seenBatchIndexes = Array.from(new Set(migrationBatches.map(item => item.batchIndex || 0)))
      .sort((a, b) => a - b)
    return {
      type: 'google-migration',
      accounts,
      count: accounts.length,
      sourceQrCount: validResults.length,
      metadata: {
        batchSize: expectedBatchSize,
        seenBatchIndexes,
        seenBatchCount: seenBatchIndexes.length
      },
      incompleteBatch: expectedBatchSize > seenBatchIndexes.length
    }
  }

  return validResults[0]
}

// 显示添加 TOTP 对话框
function showAddTotpDialog(totpData) {
  // 移除已有对话框
  const existing = document.querySelector('.totp-import-dialog')
  if (existing) existing.remove()

  const dialog = document.createElement('div')
  dialog.className = 'totp-import-dialog'
  dialog.innerHTML = `
    <div class="dialog-content">
      <div class="dialog-title">添加 TOTP 验证码</div>
      <div class="dialog-body">
        <div class="totp-preview">
          <div class="totp-preview-label">${escapeHtml(totpData.label)}</div>
          <div class="totp-preview-issuer">
            发行者: ${escapeHtml(totpData.issuer || '未知')}
            <br>账号: ${escapeHtml(totpData.accountName || totpData.label)}
            <br>算法: ${totpData.algorithm} / ${totpData.digits} 位 / ${totpData.period} 秒
          </div>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn-dialog btn-secondary" data-action="cancel">取消</button>
        <button class="btn-dialog btn-primary" data-action="confirm">添加</button>
      </div>
    </div>
  `

  document.body.appendChild(dialog)
  dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeDialog)
  dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => confirmAddTotp(totpData))

  // 点击背景关闭
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      closeDialog()
    }
  })
}

// 显示 Google 迁移批量导入对话框（桌面端已可直接解码 protobuf）
function showGoogleMigrationDialog(migrationData) {
  const existing = document.querySelector('.totp-import-dialog')
  if (existing) existing.remove()

  const accounts = Array.isArray(migrationData.accounts) ? migrationData.accounts : []

  // 解码后没有可导入的 TOTP 账号
  if (accounts.length === 0) {
    showNotification('未发现可导入账号', '这张迁移二维码里没有解析到 TOTP 账号')
    return
  }

  const rows = accounts.map((acc, i) => `
    <label class="migration-row">
      <input type="checkbox" data-mig-index="${i}" checked>
      <span class="migration-info">
        <span class="migration-label">${escapeHtml(acc.label || acc.accountName || 'TOTP')}</span>
        <span class="migration-meta">${escapeHtml(acc.issuer || '未知发行者')} · ${acc.algorithm}/${acc.digits}位</span>
      </span>
    </label>
  `).join('')
  const batchInfo = migrationData.metadata || {}
  const batchSize = Number(batchInfo.batchSize || 1)
  const seenBatchCount = Number(batchInfo.seenBatchCount || (migrationData.metadata ? 1 : 0))
  const sourceQrCount = Number(migrationData.sourceQrCount || seenBatchCount || 1)
  const batchWarning = migrationData.incompleteBatch && batchSize > sourceQrCount
    ? `<p class="migration-warning">当前只解析到 ${sourceQrCount}/${batchSize} 个迁移二维码。Google Authenticator 超过 10 个账号时通常会拆成多张二维码，请把剩余二维码图片一起选择或拖入后再导入。</p>`
    : ''
  const sourceHint = sourceQrCount > 1
    ? `<p class="migration-source-hint">已合并 ${sourceQrCount} 个二维码。</p>`
    : ''

  const dialog = document.createElement('div')
  dialog.className = 'totp-import-dialog'
  dialog.innerHTML = `
    <div class="dialog-content">
      <div class="dialog-title">Google Authenticator 批量迁移</div>
      <div class="dialog-body">
        <p style="color: #d0d0d0; margin-bottom: 12px;">
          解析到 ${accounts.length} 个 TOTP 账号，勾选要导入的账号：
        </p>
        ${batchWarning}
        ${sourceHint}
        <div class="migration-list">${rows}</div>
      </div>
      <div class="dialog-actions">
        <button class="btn-dialog btn-secondary" data-action="cancel">取消</button>
        <button class="btn-dialog btn-primary" data-action="confirm">导入选中</button>
      </div>
    </div>
  `

  document.body.appendChild(dialog)
  dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeDialog)
  dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
    const selected = Array.from(dialog.querySelectorAll('input[data-mig-index]:checked'))
      .map(cb => accounts[Number(cb.dataset.migIndex)])
      .filter(Boolean)
    confirmImportMigration(selected)
  })

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      closeDialog()
    }
  })
}

// 批量导入选中的迁移账号
async function confirmImportMigration(accounts) {
  if (!accounts || accounts.length === 0) {
    showNotification('未选择账号', '请至少勾选一个账号再导入')
    return
  }

  let ok = 0
  let updated = 0
  let failed = 0
  for (const acc of accounts) {
    try {
      const result = await window.electronAPI.addTotpFromQr({
        label: acc.label,
        secret: acc.secret,
        issuer: acc.issuer,
        accountName: acc.accountName,
        algorithm: acc.algorithm,
        digits: acc.digits,
        period: acc.period || 30
      })
      if (result) {
        if (result.importAction === 'updated') updated += 1
        else ok += 1
      }
      else failed += 1
    } catch (error) {
      console.error('Failed to import migration account:', error)
      failed += 1
    }
  }

  closeDialog()
  showNotification('批量导入完成', `新增 ${ok} 个，更新 ${updated} 个${failed ? `，失败 ${failed} 个` : ''}`)
  if ((ok > 0 || updated > 0) && typeof refreshDesktopTotps === 'function') {
    await refreshDesktopTotps()
  }
}

// 确认添加 TOTP
async function confirmAddTotp(totpData) {
  try {
    const result = await window.electronAPI.addTotpFromQr(totpData)
    if (result) {
      showNotification(result.importAction === 'updated' ? '已更新' : '添加成功', totpData.label)
      closeDialog()
      // 刷新 TOTP 列表
      await refreshDesktopTotps()
    }
  } catch (error) {
    console.error('Failed to add TOTP:', error)
    showNotification('添加失败', error.message)
  }
}

function showDesktopPairingDialog(pairingData) {
  const existing = document.querySelector('.totp-import-dialog')
  if (existing) existing.remove()

  const dialog = document.createElement('div')
  dialog.className = 'totp-import-dialog'
  dialog.innerHTML = `
    <div class="dialog-content">
      <div class="dialog-title">配对局域网设备</div>
      <div class="dialog-body">
        <div class="totp-preview">
          <div class="totp-preview-label">${escapeHtml(pairingData.name || 'Desktop PC')}</div>
          <div class="totp-preview-issuer">
            类型: ${escapeHtml(pairingData.deviceType || 'WINDOWS_DESKTOP')}
            <br>地址: ${escapeHtml(pairingData.host)}:${escapeHtml(String(pairingData.port || ''))}
            <br>协议: ${escapeHtml(pairingData.protocol || 'codebridge-lan')}
          </div>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn-dialog btn-secondary" data-action="cancel">取消</button>
        <button class="btn-dialog btn-primary" data-action="confirm">配对</button>
      </div>
    </div>
  `

  document.body.appendChild(dialog)
  dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeDialog)
  dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => confirmPairDesktop(pairingData))
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeDialog()
  })
}

async function confirmPairDesktop(pairingData) {
  try {
    const result = await window.electronAPI.pairDesktopDevice(pairingData)
    if (result?.success) {
      closeDialog()
      showNotification('桌面配对已发起', result.peer?.name || pairingData.name)
      if (typeof refreshTopology === 'function') {
        await refreshTopology()
      }
    } else {
      showNotification('配对失败', result?.error || '无法配对该设备节点')
    }
  } catch (error) {
    console.error('Failed to pair desktop:', error)
    showNotification('配对失败', error.message || '无法配对该设备节点')
  }
}

// 关闭对话框
function closeDialog() {
  const dialog = document.querySelector('.totp-import-dialog')
  if (dialog) {
    dialog.remove()
  }
}

// 显示通知
function showNotification(title, message) {
  const existing = document.querySelector('.notification-toast')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.className = 'notification-toast'
  toast.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(title)}</div>
    <div style="font-size: 12px; color: #b0b0b0;">${escapeHtml(message)}</div>
  `

  document.body.appendChild(toast)

  setTimeout(() => {
    toast.style.opacity = '0'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

// 导出到全局
window.closeDialog = closeDialog
window.confirmAddTotp = confirmAddTotp
