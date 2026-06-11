# CodeBridge TOTP 功能说明

## 概述

CodeBridge 的 TOTP（基于时间的一次性密码）功能从最初的单一手动添加方式，升级为专业级的多方式批量导入系统。核心能力包括：

- 三种添加方式：扫描二维码、从相册导入、手动输入
- 完整支持 Google Authenticator 批量迁移协议（`otpauth-migration://`），一次导入多个账号并可选择性导入
- 支持 SHA1 / SHA256 / SHA512 算法，6 / 7 / 8 位验证码，30 / 60 秒周期
- 使用 `EncryptedSharedPreferences`（AES256-GCM）加密存储密钥
- 所有解析与识别均在本地完成，不上传任何数据；同步到电脑端使用 AES-256-GCM 加密传输

起始版本 v1.0.5：仅手动输入（入口不明确，无验证）。v1.0.6：三种添加方式 + 相册导入。v1.0.7：在此基础上增加 Google 批量导入支持，并修复一批 TOTP 严重 Bug。

---

## TOTP 算法支持

早期实现把算法、位数、周期写死为 `SHA1` / `6 位` / `30 秒`，导入非默认参数的账号时本地生成的验证码会出错。现已改为动态参数，由 `TotpUtil.generate()` 接收 `algorithm`、`digits`、`period`，`getRemainingSeconds()` / `getCurrentCounter()` 也支持动态周期。

| 参数 | 支持值 | 默认值 |
|------|--------|--------|
| algorithm | SHA1, SHA256, SHA512 | SHA1 |
| digits | 6, 7, 8 | 6 |
| period | 30, 60 | 30 |

导入时会完整保留 issuer、algorithm、digits、period 等所有参数，确保手机端与桌面端生成的验证码一致。

---

## 添加方式

用户点击"添加 TOTP"后，弹出选择对话框（图标化选项）：

```
┌─────────────────────────────┐
│      选择添加方式            │
├─────────────────────────────┤
│  📷 扫描二维码               │  ← 实时扫描
│  🖼️ 从相册导入              │
│  ⌨️ 手动输入密钥            │  ← 增强验证
│         [取消]               │
└─────────────────────────────┘
```

### 扫描二维码

适用于配置新账号、快速添加。操作流程为 2 步（扫描 → 自动保存）。

- 根据来源显示不同的扫描提示：从 TOTP 入口进入显示"扫描 TOTP 二维码（Google Authenticator 格式）"，从配对入口进入显示"扫描电脑配对二维码或 TOTP 二维码"。这由 `QRScannerActivity` 的 `EXTRA_SCAN_TOTP_ONLY` Intent 参数控制。
- 支持标准 TOTP（`otpauth://totp`）和 Google 批量导出（`otpauth-migration://`）两种格式。
- 使用 ZXing 库实时识别。

### 从相册导入

适用于批量迁移、恢复备份截图、导入他人发送的二维码图片、离线配置。操作流程为 3 步（选图 → 识别 → 确认导入）。

- 使用 `ActivityResultContracts.GetContent()` 选图，ZXing（TRY_HARDER 模式）识别图片中的二维码。
- 支持 PNG、JPG、JPEG 等常见格式，二维码需清晰可见。
- 支持标准 TOTP 单个账号与 Google 批量导出多个账号。
- 完整解析 TOTP 参数（issuer、algorithm、digits、period）。

权限适配：

```xml
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
```

- Android 13+：使用精细化权限 `READ_MEDIA_IMAGES`
- Android 12 及以下：使用 `READ_EXTERNAL_STORAGE`

### 手动输入

适用于只有文本密钥、无法扫描或导入图片、从网页复制密钥的场景。操作流程为 4 步（输入标签 → 输入密钥 → 验证 → 保存）。

增强功能：

- 自动规范化：转大写、去空格、去横杠。
- 完整验证：空值检查（提示"请输入 TOTP 密钥"）、Base32 格式验证（提示"密钥格式无效，请输入有效的 Base32 密钥（16 位以上，仅包含 A-Z 和 2-7）"）。
- 输入框优化：密钥框自动大写并禁用建议词（防泄露），标签框首字母自动大写。
- 输入框显示示例密钥格式（如 `JBSWY3DPEHPK3PXP`）。

格式要求：密钥必须是 16 位以上的有效 Base32 字符串（A-Z, 2-7）。校验通过 `TotpUtil.validateSecret()` 完成。

### Google Authenticator 批量导入

完整支持 `otpauth-migration://` 协议，一次解析多个账号（支持 10+ 个），用户可选择性导入，保留 issuer、algorithm、digits、period 等所有参数，兼容 SHA1/SHA256/SHA512 算法与 6/8 位验证码。

扫描或从相册导入 Google 批量导出二维码后，显示账号选择界面：

```
┌─────────────────────────────────────┐
│ 检测到 Google Authenticator 批量导出 │
│           包含 5 个账号               │
├─────────────────────────────────────┤
│ ☑ Google: user@gmail.com   SHA1,6位 │
│ ☑ GitHub: username         SHA1,6位 │
│ ☑ AWS: account             SHA1,6位 │
│ ☑ Microsoft: user@...      SHA1,6位 │
│ ☑ Dropbox: user@...        SHA1,6位 │
├─────────────────────────────────────┤
│  [导入所选]  [全部导入]  [取消]      │
└─────────────────────────────────────┘
    ↓
成功导入 5 个账号
```

解析流程（详见下文协议格式说明）：

```
otpauth-migration://offline?data=<base64>
    ↓ 提取 data 参数
    ↓ Base64 解码 → 二进制数据
    ↓ 手动解析 Protobuf（无需编译 schema）
    ├─ 读取 MigrationPayload
    ├─ 遍历 otp_parameters (repeated)
    └─ 解析每个 OtpParameters（secret→Base32、name、issuer、algorithm、digits、type）
    ↓ 过滤：只保留 TOTP 类型（跳过 HOTP）
    ↓ 返回账号列表
```

错误处理：单个账号解析失败不影响其他账号；自动跳过 HOTP 等不支持的类型。

---

## 加密存储

早期版本使用普通 `SharedPreferences` 明文存储密钥（桌面端用 `safeStorage` 加密，手机端反而是明文），且采用 `"label|secret"` 拼串，丢失了 issuer/algorithm/digits/period 字段。现已重构：

- 新增 `TotpEntry.kt` 数据类，包含完整字段，支持 JSON 序列化，所有 TOTP 数据改用 JSON 存储。
- 新增 `TotpStore.kt` 封装加密存储，使用 Android Jetpack Security 的 `EncryptedSharedPreferences`：
  - 主密钥：AES256-GCM（Android Keystore）
  - Key 加密：AES256-SIV
  - Value 加密：AES256-GCM
- 首次运行时自动从旧格式迁移到新格式。

---

## 已修复的 Bug

### 1. 本地 TOTP 生成忽略导入参数（验证码错误）

`TotpUtil.kt` 把算法/位数/周期写死为 `SHA1`/`6 位`/`30 秒`。解析时虽获取了完整参数，但存储只保留 `label|secret`，本地生成时使用硬编码参数，导致导入 SHA256/SHA512 或 8 位账号时验证码错误，手机端与桌面端不一致。

修复：`generate()` 新增 `algorithm`、`digits`、`period` 参数；`getRemainingSeconds()` / `getCurrentCounter()` 支持动态周期；支持 SHA1/SHA256/SHA512、6/7/8 位、30/60 秒。

### 2. 无法删除/编辑单个 TOTP

只有添加功能，没有删除入口，TOTP 卡片只能点击复制，导入错误只能清除应用数据。

修复：为 TOTP 卡片添加 `setOnLongClickListener`，长按弹出确认对话框，确认后删除该条目。

### 3. TOTP 密钥明文存储

使用普通 `SharedPreferences` 明文存储密钥。

修复：改用 `EncryptedSharedPreferences`（AES256-GCM），新建 `TotpStore.kt` 封装，自动从旧格式迁移（详见"加密存储"）。

### 4. TOTP 存储模型丢字段

`"label|secret"` 拼串只存 2 个字段，issuer/algorithm/digits/period 全部丢失。

修复：新建 `TotpEntry.kt` 完整字段数据类，支持 JSON 序列化，所有数据改用 JSON 存储。

---

## Google Authenticator 迁移格式说明

### URL Schema

```
otpauth-migration://offline?data=<URL_ENCODED_BASE64_PROTOBUF>
```

### Protobuf Schema

```protobuf
message MigrationPayload {
  enum Algorithm {
    ALGORITHM_UNSPECIFIED = 0;
    ALGORITHM_SHA1 = 1;
    ALGORITHM_SHA256 = 2;
    ALGORITHM_SHA512 = 3;
    ALGORITHM_MD5 = 4;
  }

  enum DigitCount {
    DIGIT_COUNT_UNSPECIFIED = 0;
    DIGIT_COUNT_SIX = 1;
    DIGIT_COUNT_EIGHT = 2;
  }

  enum OtpType {
    OTP_TYPE_UNSPECIFIED = 0;
    OTP_TYPE_HOTP = 1;
    OTP_TYPE_TOTP = 2;
  }

  message OtpParameters {
    bytes secret = 1;          // 原始字节（需转换为 Base32）
    string name = 2;           // 账号名称
    string issuer = 3;         // 发行者
    Algorithm algorithm = 4;   // 算法
    DigitCount digits = 5;     // 位数
    OtpType type = 6;          // 类型
    int64 counter = 7;         // HOTP 计数器
  }

  repeated OtpParameters otp_parameters = 1;
  int32 version = 2;
  int32 batch_size = 3;
  int32 batch_index = 4;
  int32 batch_id = 5;
}
```

### 编码过程

1. Protobuf 序列化 → 二进制数据
2. Base64 编码
3. URL 编码（`+` → `%2B`，`/` → `%2F`，`=` → `%3D`）
4. 拼接为 `otpauth-migration://offline?data=...`

### 枚举映射（解析时）

- 算法：1=SHA1，2=SHA256，3=SHA512，4=MD5
- 位数：1=6 位，2=8 位
- 类型：1=HOTP，2=TOTP（仅保留 TOTP）

### 实现说明

迁移解析由 `GoogleAuthMigrationParser.kt`（约 350 行）完成，特点：

- 手写 Protobuf 解析器（无需编译器 / runtime）：支持 varint 解码、length-delimited 字段解析、嵌套消息解析。
- Base64 解码、Base32 编码（secret 原始字节 → 标准 Base32 字符串）。
- 处理批量字段（batch_size / batch_index）。
- 完整错误处理。

依赖：`com.google.protobuf:protobuf-javalite:3.21.12`（Javalite 轻量版，约 500KB）。注意：实际 Protobuf 数据为手写解析，该依赖主要用于轻量运行时支持。

### 验证建议

格式与官方定义一致（Protobuf 结构、枚举值、Base32 转换、批量导入均匹配），但唯一可靠的验证方式是实际测试：用真实的 Google Authenticator 导出 1-3 个账号（建议覆盖不同算法/位数组合），用 CodeBridge 扫描批量导出二维码，核对导入的账号数量与验证码是否与 Google Authenticator 一致。若不一致，重点检查算法映射与 secret 的 Base32 转换。

参考资源：

- Google Authenticator Export Format: https://zwyx.dev/blog/google-authenticator-export-format
- Parse Google Authenticator QR Codes: https://gist.github.com/jmiserez/744116545d7f595923966f883c4f1b5d
- dim13/otpauth（Go 实现）: https://github.com/dim13/otpauth
- digitalduke/otpauth-migration-decoder（JS 实现）: https://github.com/digitalduke/otpauth-migration-decoder
- trewlgns/otpauth-migration-decode（Web 工具）: https://github.com/trewlgns/otpauth-migration-decode

---

## 相关源文件

| 文件 | 说明 |
|------|------|
| `MainActivity.kt` | 添加入口对话框、相册图片处理、手动输入验证、长按删除、调用新存储 |
| `QRScannerActivity.kt` | 扫描提示动态化（`EXTRA_SCAN_TOTP_ONLY`） |
| `GoogleAuthMigrationParser.kt` | Google 迁移协议解析器（Protobuf 手写解析、Base32 编码） |
| `TotpUtil.kt` | 动态参数验证码生成（algorithm/digits/period）、`validateSecret()` |
| `TotpEntry.kt` | TOTP 数据模型（完整字段，JSON 序列化） |
| `TotpStore.kt` | 加密存储管理器（EncryptedSharedPreferences） |
| `strings.xml` | 新增添加方式与错误提示字符串 |
| `AndroidManifest.xml` | 相册读取权限 |
| `build.gradle.kts` | Protobuf Javalite 依赖 |

## 构建说明

环境要求：JDK 17（必须，Gradle 8.5 不支持 JDK 24/25）、Gradle 8.5+（项目使用 8.13）、Android SDK（compileSdk 34，minSdk 23）。

```bash
# 使用 Gradle Wrapper
cd android
gradlew.bat assembleRelease   # Windows
./gradlew assembleRelease      # Linux/Mac
```

产物位置：`android/app/build/outputs/apk/release/app-release-unsigned.apk`。也可用 Android Studio 打开 `android` 目录后 Build → Build APK(s)。

签名：

```bash
zipalign -p -f 4 app-release-unsigned.apk app-release-aligned.apk
apksigner sign --ks ../release/codebridge-release.jks \
  --ks-key-alias codebridge \
  --ks-pass pass:<密码> --key-pass pass:<密码> \
  --out app-release-signed.apk app-release-aligned.apk
apksigner verify --print-certs app-release-signed.apk
```
