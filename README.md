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

### Windows 安装包
```bash
npm run dist:win -w @tandem/desktop
```
产物：`packages/desktop/dist/Tandem-Setup-<版本>-x64.exe`。

### 中继
见 `docs/relay.md`（Docker + Caddy 一键部署：`deploy/relay/install.sh`）。

## 数据
Host 数据在 `~/.tandem`（可用 `TANDEM_HOME` 覆盖）：`config.json`（hostId、token）、`profiles.json`（Key，权限 600）、`sessions/`、`checkpoints/`、`mcp.json`、`hooks.json` 等。Claude Code / Codex 的会话只读，不会被修改。

## 反馈
在 Web 界面里按 `Ctrl/Cmd + Shift + F`，或打开「设置 → 外观 → 进入反馈模式」。鼠标悬停元素会显示橙色选框，点击即可写反馈（`Alt + 点击`选择父元素）；写完后点顶部浮条的「导出」，会下载 `tandem-feedback-YYYYMMDD-HHmm.json`，把它发给维护者即可。导出前条目保存在本机，刷新不丢；解包查看：

```bash
node scripts/feedback-unpack.mjs tandem-feedback-20260101-1200.json [outDir]
```

会得到每条的 `NN-元素截图.png`、`page-N.png` 以及汇总的 `feedback.md`。
