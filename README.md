# CodeBridge · 跨设备验证码同步

手机收到短信验证码后，电脑端**即时弹出并自动复制到剪贴板**，让你在电脑上登录时不用再拿起手机。

由 **Android 手机端**（监听短信、转发 TOTP）和 **Windows/Mac 桌面端**（接收、展示、复制）两部分组成，通过局域网 WebSocket 加密通信，**不经过任何云端服务器**，验证码只在你自己的设备之间流转。

---

## 核心特性

- 📩 **短信验证码自动转发**：手机收到验证码短信，自动识别码值并推送到电脑，电脑端弹窗显示并复制到剪贴板。
- 📄 **原文逐条切换**：电脑端默认显示提取出的验证码，点击任意一条卡片即可切换查看该条短信的**完整原文**（识别错时可对照）。
- ⏱️ **TOTP 动态验证码**：手机端可托管 TOTP（与 Google Authenticator 同算法），需要时一键推送当前码到电脑，带剩余有效期倒计时。
- 🔗 **二维码配对**：电脑端显示二维码，手机扫码即完成配对，无需手动输入地址。
- 🔐 **加密传输**：配对后每次连接协商独立会话密钥，验证码负载用 **AES-256-GCM** 加密；密钥与短信内容都不出局域网。
- 🖥️📱 **多对多**：一台手机可同时推送给多台电脑；一台电脑可接收多台手机。两端都能逐设备启用 / 禁用 / 撤销。
- ♻️ **撤销与恢复**：电脑端可撤销某台手机的授权（之后该手机重连一律被拒）；误撤销后可在电脑端「恢复」重新授权。
- 🔋 **按需连接、零常驻耗电**：手机端平时不保持任何连接，仅在收到验证码 / 手动推送 TOTP 时临时连接、投递、收到 ACK 后立即断开。
- 🪟 **桌面端常驻托盘**：开机自启（隐藏到托盘），收到验证码时右下角气泡提示 + 系统通知。

---

## 工作原理

```
┌─────────────┐   ① 扫码配对（获取 host:port + pairingKey）   ┌──────────────┐
│  Android 端 │ ◄──────────────────────────────────────────► │  桌面端       │
│             │                                               │ (WS 服务器)   │
│ 监听短信     │   ② 收到验证码 → 临时连接 → auth 鉴权          │ :19527        │
│ 提取码值     │ ─────────────────────────────────────────►   │              │
│ AES 加密     │   ③ 发送 verify_code（AES-256-GCM 密文）       │ 解密 → 弹窗   │
│             │ ─────────────────────────────────────────►   │ → 复制剪贴板  │
│             │   ④ 收到 code_ack → 断开连接（省电）           │ → 回 ACK      │
│             │ ◄─────────────────────────────────────────   │              │
└─────────────┘                                               └──────────────┘
        全程在同一局域网内，不经过任何外部服务器
```

- **配对密钥**：每台电脑持有一把 `pairingKey`（写入二维码）。扫到该码的手机都能通过鉴权，连接后再以 `phoneId` 区分各台手机的身份与授权状态。
- **按需模型**：手机端不做空闲常驻连接，只在有验证码 / TOTP 要发时才连接，投递完即断，空闲期几乎不耗电。投递有 90 秒时限与指数退避重连，覆盖电脑临时离线的情况。

---

## 目录结构

```
CodeBridge1/
├── android/                    # Android 手机端（Kotlin）
│   └── app/src/main/java/com/codesync/
│       ├── MainActivity.kt          # 主界面：设备列表、TOTP 管理、转发开关
│       ├── QRScannerActivity.kt     # 扫码配对
│       ├── receiver/SmsReceiver.kt  # 短信广播接收
│       ├── service/WebSocketService.kt  # 按需连接投递服务（核心）
│       └── util/
│           ├── CodeExtractor.kt     # 验证码正则提取
│           ├── CryptoUtil.kt        # AES-256-GCM 加解密
│           ├── TotpUtil.kt          # TOTP 生成
│           ├── DeviceStore.kt       # 已配对电脑列表（多目标）
│           ├── PhoneIdentityStore.kt# 本机身份（phoneId/phoneName）
│           └── SettingsStore.kt     # 转发开关等设置
└── desktop/                    # 桌面端（Electron）
    ├── main.js                      # 主进程：WS 服务器、配对、手机授权管理、托盘
    ├── preload.js                   # 安全 IPC 桥
    └── src/
        ├── index.html / styles.css
        ├── renderer.js              # 渲染层：验证码列表、原文切换、手机管理
        └── totp.js                  # TOTP 周期/倒计时显示
```

---

## 构建

### 环境要求

| 组件 | 版本 |
|------|------|
| Android Gradle Plugin | 8.2.0 |
| Gradle | 8.5+（已在 8.13 验证） |
| JDK | **17**（Gradle 不支持 JDK 24/25，构建必须用 17） |
| compileSdk / minSdk | 34 / 26 |
| Node.js | 18+ |
| Electron / electron-builder | 28.x / 24.x |

### Android

```bash
cd android
# 用 JDK 17 构建 release（注意：JDK 24/25 无法运行 Gradle 8.5）
JAVA_HOME=<jdk-17-path> gradle assembleRelease
# 产物（未签名）：app/build/outputs/apk/release/app-release-unsigned.apk
```

**签名**（首次需自备 keystore，本仓库不含密钥）：

```bash
# 1) 对齐
zipalign -p -f 4 app-release-unsigned.apk app-release-aligned.apk
# 2) 签名（PKCS12 keystore：key 口令通常与 store 口令一致，--key-pass 传 store 口令）
apksigner sign --ks <your-release.jks> --ks-key-alias <alias> \
  --ks-pass pass:<storePassword> --key-pass pass:<storePassword> \
  --out app-release-signed.apk app-release-aligned.apk
# 3) 校验
apksigner verify --print-certs app-release-signed.apk
```

> ⚠️ keystore 与密码文件**不要提交到仓库**（已在 `.gitignore` 屏蔽）。同一应用的后续更新必须用同一把 keystore 签名，请离线妥善保管。

### 桌面端

```bash
cd desktop
npm install
npm start            # 本地运行
npm run build:win    # 打包 Windows 安装包（NSIS）→ dist/
npm run build:mac    # 打包 macOS（需在 macOS 上执行）
```

打包体积说明：Electron 应用自带 Chromium 内核，安装包约 70 MB 属正常。已通过 `electronLanguages: ["zh-CN", "en-US"]` 只保留中英文语言包以缩减体积。

---

## 使用

1. **电脑端**：安装并启动桌面端，主界面会显示配对二维码。
2. **手机端**：安装 App，授予短信读取权限，点扫码按钮扫描电脑上的二维码完成配对。
3. **授权管理**：配对后电脑端「已授权手机」列表出现该手机，可逐台启用 / 禁用 / 撤销 / 恢复；手机端「设备列表」可管理多台电脑。
4. **日常使用**：保持手机与电脑在同一 Wi-Fi。收到验证码短信后，电脑端自动弹窗并复制到剪贴板，直接 `Ctrl+V` 粘贴即可。

---

## 安全说明

- 所有通信在**局域网内**完成，不经过外部服务器；验证码内容与会话密钥都不上传云端。
- 验证码负载使用 **AES-256-GCM** 加密，每次连接协商独立会话密钥。
- 桌面端 WebSocket 服务器监听 `:19527`，仅接受持有正确 `pairingKey` 的连接；首次需放行 Windows 防火墙对该端口的局域网访问。
- 配对密钥按电脑保存于本机用户数据目录，可随时「重新配对」轮换（轮换后所有手机需重新扫码）。

---

## 常见问题

- **手机连不上电脑**：确认两台设备在同一 Wi-Fi；检查 Windows 防火墙是否放行 `19527` 端口；二维码里的 IP 是否为电脑当前局域网地址（换网络后需重新生成二维码）。
- **收到短信但电脑没反应**：确认手机端「转发开关」已开、目标电脑已启用、且未被撤销。
- **TOTP 显示「已过期」**：电脑端只持有推送瞬间的码快照，无法本地重算；超过当前 30 秒周期即标记过期，重新从手机推送即可。
- **撤销手机后想恢复**：在电脑端「已授权手机」列表点该手机的「恢复」按钮即可重新授权，无需更换配对密钥。
