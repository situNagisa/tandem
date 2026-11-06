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
```

## 打包
### 安卓 APK
```bash
# 环境变量可选：缺省 JAVA_HOME=/usr/lib/jvm/java-21-openjdk，ANDROID_HOME=~/Android/Sdk
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=$HOME/Android/Sdk
npm run apk -w @tandem/mobile
```
脚本会构建 web → `cap sync android` → `gradlew assembleDebug`，产物在 `dist-apk/tandem-debug.apk`（WSL 下同时复制到 Windows「下载」目录）。用 Android Studio 调试：`npm run open -w @tandem/mobile`。

### Windows 安装包
```bash
npm run dist:win -w @tandem/desktop
```
产物：`packages/desktop/dist/Tandem-Setup-<版本>-x64.exe`。

### 中继
见 `docs/relay.md`（Docker + Caddy 一键部署：`deploy/relay/install.sh`）。

## 数据
Host 数据在 `~/.tandem`（可用 `TANDEM_HOME` 覆盖）：`config.json`（hostId、token）、`profiles.json`（Key，权限 600）、`sessions/`、`checkpoints/`、`mcp.json`、`hooks.json` 等。Claude Code / Codex 的会话只读，不会被修改。
