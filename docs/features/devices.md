# 设备共享（UI 中的「设备」面板）

> 更新：2026-11-11。

> 目标：所有机器都是 Host；插在某台 Host 上的手机（ADB）和串口板，挂到任意 Host 的会话里就能用。开发期只用假 adb 与虚拟串口，真实设备由产品所有者代测（见 `docs/test-guides/devices.md`）。

## 1. 三个场景

1. **A 机插手机，B 机写代码**：开发者在 B 的会话里说「把 build/app-debug.apk 装到手机上，然后看崩溃日志」。B 的 agent 调 `AdbInstall`（APK 在 B 的磁盘上，先传到 A？v1 限制见下）与 `AdbLogcat`，终端面板实时出日志。v1 要求 APK 路径在**设备所在 Host** 上；跨机传 APK 放 v2（可用现有文件上传/中转）。
2. **A 机插开发板，B 机调试固件**：B 的 agent `SerialOpen` 9600 打开板子，`SerialRead` 取最近 10 秒并过滤 `panic`，必要时 `SerialWrite` 发 `reset\n`；人在手机上的同一会话里看同一份串口输出。
3. **手机看实时串口**：串口面板是普通 Web 视图，手机浏览器/安卓 App 打开同一会话即可看输出、发命令；输出经 Host WS 推送，不经过第三方。

## 2. 概念

- **设备（Device）**：属于某台 Host 的资源。类型 `adb | serial`；标识 `adb:<serial>` / `serial:<端口路径>`；字段：名称、状态（online/offline/busy/error）、占用者（会话）、能力。
- **设备面板**：客户端聚合所有已添加主机的设备列表，按主机分组，一屏看见「哪台机器上插了什么、被谁占着」。入口在环境条已挂载设备 chip 与主机详情「设备」。ADB 与串口只是当前两种设备类型，概念保持开放。
- **设备挂载（Mount）**：会话对某设备的一次使用授权。挂载记录在**会话所在 Host**（B），包含设备标识、设备所在 Host 的地址与受限令牌、占用方式。会话跑在 B，也能使用 A 的设备。
- **设备服务**：每台 Host 的 `/api/devices` 暴露本机设备与操作；B 用设备级令牌（`dvt_…`，只对 `/api/devices` 生效、可随时撤销）访问 A，不使用 A 的主 token。

## 3. 方案取舍

### ADB：(a) 代理执行 vs (b) 转发 adb server

- **(a) 会话 Host 把操作代理到设备 Host 执行** `adb -s <serial> shell/install/logcat`：设备 Host 的 adb server 不外露；每个操作都经过 Tandem 的鉴权、审批、审计与占用锁；不依赖两端 adb 版本一致。
- **(b) 把 A 的 5037 端口经隧道暴露给 B，让 B 的本地 adb 直连**：实现省事、兼容任意 adb 客户端；但 adb server 本身**无鉴权**，能枚举和控制 A 上所有设备；跨机 TCP 隧道受网络拓扑限制；两端 adb 版本不一致时协议可能不兼容；日志/安装二进制流也绕过了 Tandem 审计。
- **v1 选 (a)**。代价是 B 不能直接跑 `adb` CLI；需要 Tandem 工具或 UI。以后若要让 B 上的 IDE / 本地脚本用 A 的设备，再做受限的 (b)（只监听回环、按会话签署临时端口、进程退出即回收）。

### 串口

- A 用 Node `serialport`（服务端依赖；加载失败时设备列表给出可读提示）打开串口，字节流进入 Tandem 的串口缓冲，经 WS `device_output` 推给客户端；提供 `SerialRead`（游标 + 时间窗 + 正则过滤）与 `SerialWrite`。
- **虚拟串口给其他机器的本地程序用**：Linux 用 pty（`openpty`），Windows 用 com0com 一对虚拟串口，把远端字节流桥接到本地。v1 **不做**，只在传输层预留接口；原因：驱动安装、权限、跨机重连语义复杂，且先用 Tandem 工具/面板验证需求。
- 传输层抽象 `SerialTransport`：`list/open/write/close`；v1 有 `MockSerialTransport`（`TANDEM_MOCK_SERIAL=1`，可自动化回归）与 `NodeSerialTransport`（真实 serialport；列端口与打开，失败给出可读错误）。
- **演示设备**（`packages/server/src/devices/demo.ts`）：演示工作区存在时，设备列表多出「Pixel 8（演示）」与「演示串口板（ESP32）」，标注 `demo: true`、界面显示「演示设备」。演示 adb 由内置脚本响应 `devices/shell/install/logcat`（不调用真实 adb），演示串口周期性输出板子日志，`help` / `status` / `reboot` / `read <sensor>` 有回显。清除演示工作区时一并摘掉挂载与设备；不依赖 adb / serialport，用于产品所有者自测工作站与串口终端。

## 4. Agent 工具与权限

| 工具 | 作用 | 审批 |
|---|---|---|
| `DeviceList` | 列出本会话可用设备（已挂载的远程/本机设备 + 本机未挂载设备） | 默认需审批 |
| `AdbShell {device, command, timeout?}` | 在设备上执行 `adb -s … shell` | 默认需审批；命令中有副作用时同样逐次审批 |
| `AdbInstall {device, apkPath}` | 安装 APK（路径在设备 Host 上） | **写操作，单独审批** |
| `AdbLogcat {device, filter?, streamId?}` | 启动后台 logcat 流；带 `streamId` 读新增输出 | 默认需审批；流复用后台任务列表 |
| `SerialOpen {device, baud, shared?}` | 打开串口并取得租约 | 默认需审批 |
| `SerialRead {device, since?, windowMs?, filter?, maxBytes?}` | 按游标/时间窗读缓冲 | 默认需审批 |
| `SerialWrite {device, data}` | 写串口 | **写操作，单独审批** |

- 所有设备操作默认 `requiresApproval`；写操作（install、SerialWrite、有副作用的 shell）在审批卡中显示完整命令/内容截断，不能借「允许一次」覆盖其他调用。
- **独占/共享锁**：串口默认独占（一个会话写、其他只读需显式 `shared`）；安装与串口写期间设备标记 busy 并显示占用者。锁带租约（串口 10 分钟心跳续期，断开会话/手动关闭即释放），避免僵尸占用。
- 设备操作写入 `~/.tandem/devices/audit.jsonl`（600 权限）：时间、会话、设备、操作、命令摘要；不含 Key/完整 APK 内容。

## 5. 界面

- **工作站**：侧栏底部「工作站」图标（也可在 Ctrl/Cmd+K 搜到）。Modal 内按 Host 分组，主机标题一行：名称、地址、右侧小字「ADB 未检测 · 串口 serialport」（悬停有完整路径）与刷新。设备行统一用 `ui/ListRow`（32px 单行）：类型图标、状态点、名称、`SERIAL`/`ADB` 小标签、行尾操作；名称与路径相同（如 `/dev/ttyS0`）时不重复显示路径；「挂到当前会话」用行尾图标按钮，悬停显示文字 tooltip，没打开会话时禁用并说明原因；已挂载的行尾显示终端/卸载图标与「已挂载」。
- **板载串口折叠**（反馈 #8-06）：Linux 上 `/dev/ttyS*`、`/dev/ttyAMA*` 这类板载/虚拟串口大多没有实际设备，默认折叠为「另有 N 个板载串口 ›」可展开；USB 串口（`ttyUSB*` / `ttyACM*` / `usbmodem*`，或带厂商、序列号的端口）与 Windows COM 口始终显示。判定在服务端 `isBuiltinSerialPort`，客户端只按 `DeviceInfo.builtin` 分组。
- **串口权限与占用**（反馈 #8-06）：Host 枚举时只读探测串口能否读写（Linux/macOS：`access()` + `dialout`/`uucp` 组归属，不打开端口、不重置 DTR）；Windows 列表阶段不探测。无权限/被占用的设备行显示「无权限」/「被占用」标签与「修复权限」按钮：展开该平台的说明与可一键复制的命令（Linux：`sudo usermod -aG dialout $USER` 后重新登录、临时 `sudo chmod a+rw /dev/ttyUSB0`、udev 规则；Arch 用 `uucp` 组；macOS：基本无需权限，占用时给 `lsof`；Windows：关闭占用程序），并明确「Host 不会自动执行 sudo」。「我已处理，重新检测」调用 `POST /api/devices/:id/access-check` 做深度检测（短暂打开端口），Windows 靠这一步判断 COM 口被占用，Linux 能查到占用进程（`/proc/*/fd`）并显示；串口打开失败时错误信息会附带原因与修复入口。
- **串口终端**：从工作站或环境条打开。顶部设备名/波特率/连接状态；实时输出（等宽、时间戳、自动滚底、暂停滚动）；搜索过滤；发送框（可切 CR/LF）；保存日志（浏览器下载 `.log`）；手机可看。
- **会话环境条**：主机/文件夹/分支之后显示已挂载设备小胶囊（`adb:…`、`serial:…`），点击打开串口终端或工作站。
- **演示画面**（反馈 #7-01）：演示设备挂到当前会话后，输入框上方出现「演示画面」卡片——安卓设备显示模拟屏幕（状态栏、应用图标、logcat 节拍），串口板显示自动滚动的启动日志与心跳；可收起，不依赖真实设备。
- **安装说明按系统分段**（反馈 #7-01 / #9-02）：工作站里 adb / serialport 缺失时给出「如何安装 / 设置路径」。展开后顶部是共享 `ui/SegmentedControl` 的 Windows / macOS / Linux 单选（默认 Host 平台），Linux 再按 Debian/Ubuntu、Arch、Fedora 二级切换；下方按编号步骤（安装组件 → 驱动/权限 → 设置路径）排列，命令放共享 `CodeBlock`（复制按钮常显、支持自动换行），路径用等宽字体。Windows 用 winget / 设备管理器，macOS 用 Homebrew `android-platform-tools` 与系统串口驱动，Linux 用 apt/pacman/dnf、`plugdev`/`uucp`/`dialout` 组与 udev 规则。
- 复用 `components/ui/*`（Modal/Button/Menu/Tooltip/Controls）；不手写菜单或原生 select。

## 6. 安全

- 设备共享按账号角色：所有者与协作者可挂载/操作；观察者只读列表与日志；设备级令牌只在 `/api/devices` 生效，吊销后立即失效。
- Host 之间只走内网/回环（v1 不做 TLS，与其他内网功能一致的边界）；**禁止公网暴露**，不接第三方云。
- 跨机挂载要求会话 Host 能直连设备 Host（同一内网/VPN）。客户端只能经转发访问、Host 本身不可直连时，v1 不能作为设备提供方被另一台 Host 访问（文档明示）。
- 所有远程调用校验设备存在、会话可见、锁归属；串口写入只接受已持有租约的会话；审计可查。

## 7. v1 范围与以后

**v1 做**：本机 ADB/串口枚举；工作站视图；跨 Host 挂载（设备级令牌）；7 个工具；审批/串口独占锁/审计；串口终端面板；WS 实时输出；假 adb 与 mock 串口回归；`docs/test-guides/devices.md` 真实设备代测步骤。

**v1 不做**：跨机传 APK；虚拟串口给本地程序；scrcpy/屏幕镜像；无线 ADB 配对；USB 直通/热插拔事件推送；临时 adb server 转发；TLS/mTLS；设备分组与配额；观察者写设备。

**以后**：APK 上传到设备 Host；WS 二进制串口帧（当前文本/hex 混用按 UTF-8 容错）；虚拟串口；设备热插拔与「拔掉自动释放锁」；按角色/成员细粒度设备 ACL；SFTP/SCP 把固件送到 A 再刷写。
