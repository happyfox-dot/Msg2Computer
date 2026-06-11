package com.codesync.util

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.concurrent.ConcurrentHashMap

/**
 * 含敏感数据（配对密钥、设备凭证）的 SharedPreferences 统一从这里获取：
 * Android Keystore 主密钥 + EncryptedSharedPreferences 落盘加密，
 * 首次访问时自动把同名明文 prefs 的旧数据迁移进来并清空原文件。
 *
 * 配对密钥是整个信任体系的根（可伪造鉴权、解密中继负载），
 * 明文存在 /data/data 下会被备份提取、root 设备直读。
 * 极少数 ROM 的 Keystore 不可用时回退明文，保证功能不被锁死。
 */
object SecurePrefs {
    private const val TAG = "SecurePrefs"
    private val cache = ConcurrentHashMap<String, SharedPreferences>()

    fun get(context: Context, name: String): SharedPreferences {
        return cache.getOrPut(name) {
            runCatching { createEncrypted(context.applicationContext, name) }
                .getOrElse { e ->
                    Log.e(TAG, "EncryptedSharedPreferences 不可用（$name），回退明文存储", e)
                    context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)
                }
        }
    }

    private fun createEncrypted(context: Context, name: String): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val encrypted = EncryptedSharedPreferences.create(
            context,
            "${name}_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
        migratePlainPrefs(context, name, encrypted)
        return encrypted
    }

    /** 把旧明文 prefs 的数据搬进加密存储（已存在的键不覆盖），随后清空明文文件。 */
    private fun migratePlainPrefs(context: Context, plainName: String, encrypted: SharedPreferences) {
        val plain = context.getSharedPreferences(plainName, Context.MODE_PRIVATE)
        val entries = plain.all
        if (entries.isEmpty()) return
        val editor = encrypted.edit()
        for ((key, value) in entries) {
            if (encrypted.contains(key)) continue
            when (value) {
                is String -> editor.putString(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is Float -> editor.putFloat(key, value)
                is Set<*> -> {
                    @Suppress("UNCHECKED_CAST")
                    editor.putStringSet(key, value as Set<String>)
                }
            }
        }
        editor.apply()
        plain.edit().clear().apply()
        Log.i(TAG, "已迁移 ${entries.size} 项明文配置到加密存储：$plainName")
    }
}
