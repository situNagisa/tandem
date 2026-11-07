# iOS 适配评估

> 范围：只调研与评估，不改产品代码。依据 Capacitor / Apple / WebKit 公开文档（2026-11 核对），针对现有 `packages/mobile`（Capacitor 8）与 `packages/web`。所有结论以真机复测为准。

## 结论

- **零成本起点**：PWA（Safari「添加到主屏幕」）+ iOS 前台使用。现有 web 基本可用；后台连接、事件通知、扫码、反馈文件导出需要降级或补实现。
- **原生 App**：Capacitor iOS 必须在 macOS + Xcode 构建，本机 WSL 无法出包。
- **后台审批**：iOS 没有 Android 前台服务（`AndroidForegroundService`）的通用等价物。要「锁屏也能收到审批」，可靠方案只有 APNs，与「不接第三方推送」约束冲突，需产品所有者决定。
- **中继 E2E**：需要 iOS 17+（Safari 17 起支持 WebCrypto X25519/Ed25519）。

## 1. 构建条件与分发

Capacitor 8 要求 iOS 16+；官方明确 iOS 构建需要 macOS + Xcode（CocoaPods 管理依赖）。

| 构建方式 | 成本 | 门槛 / 风险 |
|---|---|---|
| 自备 Mac（Mac mini 即可） | 一次性购机 | 代码不出内网；需维护 Xcode、签名证书 |
| 云端 Mac（MacStadium、AWS EC2 Mac 等） | 按小时/月租，通常每月数百元起 | 代码要上传第三方；需所有者同意 |
| Xcode Cloud | Developer Program 含每月 25 计算小时，超出按档付费 | 代码在 Apple 云端；需付费账号 |
| GitHub Actions macOS | 私有库约 $0.062/分钟，公开库免费；单次构建数分钟 | 代码上传到 GitHub；需所有者同意 |
| Ionic Appflow 等第三方 CI | 按套餐 | 同样需要上传代码 |

签名与分发：

| 方式 | 费用 | 限制 |
|---|---|---|
| 免费 Personal Team | $0 | 描述文件 7 天过期，只能装自己设备；无推送、无 TestFlight；仍需 Mac |
| Apple Developer Program | $99/年 | 可 Ad Hoc / TestFlight / App Store / APNs；个人或组织（组织需 D-U-N-S） |
| TestFlight | 含在 $99 | 内部测试者 100 人（无需审核）；外部最多 1 万人，首个构建需 Beta 审核；构建 90 天过期 |
| Ad Hoc | 含在 $99 | 每类设备每年最多 100 台，需收集 UDID；无 App Store 审核，适合内测 |
| App Store | 含在 $99 | 公开上架需审核、隐私标签；内部工具类应用有被拒风险 |
| Enterprise | $299/年 | 需 100+ 员工、D-U-N-S、仅内部使用；本项目不适用 |

## 2. 功能差异逐项评估

| 能力 | Android 现状 | iOS 现实与方案 |
|---|---|---|
| 后台保持 WS | 可选前台服务 `dataSync` 常驻（`native.ts`） | 退后台后系统很快挂起（`beginBackgroundTask` 仅约 30 秒），无 socket 保活；audio/location/VoIP 等后台模式不适用且有审核风险。只能前台连接，回前台用已有 seq 重放补事件 |
| 收件箱审批 | 本地通知 + 允许/拒绝按钮 | 本地通知只能由运行中的 App 触发或提前排期，无法响应远端 WS 事件。可选：①仅前台；②`BGAppRefreshTask` 轮询（系统决定时机，常为小时级，运行约 30 秒），发现待审批再发本地通知；③APNs 静默推送唤醒后拉取。通知按钮可在后台唤醒 App 约 30 秒。Capacitor 通知 action 在 iOS 有「App 须已在后台」的已知问题（#2330），需实测 |
| 局域网访问 | http + `usesCleartextTraffic` | iOS 14+ 有本地网络权限；Info.plist 加 `NSLocalNetworkUsageDescription`（用 Bonjour 再加 `NSBonjourServices`）。TN3179 称 WKWebView/Safari 流量不触发该权限，但 Apple FAQ 与实测报告有出入，必须真机验证。ATS 默认禁明文，局域网可用 `NSAllowsLocalNetworking`（未限定域名/.local/IP），WKWebView 内容用 `NSAllowsArbitraryLoadsInWebContent`；上架需说明理由 |
| 语音输入 | 设备识别 + Host 转写 | Host 转写（16kHz WAV）与平台无关，iOS 首选。`SFSpeechRecognizer` 的 `supportsOnDeviceRecognition` 因语言/机型而异；只有 `requiresOnDeviceRecognition = true` 才能保证不联网，否则可能走 Apple 服务器。`@capacitor-community/speech-recognition` 未暴露该开关，需改原生或自写插件。需 `NSSpeechRecognitionUsageDescription` + `NSMicrophoneUsageDescription`。WKWebView 自 iOS 14.3 支持 getUserMedia；MediaRecorder 输出 audio/mp4（现有候选已含） |
| 扫码配对 | 浏览器 `BarcodeDetector` | iOS Safari/WKWebView 不支持 `BarcodeDetector`，`scannerSupported()` 为 false，入口会被隐藏。方案：jsQR/ZXing-WASM（纯前端，性能一般）或 `@capacitor-mlkit/barcode-scanning`（原生，需 `NSCameraUsageDescription`） |
| 中继 E2E | WebCrypto X25519/Ed25519 | Safari/iOS 17 起支持；iOS 16 无此算法，中继不可用（`lib/relay.ts` 已做能力检测）。AES-GCM/HKDF 无问题。`capacitor://localhost` 是否算安全上下文需真机验证，否则 `crypto.subtle` 不可用 |
| 文件下载/分享 | `a[download]` 或原生分享 | WKWebView 不执行 `<a download>`；`feedback.ts` 已对 native 走 `navigator.share` 兜底（WKWebView 自 12.2 支持分享，文件分享需 iOS 15+）。更稳妥：接 `@capacitor/share` + `@capacitor/filesystem` 写临时文件后弹分享面板（可存「文件」或发飞书）。大 JSON 用剪贴板兜底可能超限 |
| 反馈录屏 | `getDisplayMedia` | iOS 不可用，`FeedbackMode` 已有能力检测，录屏项会隐藏；截图/标注不受影响（截图由 Host 生成，iOS 只负责展示） |
| 截图/长按/安全区 | 适配过 Android | 需补 `viewport-fit=cover`、`env(safe-area-inset-*)`、键盘遮挡、iOS 橡皮筋滚动；PWA 独立窗口下尤其明显 |

补充：PWA 的 Web Push 自 iOS 16.4 起可用，但仅限「已添加到主屏幕」且页面为 HTTPS（且经 APNs）；当前 Host 是局域网 http，所以 PWA 无法直接获得推送，仍受同一约束。

## 3. 工作量估计（S/M/L）

| 工作 | 规模 | 说明 |
|---|---|---|
| PWA 主屏体验：安全区/视口、下载与扫码降级、iOS 文案 | S | 不改架构，WSL 可完成，请用户用 iPhone 验证 |
| Capacitor iOS 壳（仅前台可用） | M | `cap add ios`、Info.plist 权限与 ATS、Share 插件、二维码 fallback、真机调试；另需 Mac 构建环境 |
| `BGAppRefreshTask` 轮询 + 本地通知 | M/L | 原生代码 + 后台任务标识；时机不可控，只能算「尽力提醒」 |
| APNs 推送（服务端 + 客户端） | L | 推送密钥/证书、token 注册、静默推送、opaque payload、安全评审与运维；需所有者先解除约束 |
| 分发流水线（Ad Hoc / TestFlight） | S/M | 每次签名、上传；外部测试需审核 |

## 4. 推荐路线

1. **先走 PWA**：Safari「添加到主屏幕」即获得近似 App 的全屏体验，前端补安全区与降级逻辑；不引入构建与签名成本，也不上传代码。
2. **确认真实需求**：如果只是「手机上随手看会话、发消息、审批」，PWA + 前台使用已够；锁屏审批是另一个量级的能力。
3. **要做原生就做前台-only 的 Capacitor 壳**：复用同一份 web，与 Android 对齐；构建优先用所有者自备 Mac（代码不出内网），分发先用 Ad Hoc（100 台）或 TestFlight 内部测试。
4. **APNs 最后再议**：只有所有者明确接受「经 Apple 服务器」后才实现，并采用不透明唤醒 + 回连自托管中继取内容，减少暴露面。

## 5. 需要产品所有者决定的问题

1. **交付形态**：只做 PWA / 只做原生 / 两者。影响：原生需要 Mac 构建、签名与分发，PWA 没有后台通知且不能上架。
2. **是否允许 APNs**：不允许（仅前台 + 可选不可靠轮询）/ 允许（锁屏可靠审批，但通知经 Apple 服务器、Host 需出网、需付费账号）。影响：直接决定「后台审批」能否实现，与「不接第三方推送」约束冲突。
3. **构建环境**：自备 Mac / 云端 Mac 或 GitHub Actions。影响：一次性购机 vs 按分钟计费；后者必须把代码上传第三方，需安全确认。
4. **分发方式**：Ad Hoc / TestFlight / App Store / Enterprise。影响：Ad Hoc 限 100 台且要 UDID；TestFlight 外部审核、构建 90 天过期；App Store 公开审核；Enterprise 需 100+ 员工（不适用）。
5. **最低 iOS 版本**：iOS 17 / iOS 16。影响：iOS 17 起中继 E2E 可用；支持 16 则只能局域网 http。
6. **后台审批预期**：仅回前台可见 / 接受轮询的不确定延迟 / 上 APNs。影响：产品承诺与实现成本。

## 6. 真机验证清单（有 Mac/设备后）

- 局域网 IP http 是否弹本地网络权限；ATS 配置是否放行。
- iOS 17 与 16 上 `crypto.subtle`、X25519/Ed25519（Safari 与 `capacitor://` 各测）。
- 退后台挂起时间、回前台 seq 重放是否补齐。
- 本地通知 action 在「后台/被杀/未启动」三种状态的回调。
- 设备语音是否离线可用；Host 转写链路。
- 相机扫码、反馈 JSON 分享到「文件」/飞书。
- PWA 主屏下的安全区、键盘、下载与分享。

## 资料

- Capacitor: Environment Setup / iOS / Configuration（`iosScheme`、`server.hostname`）
- Apple: TN3179 本地网络隐私、`NSAllowsLocalNetworking`、`NSLocalNetworkUsageDescription`、ATS
- Apple: `SFSpeechRecognizer.supportsOnDeviceRecognition`、`requiresOnDeviceRecognition`
- WebKit: Safari 17 特性；caniuse X25519 / BarcodeDetector
- Apple: Developer Program / Enterprise / TestFlight / Ad Hoc 帮助页；Xcode Cloud
- GitHub Docs: Actions runner pricing；WebKit: Web Push for Web Apps on iOS 16.4
