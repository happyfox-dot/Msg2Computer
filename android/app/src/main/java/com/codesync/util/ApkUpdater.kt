package com.codesync.util

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 应用内更新（侧载场景，无应用商店）。
 *
 * 更新源：GitHub Releases latest 接口。流程：
 *   1. [checkLatest] 拉取 releases/latest，解析出版本号、更新说明、APK 直链；
 *   2. 与本机 versionCode 比对，决定是否有新版本；
 *   3. [downloadAndInstall] 用系统 DownloadManager 下载 APK 到外部缓存目录，
 *      下载完成后经 FileProvider 拉起系统安装器。
 *
 * APK 资产命名约定：Msg2Computer-Android-<ver>.apk（见发版流程）。
 */
object ApkUpdater {

    private const val LATEST_API =
        "https://api.github.com/repos/happyfox-dot/Msg2Computer/releases/latest"
    private const val RELEASE_PAGE =
        "https://github.com/happyfox-dot/Msg2Computer/releases/latest"

    private val client by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    data class UpdateInfo(
        val versionName: String,   // 解析自 tag_name，去掉前缀 v
        val versionCode: Long,     // 从 versionName 推算（major*10000+minor*100+patch）
        val notes: String,
        val apkUrl: String?,       // 匹配到的 .apk 资产直链，可能为空
        val pageUrl: String        // release 页面，兜底用浏览器打开
    )

    /** 拉取并解析 GitHub 最新 release。网络/解析失败返回 null（调用方据此提示）。*/
    suspend fun checkLatest(): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url(LATEST_API)
                .header("Accept", "application/vnd.github+json")
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                val body = response.body?.string() ?: return@withContext null
                val json = JSONObject(body)
                val tag = json.optString("tag_name").trim()
                if (tag.isEmpty()) return@withContext null
                val versionName = tag.removePrefix("v").removePrefix("V")
                val notes = json.optString("body").trim()

                // 在 assets 里找 .apk（约定名 Msg2Computer-Android-<ver>.apk，
                // 但只要后缀是 .apk 就接受，避免改名后匹配不到）
                var apkUrl: String? = null
                val assets = json.optJSONArray("assets")
                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val asset = assets.optJSONObject(i) ?: continue
                        val name = asset.optString("name")
                        if (name.endsWith(".apk", ignoreCase = true)) {
                            apkUrl = asset.optString("browser_download_url")
                            break
                        }
                    }
                }

                UpdateInfo(
                    versionName = versionName,
                    versionCode = parseVersionCode(versionName),
                    notes = notes,
                    apkUrl = apkUrl,
                    pageUrl = json.optString("html_url").ifEmpty { RELEASE_PAGE }
                )
            }
        } catch (_: Exception) {
            null
        }
    }

    /** 把 1.0.27 形式的版本号折算成可比较的整数：major*10000 + minor*100 + patch。*/
    private fun parseVersionCode(versionName: String): Long {
        return try {
            val parts = versionName.split(".")
            val major = parts.getOrNull(0)?.toLongOrNull() ?: 0
            val minor = parts.getOrNull(1)?.toLongOrNull() ?: 0
            val patch = parts.getOrNull(2)?.toLongOrNull() ?: 0
            major * 10000 + minor * 100 + patch
        } catch (_: Exception) {
            0
        }
    }

    /** 本机当前 versionCode，与远端折算值用同一套规则比较。*/
    fun currentVersionCode(context: Context): Long {
        return try {
            val pm = context.packageManager
            val info = pm.getPackageInfo(context.packageName, 0)
            parseVersionCode(info.versionName ?: "0")
        } catch (_: Exception) {
            0
        }
    }

    fun currentVersionName(context: Context): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    /** 远端是否比本机新。*/
    fun hasUpdate(context: Context, info: UpdateInfo): Boolean {
        return info.versionCode > currentVersionCode(context)
    }

    /**
     * 用系统 DownloadManager 下载 APK 到 app 专属外部缓存目录。下载完成由调用方
     * 注册的 ACTION_DOWNLOAD_COMPLETE 广播触发安装。返回 downloadId，-1 表示发起失败。
     */
    fun downloadApk(
        context: Context,
        apkUrl: String,
        versionName: String,
        title: String
    ): Long {
        return try {
            val fileName = "Msg2Computer-Android-$versionName.apk"
            // 清掉同名旧文件，避免 DownloadManager 自动追加 (1) 后缀导致路径对不上
            val dest = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName)
            if (dest.exists()) dest.delete()

            val request = DownloadManager.Request(Uri.parse(apkUrl))
                .setTitle(title)
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(
                    context, Environment.DIRECTORY_DOWNLOADS, fileName
                )
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.enqueue(request)
        } catch (_: Exception) {
            -1
        }
    }

    /** 取下载完成的 APK 文件路径（按约定文件名定位）。*/
    fun apkFile(context: Context, versionName: String): File {
        val fileName = "Msg2Computer-Android-$versionName.apk"
        return File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName)
    }

    /** 经 FileProvider 拉起系统安装器安装指定 APK。*/
    fun installApk(context: Context, apk: File): Boolean {
        return try {
            if (!apk.exists()) return false
            val uri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apk
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** 是否已获得「安装未知应用」权限（Android 8+ 需要逐应用授权）。*/
    fun canInstallPackages(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }
}
