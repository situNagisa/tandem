# Tandem

类 Claude Code Desktop 的 agent 工作台：程序本身是一个工作站服务；浏览器 / 桌面 / 手机客户端只连工作站，工作站与各主机建立连接并在主机上跑 agent。多端实时协同；每个会话可用不同账号、分组与模型（Anthropic / OpenAI / 兼容接口 / Gemini）。

## 目录
| 包 | 作用 |
|---|---|
| `packages/protocol` | 客户端与工作站/主机共享的类型（唯一契约） |
| `packages/server` | 工作站服务：账号、主机上下文、REST + WebSocket、agent 循环、工具、权限、MCP、hooks |
| `packages/web` | React 客户端（也被桌面端和 App 复用） |
| `packages/desktop` | Electron 桌面端（内置工作站服务） |
| `packages/mobile` | Capacitor 安卓 App |
| `docs/` | 文档入口见 `docs/README.md`：现行文档（设计/架构/功能/进度）、一次性记录归档、代测步骤 |

## 环境
- Node.js ≥ 22（开发用 26）
- 安卓打包另需：JDK 21、Android SDK（含 platform-tools、对应 platforms 与 build-tools）
- Windows 安装包在 Linux/WSL 上交叉打包即可（electron-builder）

## 常用命令
```bash
npm install                      # 首次
npm run build                    # 构建 protocol → web → server
npm start                        # 启动工作站（默认 127.0.0.1:8481），浏览器打开终端打印的地址
npm start -- --host 0.0.0.0      # 允许局域网访问（手机/其他机器连接需要）

npm run dev:server               # 工作站开发模式（热重载）
npm run dev:web                  # Web 开发服务器（代理到工作站地址）
node scripts/ui-audit.mjs        # UI 原语防回退检查：ui/ 目录外的手写菜单/弹层/原生下拉（0 问题才通过）

npm test                         # 单元测试（server: node:test + tsx；web: vitest）
npm run smoke                    # Playwright 端到端冒烟（临时工作站 + 假 provider，需先 build）
node scripts/check.mjs           # 提交前全量：docs → build → debug-artifacts → ui-audit → decisions → test → smoke → regression → release
```

## 打包
### 调试版与发布版
`TANDEM_FLAVOR=debug|release` 是唯一的构建开关，默认 `debug`。调试版保留反馈模式、演示工作区、体验清单、组件画廊与轨迹采集，界面右下角有「调试版」角标；发布版在构建时把这些模块与入口整体剔除（路由回首页、快捷键无效、设置与命令面板没有入口），关于页显示「发布版」。两种产物的完整清单与互斥说明见 `docs/features/release.md`。

```bash
npm run build:debug     # 默认，等于 npm run build
npm run build:release   # 构建后剔除调试模块
```

### 安卓 APK
需要 **JDK 21** 和 **Android SDK**（platform-tools、Capacitor 所需的 platforms 与 build-tools）。脚本会自动查找，找不到时提示缺什么。

```bash
npm install
npm run apk -w @tandem/mobile
```
构建 web（debug flavor）→ `cap sync android` → Gradle `assembleDebug`；产物 `dist-apk/tandem-debug.apk`，并复制到「下载」目录（Windows 本机或 WSL 下的 Windows 用户目录）。调试版与 `apk:release` 的发布版包名相同，不能同时安装。用 Android Studio 调试：`npm run open -w @tandem/mobile`。

**Linux / WSL**：`sudo pacman -S jdk21-openjdk`（或 apt 安装 openjdk-21-jdk）；SDK 默认找 `~/Android/Sdk`。

**Windows**：
1. 安装 Android Studio（自带 JBR 21，脚本会自动使用 `C:\Program Files\Android\Android Studio\jbr`），首次打开时按向导安装 SDK（默认 `%LOCALAPPDATA%\Android\Sdk`）。
   或单独安装 Temurin JDK 21，并设置 `JAVA_HOME`。
2. SDK 不在默认位置时设置 `ANDROID_HOME`：`setx ANDROID_HOME "D:\Android\Sdk"`（重开终端生效）。
3. 在 PowerShell 或 cmd 中运行上面的两条命令。

**macOS**：安装 Android Studio 即可（SDK 默认 `~/Library/Android/sdk`）。

#### release 包（签名）
```bash
npm run apk:release -w @tandem/mobile
```
首次会通过 `keytool` 在 `~/.tandem-release/` 生成 `android.keystore` 与 600 权限的密码文件（也可用 `TANDEM_ANDROID_KEYSTORE_PASSWORD` 环境变量提供密码），产出已签名的 `dist-apk/tandem-release.apk` 与 `.aab`，并用 `apksigner verify` 自动校验。发布版以 release flavor 构建（不含调试功能）。签名材料不进仓库；**请离线备份 `~/.tandem-release`**，丢失后无法覆盖升级。调试包仍用 `npm run apk -w @tandem/mobile`。

### Windows 安装包
```bash
npm run dist:win -w @tandem/desktop        # 发布版（release flavor）
npm run dist:win:debug -w @tandem/desktop  # 调试版（debug flavor）
```
发布版产物：`packages/desktop/dist/Tandem-Setup-<版本>-x64.exe`，同时生成 `latest.yml` 与 `.blockmap`，可直接放到内网静态目录作为更新源。调试版产物：`Tandem-Setup-<版本>-debug-x64.exe`。两者同一个 `appId` 与安装目录，**不能同时安装**，安装另一个会覆盖。

### 版本发布
```bash
node scripts/release.mjs 0.2.0 --dry-run   # 查看将要修改的文件与 CHANGELOG
node scripts/release.mjs 0.2.0             # 统一版本号、写 CHANGELOG/导览、提交并打本地标签
```
只创建本地标签，不 push。详见 `docs/features/release.md`。

### 桌面自动更新（内网）
`npm run dist:win` 产出的 `latest.yml`、安装包与 `.blockmap` 放到任意内网静态目录；桌面端在「设置 → 通用 → 桌面更新」填更新源（HTTP 地址或共享目录路径），留空即关闭、不发起任何请求。发现新版本会后台下载，完成后提示「新版本 x · 重启以更新」。

也可以让 Host 托管：在「设置 → 通用 → Host 托管更新文件」填一个本机目录，Host 会公开 `/updates/` 静态路径（仅启用时）。未签名的 SmartScreen 影响、签名选购与上架材料见 `docs/features/release.md`。

### 远程连接
见 `docs/workstation.md`（工作站 + 进程内主机上下文；客户端只连工作站）。

## 数据
工作站数据在 `~/.tandem`（可用 `TANDEM_HOME` 覆盖）：`accounts.json`（账号/主机登记/私钥）、`profiles.json` + `profiles.key`（账号级模型账号，加密）、`model-usage.json`；本机主机上下文在 `local-host/`，执行器主机在 `remote-hosts/<hostId>/`。Claude Code / Codex 的会话只读，不会被修改。

## 反馈（仅调试版）
调试版按 `Ctrl/Cmd + Shift + F` 进入反馈模式；采集内容、`.tfb` 包结构、解包/回执命令、演示工作区与体验清单见 [docs/features/feedback.md](docs/features/feedback.md)。
