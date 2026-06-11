# CodeBridge

CodeBridge 是一个跨设备验证码与消息同步工具。它由 Android 手机端和 Windows 桌面端组成，用于把手机收到的验证码短信、普通短信、App 通知，以及本机保存的 TOTP 动态验证码，同步到你授权的设备节点。

项目目标很明确：在不依赖云端服务器的前提下，让多台手机、多台电脑之间可以安全、可控地共享临时验证码和 2FA 信息。设备之间通过局域网、可选的 Tailscale 地址和受信节点 relay 建立同步拓扑，所有业务消息都只在用户授权的节点之间流转。

当前版本：`1.0.24`

## 适用场景

- 电脑登录网站时，手机收到短信验证码后自动推送到电脑端。
- 多台手机和多台电脑之间按设备节点管理推送范围。
- 手机熄屏后仍尽量完成验证码、短信、通知转发。
- 将 Google Authenticator / otpauth TOTP 种子导入本机，并同步到授权设备。
- 使用局域网发现和二维码配对快速加入新设备节点。
- 在没有公网服务器的情况下，通过局域网或 Tailscale 连接自己的设备。

## 核心功能

### 消息同步

- 验证码短信：Android 端自动识别短信中的验证码，推送到目标设备。
- 全部短信：用户可选择是否推送普通短信原文。
- App 通知：用户可选择是否通过 Android 通知监听服务推送 App 通知。
- 接收策略：每个节点可以独立选择接收验证码短信、普通短信、App 通知中的哪些内容。
- 来源标注：桌面端会标注消息来源设备、来源应用/号码、目标节点和同步路径。

### TOTP 动态验证码

- 支持标准 `otpauth://totp` 二维码导入。
- 支持 Google Authenticator 迁移二维码批量导入。
- 支持剪贴板图片和上传图片解析二维码。
- 支持本地生成 TOTP，并在界面中展示倒计时。
- 支持多条 TOTP 置顶、编辑、删除和重复导入覆盖更新。
- 来源设备删除自己提供的 TOTP 后，可向其它节点同步删除状态。

### 多设备与拓扑

- 手机和电脑都作为设备节点参与拓扑，不再把电脑作为唯一目标。
- 支持一台手机推送到多台电脑，也支持多台手机推送到同一电脑。
- 支持手机到手机、电脑到电脑、手机到电脑之间的节点配对与 relay。
- 拓扑控制面使用独立消息类型：`topology_delta`、`node_advertisement`、`link_advertisement`。
- 拓扑变更通过 flood/gossip 传播，离线节点重新上线后可补同步拓扑状态。
- 路由计算区分“显示边”和“可路由边”：发现但未授权的设备只展示，不进入可达路由。

### 桌面端体验

- Electron 桌面端常驻托盘。
- 收到验证码短信时弹出右下角气泡，并自动复制验证码。
- 普通短信和 App 通知在消息列表中按类型展示，不会误复制空验证码。
- 支持显示验证码或原始短信内容。
- 支持拖动顶部栏目条查看较多页面。
- 支持授权设备管理、禁用、恢复、撤销。

### Android 端体验

- Kotlin Android 原生客户端。
- 支持扫码配对、局域网发现、推送目标管理。
- 支持熄屏转发所需的前台服务、唤醒锁和 Wi-Fi 锁。
- 支持短信接收、通知监听、节点收件服务。
- 支持本节点发送/接收内容策略设置。

## 安全与隐私

- 默认不经过任何云端服务器，消息只在用户设备之间流转。
- 配对二维码中包含设备地址和配对密钥，只有扫码后的设备可以建立受信连接。
- WebSocket 业务消息使用 AES-256-GCM 加密。
- 手机和桌面端都保存设备身份和授权列表，可单独禁用或撤销设备。
- TOTP 种子属于高敏感信息，只有来源设备和被授权节点应持有。
- Android 通知监听权限需要用户在系统设置中手动授权。

## 架构概览

```text
Android Phone A
  SMS / Notification / TOTP
        |
        | encrypted message / topology delta
        v
Windows Desktop B  <---- relay / topology gossip ---->  Android Phone C
        |
        v
Windows Desktop D
```

主要通信组件：

- Android `SmsReceiver`：接收短信，按策略发送验证码短信或普通短信。
- Android `NotificationRelayService`：接收系统通知，按策略推送 App 通知。
- Android `WebSocketService`：负责按需连接、加密投递、relay 和拓扑广播。
- Android `NodeReceiverService`：作为节点收件服务，接收来自其它节点的 relay 消息。
- Desktop `main.js`：桌面端主进程，负责配对、授权、WebSocket 服务、拓扑和系统通知。
- Desktop `renderer.js`：桌面端 UI，负责验证码、短信、通知、TOTP 和拓扑展示。

## 分发包命名

当前本地构建产物建议使用以下命名：

- Windows：`CodeBridge-Windows-Setup-v1.0.24.exe`
- Android：`CodeBridge-Android-v1.0.24.apk`

原始构建输出通常位于：

- Windows：`desktop/dist/`
- Android：`android/app/build/outputs/apk/release/`

## 安装使用

### Windows 端

1. 安装 Windows 安装包。
2. 启动后进入“配对”页面。
3. 确认 Windows 防火墙允许本应用在局域网监听。
4. 等待页面显示二维码。

### Android 端

1. 安装 APK。
2. 授权短信、通知、相机、前台服务等权限。
3. 如需推送 App 通知，进入系统“通知使用权”页面授权 CodeBridge。
4. 扫描 Windows 端二维码，或在局域网发现设备列表中加入节点。
5. 在“消息同步策略”里选择本节点发送和接收哪些内容。

## 构建

### Android

构建需要 JDK 17 和 Android SDK。

```powershell
cd android
.\gradlew.bat :app:assembleRelease --no-daemon --console=plain
```

Release 签名配置通过 `android/keystore.properties` 或环境变量提供。签名密钥、密码文件和构建产物已在 `.gitignore` 中排除，不应提交到公开仓库。

### Windows

```powershell
cd desktop
npm install
npm start
npm run build:win
```

Windows 安装包由 `electron-builder` 生成，输出在 `desktop/dist/`。

## 项目结构

```text
CodeBridge1/
├── android/                  Android 手机端
│   └── app/src/main/java/com/codesync/
│       ├── MainActivity.kt
│       ├── QRScannerActivity.kt
│       ├── receiver/
│       ├── service/
│       ├── ui/
│       └── util/
├── desktop/                  Electron Windows 桌面端
│   ├── main.js
│   ├── preload.js
│   └── src/
├── docs/                     功能和实现说明
├── test/                     解析、TOTP、拓扑相关测试脚本
└── README.md
```

## 友链

感谢 [LINUXDO](https://linux.do/) 社区提供的帮助与支持。

## 许可

本项目采用 `PolyForm Noncommercial License 1.0.0`。

你可以在个人、学习、研究、评估和其它非商业场景中使用、修改和分发本项目源码及构建产物。未经版权所有者另行书面授权，不允许将本项目用于销售、收费服务、商业产品集成、商业组织内部生产使用或其它商业目的。

该限制意味着本项目是“源码可见的非商业软件”，不属于 OSI 定义下的开放源代码许可。完整条款见 `LICENSE`。
