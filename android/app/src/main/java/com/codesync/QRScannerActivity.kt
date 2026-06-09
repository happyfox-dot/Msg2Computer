package com.codesync

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.codesync.service.WebSocketService
import com.codesync.util.DeviceStore
import com.codesync.util.GoogleAuthMigrationParser
import com.codesync.util.TotpEntry
import com.codesync.util.TotpStore
import com.codesync.util.TotpUtil
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

class QRScannerActivity : AppCompatActivity() {

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            handleScanResult(result.contents)
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prompt = if (intent.getBooleanExtra(EXTRA_SCAN_TOTP_ONLY, false)) {
            "扫描 TOTP 二维码\n（支持标准 TOTP 和 Google Authenticator 批量导出）"
        } else {
            "扫描电脑配对二维码或 TOTP 二维码"
        }

        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt(prompt)
            setBeepEnabled(true)
            setOrientationLocked(true)
        }

        scanLauncher.launch(options)
    }

    companion object {
        const val EXTRA_SCAN_TOTP_ONLY = "scan_totp_only"
    }

    private fun handleScanResult(content: String) {
        // Google Authenticator 批量迁移格式
        if (content.startsWith("otpauth-migration://", ignoreCase = true)) {
            handleGoogleMigration(content)
            return
        }

        // 标准 TOTP 格式
        if (content.startsWith("otpauth://", ignoreCase = true)) {
            handleTotpQr(content)
            return
        }

        // 配对二维码
        handlePairingQr(content)
    }

    private fun handlePairingQr(content: String) {
        try {
            val json = JSONObject(content)
            val host = json.optString("host", "")
            val port = json.optInt("port", 19527)
            val pairingKey = json.optString("pk", "")
            val deviceName = json.optString("name", "Desktop $host:$port")

            if (host.isEmpty() || pairingKey.isEmpty()) {
                Toast.makeText(this, "无效的二维码", Toast.LENGTH_SHORT).show()
                return
            }

            val device = DeviceStore.upsertDevice(
                context = this,
                host = host,
                port = port,
                pairingKey = pairingKey,
                name = deviceName
            )

            val serviceIntent = Intent(this, WebSocketService::class.java).apply {
                action = WebSocketService.ACTION_CONNECT
                putExtra(WebSocketService.EXTRA_DEVICE_ID, device.id)
            }

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }

            Toast.makeText(this, "正在连接 ${host}:${port}...", Toast.LENGTH_SHORT).show()

        } catch (e: Exception) {
            Toast.makeText(this, "二维码解析失败: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleTotpQr(content: String) {
        try {
            val uri = Uri.parse(content)
            if (!uri.scheme.equals("otpauth", ignoreCase = true) ||
                !uri.host.equals("totp", ignoreCase = true)
            ) {
                Toast.makeText(this, "暂只支持 TOTP 二维码", Toast.LENGTH_SHORT).show()
                return
            }

            val secret = uri.getQueryParameter("secret")
                ?.uppercase()
                ?.replace(" ", "")
                ?.replace("-", "")
                ?.trim()
                ?: ""
            if (!TotpUtil.validateSecret(secret)) {
                Toast.makeText(this, "无效的 TOTP 密钥", Toast.LENGTH_SHORT).show()
                return
            }

            val rawLabel = uri.pathSegments.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "TOTP"
            val issuerFromQuery = uri.getQueryParameter("issuer")?.trim().orEmpty()
            val colonIndex = rawLabel.indexOf(':')
            val issuer = issuerFromQuery.ifBlank {
                if (colonIndex > 0) rawLabel.substring(0, colonIndex).trim() else ""
            }
            val accountName = if (colonIndex >= 0 && colonIndex < rawLabel.lastIndex) {
                rawLabel.substring(colonIndex + 1).trim()
            } else {
                rawLabel
            }.ifBlank { "TOTP" }
            val label = listOf(issuer, accountName).filter { it.isNotBlank() }.joinToString(": ")
                .ifBlank { accountName }
            val algorithm = normalizeTotpAlgorithm(uri.getQueryParameter("algorithm"))
            val digits = uri.getQueryParameter("digits")?.toIntOrNull()?.takeIf { it in 6..8 } ?: 6
            val period = uri.getQueryParameter("period")?.toIntOrNull()?.takeIf { it in 15..120 } ?: 30

            saveTotpLocally(
                label = label,
                secret = secret,
                issuer = issuer,
                accountName = accountName,
                algorithm = algorithm,
                digits = digits,
                period = period
            )
            sendTotpSeedToDesktop(
                label = label,
                secret = secret,
                issuer = issuer,
                accountName = accountName,
                algorithm = algorithm,
                digits = digits,
                period = period
            )

            Toast.makeText(this, "已保存并同步 TOTP：$label", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "TOTP 二维码解析失败: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleGoogleMigration(content: String) {
        try {
            val accounts = GoogleAuthMigrationParser.parse(content) ?: emptyList()

            if (accounts.isEmpty()) {
                Toast.makeText(this, "未能解析出任何账号", Toast.LENGTH_SHORT).show()
                return
            }

            // 批量导入所有账号
            var successCount = 0
            var failCount = 0

            accounts.forEach { account ->
                try {
                    if (TotpUtil.validateSecret(account.secret)) {
                        saveTotpLocally(
                            label = account.getDisplayLabel(),
                            secret = account.secret,
                            issuer = account.issuer,
                            accountName = account.getAccountName(),
                            algorithm = account.getAlgorithmString(),
                            digits = account.getDigitsInt(),
                            period = 30
                        )
                        sendTotpSeedToDesktop(
                            label = account.getDisplayLabel(),
                            secret = account.secret,
                            issuer = account.issuer,
                            accountName = account.getAccountName(),
                            algorithm = account.getAlgorithmString(),
                            digits = account.getDigitsInt(),
                            period = 30
                        )
                        successCount++
                    } else {
                        failCount++
                    }
                } catch (e: Exception) {
                    failCount++
                }
            }

            val message = if (failCount == 0) {
                "成功导入 $successCount 个 TOTP 账号"
            } else {
                "成功导入 $successCount 个，失败 $failCount 个"
            }
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()

        } catch (e: Exception) {
            Toast.makeText(this, "Google Authenticator 迁移数据解析失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun normalizeTotpAlgorithm(value: String?): String {
        return when (value?.uppercase()?.replace("-", "")) {
            "SHA256" -> "SHA256"
            "SHA512" -> "SHA512"
            else -> "SHA1"
        }
    }

    private fun saveTotpLocally(
        label: String,
        secret: String,
        issuer: String = "",
        accountName: String = "",
        algorithm: String = "SHA1",
        digits: Int = 6,
        period: Int = 30
    ) {
        val entry = TotpEntry(
            label = label,
            secret = secret,
            issuer = issuer,
            accountName = accountName,
            algorithm = algorithm,
            digits = digits,
            period = period
        )
        TotpStore.add(this, entry)
    }

    private fun sendTotpSeedToDesktop(
        label: String,
        secret: String,
        issuer: String,
        accountName: String,
        algorithm: String,
        digits: Int,
        period: Int
    ) {
        if (DeviceStore.getEnabledDevices(this).isEmpty()) {
            return
        }

        val serviceIntent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_TOTP_SEED
            putExtra(WebSocketService.EXTRA_TOTP_LABEL, label)
            putExtra(WebSocketService.EXTRA_TOTP_SECRET, secret)
            putExtra(WebSocketService.EXTRA_TOTP_ISSUER, issuer)
            putExtra(WebSocketService.EXTRA_TOTP_ACCOUNT, accountName)
            putExtra(WebSocketService.EXTRA_TOTP_ALGORITHM, algorithm)
            putExtra(WebSocketService.EXTRA_TOTP_DIGITS, digits)
            putExtra(WebSocketService.EXTRA_TOTP_PERIOD, period)
        }

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
    }
}
