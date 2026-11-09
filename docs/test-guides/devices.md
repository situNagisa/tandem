# 工作站与设备共享：真实设备代测步骤

> 更新：2026-11-09。

> 给产品所有者：在**你自己的两台 Windows 机器 + 一台安卓手机 + 一块 USB 串口板**上验证。
> 全程只用公司内网 / 你自己的局域网；不要做端口映射、反向代理或公网隧道。测试前确认两台机器能互相 `ping`，且防火墙允许 Tandem 端口（默认 7878，或你添加 Host 时看到的端口）。

## 1. 准备

**A 机（插设备的那台；Windows）**
- 安装同一版 Tandem 桌面端，启动 Host。
- 安卓手机：开发者选项 → USB 调试；USB 连接后 `adb devices -l` 能看到 `device`（先装 Google platform-tools 并接受手机授权弹窗）。
- USB 串口板：装好驱动（CH340 / CP210x / FTDI 等），在「设备管理器 → 端口」看到 `COMx`；用串口助手确认能收发。
- 如 `adb` 不在 PATH：给 Tandem Host 设置环境变量 `TANDEM_ADB_BIN=C:\platform-tools\adb.exe` 后重启 Host；或在 Host 的 `config.json` 写 `"devices":{"adbPath":"C:\\platform-tools\\adb.exe"}`。
- 记下 A 的局域网地址与 Host 端口，例如 `http://192.168.1.20:7878`。

**B 机（写代码/跑会话的那台；Windows 或另一台）**
- 安装 Tandem，添加 Host：A 的地址 + A 的主 token（「设置 → 主机」或 Host 启动日志里的 `?token=`）。
- 打开 B 上的一个会话（任意项目目录）。

**手机（可选）**
- 手机浏览器打开 B 的 Tandem 地址，或用安卓 App 连 B，登录同一会话；用于看串口实时输出。

## 2. 用例与预期

| # | 操作 | 预期 |
|---|---|---|
| 1 | B 的侧栏底部点「工作站」 | 弹层按 Host 分组：A 下能看到安卓设备（序列号/型号）、串口 `COMx`；B 下能看到 B 自己的设备（若有）。每行有状态点与「挂到当前会话」。 |
| 2 | 在 A 的设备行点「挂到当前会话」 | 约 1 秒内出现「已挂载」；会话输入框上方环境条出现设备胶囊；A 的设备行显示占用/来源。 |
| 3 | B 的会话里让 agent 执行 `DeviceList` | 审批卡出现（设备操作默认需审批）；允许后返回已挂载设备与 A 的主机名。 |
| 4 | 让 agent `AdbShell {device:"adb:<序列号>", command:"getprop ro.product.model"}` | 审批后返回手机型号；再执行 `pm list packages` 能看到包名。 |
| 5 | 把 APK 放到 **A 机**（例如 `C:\work\app-debug.apk`），让 agent `AdbInstall` 该路径 | 审批后返回 `Success`；手机上出现/更新应用。注意 v1 APK 路径必须在 A 上，不能填 B 的路径。 |
| 6 | 让 agent `AdbLogcat {device:"adb:<序列号>", tags:"*:E"}` | 审批后返回 stream id 与启动日志；「后台任务」面板出现运行中的 logcat，可查看/终止。 |
| 7 | 在 A 的串口行点「终端」（或在环境条点设备胶囊） | 串口终端打开，出现板子启动日志；波特率正确（默认 115200，可改后点重连）；时间戳/搜索/暂停滚动/保存日志可用。 |
| 8 | 终端发送 `help\n` 或在会话里让 agent `SerialWrite` | 板子收到并回显；终端实时出现。若另一个会话已独占该串口，再打开会提示被占用；勾选共享只能读、写入会报错。 |
| 9 | 手机打开同一会话 | 能看到环境条设备胶囊与串口终端，输出实时滚动，能发送。 |
| 10 | 卸载设备 / 关闭会话 | 终端关闭、锁释放；工作站该设备的「已挂载」标记消失。 |
| 11 | 断开手机 USB 再执行 `DeviceList` | 设备变为 offline / 不在列表；操作给出可读错误，不崩溃。 |

## 3. 需要回传什么

每条用例请回传：**通过/失败、截图（工作站、审批卡、终端）、以及失败时的原文错误**。另外附：
- A、B 的 Tandem 版本与 Windows 版本；
- A 上 `adb devices -l` 的输出、设备管理器里串口的端口名；
- A 的 `%USERPROFILE%\.tandem\devices\audit.jsonl` 最近 20 行（只含时间/会话 id/设备/操作/命令摘要，不含 Key）；
- 若 B 连不上 A：`ping`、`Test-NetConnection <A> -Port <端口>` 的结果，以及 B 的 Host 日志里与 `设备 Host 返回` 相关的行。
- 若串口打不开：串口助手是否占用、驱动名、终端报错原文（是否 `Access denied` / `serialport 不可用`）。

## 4. 已知限制（v1）

- 跨机挂载要求**会话 Host 能直连设备 Host**。客户端只能经转发访问、Host 本身不可直连时，暂不能作为设备提供方。
- 跨机 APK 安装要求 APK 已在设备 Host 上；v1 不做 B→A 文件传输。
- 不做虚拟串口（pty/com0com）给本机其他程序；不做 scrcpy、无线 ADB 配对、USB 直通。
- 串口为文本/UTF-8 容错；二进制协议（如某些 bootloader 的 hex 帧）建议先用串口助手验证，v2 再支持 hex 视图。
- 两台 Host 之间的设备访问使用设备级令牌（`dvt_…`，只对 `/api/devices` 生效）；可在 A 的 `~/.tandem/devices/peers.json` 查看/删除，或调用 `DELETE /api/devices/peer-tokens/:id` 撤销。不要把这个令牌发到群里。
- 真实设备测试不接入公网；不要把 Host 或工作站暴露到公网。

## 5. 开发期自动验证（已跑）

- 假 adb（`devices/shell/install/logcat`）+ 内置虚拟串口（`TANDEM_MOCK_SERIAL=1`）起两台 Host（`8421/8422`）；
- B 的会话挂载 A 的 ADB/串口，agent 依次调用 7 个设备工具，8 次审批全部生效；
- 串口独占/只读共享、跨机读写、logcat 后台任务、设备令牌越权拒绝、工作站两主机设备同屏；
- Playwright 截图：`/tmp/devices-shots/`（工作站、串口终端、手机）；
- 回归：`node e2e/regression.mjs --only "工作站"`。
