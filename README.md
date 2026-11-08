# Tandem

类 Claude Code Desktop 的 agent 工作台：Host 守护进程跑在每台机器上执行 agent；Web / 桌面 / 安卓客户端连接任意多台 Host，多端实时协同；每个会话可用不同账号、分组与模型（Anthropic / OpenAI / 兼容接口 / Gemini）。

## 目录
| 包 | 作用 |
|---|---|
| `packages/protocol` | 客户端与 Host 共享的类型（唯一契约） |
| `packages/server` | Host 守护进程（REST + WebSocket、agent 循环、工具、权限、MCP、hooks） |
| `packages/web` | React 客户端（也被桌面端和 App 复用） |
| `packages/desktop` | Electron 桌面端（内置 Host） |
| `packages/mobile` | Capacitor 安卓 App |
| `packages/relay` | 可自托管中继（不在同一局域网时连接，端到端加密） |
| `docs/` | 计划、进度、设计规范、评审、打分卡 |

## 环境
- Node.js ≥ 22（开发用 26）
- 安卓打包另需：JDK 21、Android SDK（含 platform-tools、对应 platforms 与 build-tools）
- Windows 安装包在 Linux/WSL 上交叉打包即可（electron-builder）

## 常用命令
```bash
npm install                      # 首次
npm run build                    # 构建 protocol → relay → web → server
npm start                        # 启动 Host（默认 127.0.0.1:7878），终端打印带 token 的访问地址
npm start -- --host 0.0.0.0      # 允许局域网访问（手机连接需要）

npm run dev:server               # Host 开发模式（热重载）
npm run dev:web                  # Web 开发服务器（代理到 127.0.0.1:7878）
node scripts/ui-audit.mjs        # UI 原语防回退检查：ui/ 目录外的手写菜单/弹层/原生下拉（0 问题才通过）

npm test                         # 单元测试（server: node:test + tsx；web: vitest）
npm run smoke                    # Playwright 端到端冒烟（临时 Host + 假 provider，需先 build）
node scripts/check.mjs           # 提交前全量：build → ui-audit → test → smoke
```

## 打包
### 安卓 APK
需要 **JDK 21** 和 **Android SDK**（platform-tools、Capacitor 所需的 platforms 与 build-tools）。脚本会自动查找，找不到时提示缺什么。

```bash
npm install
npm run apk -w @tandem/mobile
```
构建 web → `cap sync android` → Gradle `assembleDebug`；产物 `dist-apk/tandem-debug.apk`，并复制到「下载」目录（Windows 本机或 WSL 下的 Windows 用户目录）。用 Android Studio 调试：`npm run open -w @tandem/mobile`。

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
首次会通过 `keytool` 在 `~/.tandem-release/` 生成 `android.keystore` 与 600 权限的密码文件（也可用 `TANDEM_ANDROID_KEYSTORE_PASSWORD` 环境变量提供密码），产出已签名的 `dist-apk/tandem-release.apk` 与 `.aab`，并用 `apksigner verify` 自动校验。签名材料不进仓库；**请离线备份 `~/.tandem-release`**，丢失后无法覆盖升级。debug 流程 `npm run apk -w @tandem/mobile` 不变。

### Windows 安装包
```bash
npm run dist:win -w @tandem/desktop
```
产物：`packages/desktop/dist/Tandem-Setup-<版本>-x64.exe`，同时生成 `latest.yml` 与 `.blockmap`，可直接放到内网静态目录作为更新源。

### 版本发布
```bash
node scripts/release.mjs 0.2.0 --dry-run   # 查看将要修改的文件与 CHANGELOG
node scripts/release.mjs 0.2.0             # 统一版本号、写 CHANGELOG/导览、提交并打本地标签
```
只创建本地标签，不 push。详见 `docs/release.md`。

### 桌面自动更新（内网）
`npm run dist:win` 产出的 `latest.yml`、安装包与 `.blockmap` 放到任意内网静态目录；桌面端在「设置 → 通用 → 桌面更新」填更新源（HTTP 地址或共享目录路径），留空即关闭、不发起任何请求。发现新版本会后台下载，完成后提示「新版本 x · 重启以更新」。

也可以让 Host 托管：在「设置 → 通用 → Host 托管更新文件」填一个本机目录，Host 会公开 `/updates/` 静态路径（仅启用时）。未签名的 SmartScreen 影响、签名选购与上架材料见 `docs/release.md`。

### 中继
见 `docs/relay.md`（Docker + Caddy 一键部署：`deploy/relay/install.sh`）。

## 数据
Host 数据在 `~/.tandem`（可用 `TANDEM_HOME` 覆盖）：`config.json`（hostId、token）、`profiles.json`（Key，权限 600）、`sessions/`、`checkpoints/`、`mcp.json`、`hooks.json` 等。Claude Code / Codex 的会话只读，不会被修改。

## 反馈
在 Web 界面里按 `Ctrl/Cmd + Shift + F`，或打开「设置 → 外观 → 进入反馈模式」。浮条上可切换「点选 / 框选」：点选元素（`Alt + 点击`选父元素），或按住拖拽框出任意区域（跨多个元素）。写反馈时可设置优先级 P0/P1/P2、`Ctrl+V` 粘贴或拖入参考图；截图可点开 Canvas 标注（矩形/箭头/画笔/文字/马赛克，橙白红三色，撤销重做）。

每条反馈自动附带：标注后的图与原图、参考图、反馈前 60 秒操作轨迹（点击选择器与文本、功能键/快捷键、路由、WS 断连、toast；不记录输入的文字）、脱敏状态快照（路由、会话摘要、UI 偏好、视口、Host 版本；可勾选附带最近 5 条消息正文，可隐藏本地路径）。支持录屏复现时，浮条「录制」通过 `getDisplayMedia` 本地录制（≤60 秒、≤8MB），作为下一条反馈的附件。

浮条「条目」打开右侧抽屉：缩略图、类型、优先级、文字，可编辑/删除/拖拽排序，点条目会在页面上高亮定位。

导出 `tandem-feedback-YYYYMMDD-HHmm.json` 发给维护者，条目保存在本机，刷新不丢。解包：

```bash
node scripts/feedback-unpack.mjs tandem-feedback-20260101-1200.json [outDir]
```

会得到每条的 `NN-元素截图.png` / `NN-区域截图.png` / `NN-标注截图.png`、`NN-参考-N.png`、`NN-录屏.webm`、`NN-轨迹.md`、`NN-快照.json`、`page-N.png` 以及汇总的 `feedback.md`。

维护者修复后写一份回执草稿（Markdown 或 JSON），生成回执：

```bash
node scripts/feedback-receipt.mjs tandem-feedback-20260101-1200.json receipt.md outDir
```

Markdown 草稿按条目写 `## fb-xxx`、`- status: fixed|wontfix|needs-info`、`- note: 说明`、可选 `- after: ./修复后.png`。生成的 `tandem-feedback-receipt-*.json` 发回给用户，在反馈抽屉「导入回执」后即可逐条查看状态与前后对比，并点「开始复验」按顺序跳转页面、高亮元素、标记「通过 / 仍有问题」，最后导出复验结果文件。

所有数据只在本机采集与导出，不上传任何第三方服务。
