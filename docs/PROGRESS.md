# 进度

> 更新：2026-11-09。只保留最近 5 轮；更早记录见 [archive/progress/2026-11.md](archive/progress/2026-11.md)。每轮结束更新这里并删除超出的旧轮次。

## 迭代 59（2026-11-09）反馈包 #10：大纲懒加载 / 切换确认 / Key / 原生下拉 / 行高
- [x] #01 R40（新）：`TurnRail` 跳转先按需取段并扩大渲染窗口，等消息挂载后再滚动 + 高亮（失败给提示）；滚轮改为 `RailScene.scrollBy` 预览式滚动，不改选中轮、不滚动对话区
- [x] #02 R41（新）：删除模型菜单常驻缓存提示与「不再提示」，选中新模型/账号/分组/自动路由时弹 `ui/ConfirmAction`（约 x tok / $x，切换/取消）
- [x] #03 R14（复发）：删除会话信息面板底部「显示空分组」开关，改面板顶部 ⋯ 菜单逐个勾选；`PanelPrefs.shown[]` 记住显式显示的空分组
- [x] #04 R43（新）：`lib/modelSelection.ts` 解析系列/版本/日期快照，拉取模型默认只勾选每系列最新；手动改过后再次拉取只对新模型应用规则；单测覆盖
- [x] #05 R42（新，P0）：分组 Key 编辑改为掩码占位 + 「更换 Key」，不回传明文；服务端缺省/空串/掩码回传都不覆盖；单测 `profile-keys.test.ts`
- [x] #06 R37/R01（复发）：新增 `ui/Combobox`，迁移单价覆盖与预算模型输入；ui-audit 禁止 `<datalist>` 与 `list=`
- [x] #07 R44（新）：`ui/Menu`/`ui/Button`/`ui/SegmentedControl` 行高统一 ≥1.4，去掉 `leading-none`；ui-audit `clipped-line-height` + 回归测量
- 验证：`node scripts/check.mjs` 全过；回归新增/更新 5 条（大纲滚轮与点击、账号编辑、菜单行高、缓存切换、空分组菜单）；截图 `/tmp/fb10-after/`
- 根因：R40–R44 新增，R14/R37/R01 复发走共享层 + ui-audit/回归防线

## 迭代 58（2026-11-09）发布 v0.4.3：反馈实时落盘 / .tfb 包
- [x] 反馈编辑即落盘：IndexedDB（元数据与图片 Blob 分开）为主、localStorage 镜像文字；刷新/崩溃/关页面重开提示「已恢复 N 条」并继续追加；桌面调试版经 IPC 实时写 `<下载>/Tandem 反馈/草稿-YYYYMMDD-HHmm/`（临时文件 + rename，删条目同步清掉旧编号文件），导出后写 `.exported.json`、草稿保留 7 天、未导出一直保留
- [x] 导出 `.tfb`（零依赖 zip store，`zipStore.ts`；改扩展名可解压），桌面调试版导出后可「打开所在文件夹」；`feedback-unpack.mjs` / `feedback-receipt.mjs` 兼容 tfb、旧 json 与草稿目录；发布产物扫描补禁用词
- [x] 0.4.3 导览 3 条（debug 专属：边写边存重开恢复 / 桌面实时写成文件 / .tfb 包可解压），id 挂到 `features.ts` 反馈模式
- [x] `node scripts/release.mjs 0.4.3`：版本与 lockfile 同步、CHANGELOG 生成、本地标签 v0.4.3（未 push）
- 验证：发布前后各跑一次全量 `node scripts/check.mjs` 均通过（回归 134 条）；顺带修「反馈9 滚动条」用例（改 scrollBy 并等到覆盖滚动条出现，消除偶发）
- 产物：`Tandem-Setup-0.4.3-x64.exe`、`Tandem-Setup-0.4.3-debug-x64.exe`、`tandem-release.apk/.aab`、`tandem-debug.apk`、`latest.yml`（指向 0.4.3 发布版），均在 Windows「下载」
- 保守取舍：桌面调试版落盘与关窗恢复需 Windows 实测（WSL 无法启动 Electron）；`.tfb` 不压缩、不加密

## 迭代 57（2026-11-09）发布 v0.4.2：手机预览工具栏 / 新功能导览
- [x] 调试版手机预览顶栏改为独占 30px 区域：`.app-root` 高度扣减并在顶部留白，全屏浮层（侧栏抽屉、全屏面板、对话框遮罩）统一 `top: var(--preview-bar-height)`，抽屉标题不再被遮；回归断言抽屉标题与顶栏不相交且完整在抽屉内
- [x] 0.4.2 导览 8 条手写条目（消息耗时、调试版手机预览、调试版免登录、屏蔽浏览器控件/覆盖滚动条/右键菜单、设置页紧凑、外部会话大纲与信息面板、安装说明按平台切换、信息面板隐藏空分组）；调试版专属两条走 `__TANDEM_DEBUG__` 常量分支，发布产物扫描通过；id 已挂到 `features.ts`
- [x] `node scripts/release.mjs 0.4.2`：版本与 lockfile 同步、CHANGELOG 生成、本地标签 v0.4.2（未 push）
- 验证：发布前后各跑一次全量 `node scripts/check.mjs`；产物 `Tandem-Setup-0.4.2-x64.exe`、`Tandem-Setup-0.4.2-debug-x64.exe`、`tandem-release.apk/.aab`、`tandem-debug.apk`、`latest.yml`（指向发布版）
- 保守取舍：Electron 桌面触摸模拟仍无法在 WSL 实测，等用户 Windows 代测

## 迭代 56（2026-11-09）反馈包 #9：外部会话预览 / 安装说明分段 / 空分组
- [x] #01 R38（新）：`TurnRail` 支持传入只读消息与虚拟会话 id，外部会话预览复用同一大纲（上下文着色、Alt 只看已固定、用量/耗时 tooltip；只读隐藏图钉、无价格不显示「花费未知」）；新增 `ExternalSessionPanel` 复用 `Card`/`DetailRow`/`ContextSpaceSection`/`PanelBar`/`ResizeHandle` 与同一宽度偏好；服务端外部解析补 `model` 与 `usage`（Claude / Codex）
- [x] #02 R06（复发）：设备安装说明改为顶部 `ui/SegmentedControl` 系统分段（默认 Host 平台），Linux 再按 Debian/Ubuntu、Arch、Fedora 二级切换；步骤编号、命令走共享 `CodeBlock`（复制常显）、路径等宽；`CodeBlock` 增加 `toolsAlwaysVisible`
- [x] #06 R14（复发）：会话信息面板按数据可用性隐藏空分组（含新会话上下文）；新分组 180ms 淡入，插入/删除保持滚动锚点；底部「显示空分组」开关持久化到 `PanelPrefs`
- 验证：单测 `external.test.ts`（Claude/Codex usage 换算）；回归新增「外部会话预览…」「会话信息面板：空分组…」并更新「工作站：主机没装 adb…」为分段 + 代码块断言；截图 `/tmp/fb9-after/01.png`、`02.png`、`06.png`
- 根因：R38 新增，R06/R14 复发走共享层 + 回归防线

## 迭代 55（2026-11-09）反馈包 #9：浏览器自带控件 / 滚动条 / 设置密度 / 高级分组
- [x] 全局屏蔽（R37 新）：Electron `spellcheck:false`；`AppContextMenu` 用 `ui/Menu` 接管右键（复制/剪切/粘贴/全选/链接与图片地址），主进程 IPC 读写剪贴板；`writingsuggestions=false`、`-webkit-touch-callout:none`、format-detection、链接/图片无拖拽 ghost、输入框 autocomplete/autocorrect/spellcheck 默认关（密码框除外）、数字箭头隐藏；原生 title 批量迁移 `data-tip` 并由 `ui/Tooltip` 统一展示；Edge 划词迷你菜单只能由 Edge 设置/组策略 `QuickSearchShowMiniMenu` 关闭（已在 design.md 说明）
- [x] #04 R36（新）：原生滚动条全局隐藏（含 Portal 弹窗），唯一 `ui/OverlayScrollbar` 覆盖式横竖双轴、不占布局宽度、无箭头、滚动/悬停淡入、停止 800ms 淡出；设置导航只保留内层一个滚动容器；ui-audit 新增 `custom-scrollbar`
- [x] #05 R01（复发）：新增 `ui/SettingRow`/`ui/SettingSection`；设置卡片/行距统一收紧，标签在左控件在右，数值窄宽，`%`/`轮原文`/`tokens` 紧贴输入框不再换行，长说明进标题旁 ⓘ tooltip；通用设置与通知设置已迁移
- [x] #03 R10（复发）：高级分组移入滚动列表，不再固定在底部；展开时补偿滚动位置，点击位置不动
- 验证：`node scripts/check.mjs --skip-smoke`（build/docs/ui-audit/test 通过；新增回归「反馈9」通过；全量回归仅剩并行同事 #02 工作站安装说明改版导致的 1 条旧用例，与本批无关）；截图 `/tmp/fb9-after/`
- 根因：R36/R37 新增，R01/R10 复发走共享层 + ui-audit/回归防线

## 迭代 54（2026-11-09）消息耗时 / 调试版手机预览
- [x] 消息耗时：协议 `Message.durationMs / ttftMs / toolDurationMs`（可选）；服务端每次请求记开始到流式完成（含重试）与首 token，工具批次单独记耗时；assistant 用量行末尾 `· 12.3s`，流式实时计时，旧消息无字段不显示；轮次大纲 tooltip 追加「耗时 …，其中工具 …，首 token …」；单测 `timing.test.ts`/`turnUsage.test.ts`/`format.test.ts`，回归两条（种子数据展示 + 真实发送落库）
- [x] 手机预览（调试版）：桌面独立窗口按预设加载同一 Host，CDP 触摸模拟/移动 UA/DPR、强制移动布局、旋转、模拟键盘；命令面板 + `Ctrl/Cmd+Shift+M` + 菜单/托盘；浏览器版弹窗并提示无触摸模拟；Capacitor 原生能力走桩；反馈 `platform=mobile-preview`；`MobilePreviewBar` 模块按 `__TANDEM_DEBUG__` 剔除
- [x] 真机调试：调试 APK 用 `BuildConfig.DEBUG` 开启 `WebView.setWebContentsDebuggingEnabled`；新增 `docs/test-guides/mobile-debugging.md`（chrome://inspect、scrcpy 使用说明，不打包第三方工具）
- [x] 发布剔除：release 扫描新增 `手机预览`/`MobilePreview`/`mobile-preview`/触摸 CDP 标识；桌面按 `resources/flavor.txt` 只在 debug 注册 IPC/菜单；`release-flavor` 回归覆盖 `?mobilePreview=1` 不渲染顶栏
- 验证：`node scripts/check.mjs`；截图 `/tmp/dbg-after/`（message-duration、mobile-preview、mobile-preview-keyboard、mobile-preview-drawer）
- 保守取舍：Electron 运行时在本机 WSL 缺 GTK 无法启动，桌面触摸链路未做本机运行时验证（代码通过语法检查、浏览器版回归通过）；真机/桌面触摸请按测试指南代测

## 迭代 52（2026-11-09）工作站改为客户端-服务模式
- [x] 设计：`docs/workstation.md`（工作站服务/主机两个可独立角色；客户端只填工作站地址；登录 ≠ 添加主机；绑定码/主机侧登录/本机一键；出站隧道 + E2E；默认开放注册、首个管理员、只看自己主机、按主机授权；旧工作区迁移；本地模式保留；v1 边界与部署）
- [x] 协议：`WorkspaceRole` 增 `member`、`WorkspaceHostGrant`、`WorkspaceHostInfo.ownerId/publicKey/fingerprint/online/grants`、`WorkspaceStatus.role/registration`、`Workstation*`（status/setup/register/bind-code/claim/register/grant/settings/invite）与 `/api/workstation/*` 约定
- [x] 服务端：`src/accounts/store.ts` 扩展为工作站（初始化/开放或邀请注册/绑定码/主机登记/逐主机授权/可见主机/逐主机令牌声明）；旧 center/member 数据自动迁移（中心 Host 变工作站、已加入 Host 归管理员、旧 scope→grant）；`src/workstation/server.ts` 独立 Fastify（静态 UI、账号 API、`/_tunnel` 出站隧道、`/h/<id>/_e2e/*` 转发，拒绝明文路径）；`workstation/manager.ts` 桌面内嵌启动（独立数据目录、8481 起顺延）；`tandem-host workstation` 与 `tandem-host join <url> --code`；Host 侧复用 RelayAgent（requireE2E）并在加入后即时连出
- [x] 前端：首次引导（填工作站地址/创建/登录/注册/本机一键启动）、登录后自动生成 `工作站/h/<hostId>` 的 E2E 主机、侧栏账号登录入口、设置「成员与分享 → 工作站」我的主机/绑定码/授权/退出；复用 ui/ 原语，ui-audit 0
- [x] 验证：工作站 8481 + h1/h2（8482/8483，mock provider）；alice（首个管理员）添加两台、全新客户端登录看到两台并在 h1 收到经工作站转发的流式回复；bob 默认 0 台，授权 h2 后只看到 h2；撤销授权立即消失；只访问 8481；旧工作区数据迁移；本机内嵌工作站 + 添加本机；本地模式 smoke 不变；Playwright 截图 `/tmp/ws-shots/`（01–07）
- [x] 回归：`e2e/workstation-check.mjs`（注册/绑定/授权/E2E 流式/撤销）接入 `e2e/regression.mjs`；工作站设备旧用例仍通过；全量回归 111/116（余 2 条为并行同事未完成的轮次置顶与模型参考价，与本功能无关）
- 文档：设计 `docs/workstation.md`；个人/团队代测 `docs/test-guides/workstation.md`；Docker `deploy/workstation/Dockerfile`
- 保守取舍：工作站只转发 E2E，明文 `/h/*` 一律 403；管理员不隐式获得他人主机会话；授权角色只开放 协作者/审批者/观察者（不通过界面授予 owner）；v1 不做多工作站联邦、TLS、LAN 自动直连、自动迁移主机

## 迭代 47（2026-11-08）工作站与设备共享 v1（ADB + 串口）
- [x] 设计：`docs/features/devices.md`（场景、设备/工作站/挂载概念、ADB 代理执行 vs 5037 转发取舍、串口传输层、工具与权限、界面、安全、v1 边界）；`docs/test-guides/devices.md` 给产品所有者真实设备代测步骤
- [x] 协议：`DeviceInfo/DeviceListResult/DeviceMount/DeviceSessionDevices/SerialOpenResult/SerialReadResult/DeviceLogcat*`、`DeviceSettings`、WS `device_output/devices_updated` 与 `/api/devices*`、`/api/sessions/:id/devices*` 约定
- [x] 服务端 `src/devices/`：`adb.ts`（devices/shell/install/logcat，可配置 `TANDEM_ADB_BIN` 或 `devices.adbPath`）、`serial.ts`（`SerialTransport` 抽象、Mock 虚拟串口、可选 serialport 真实端口枚举/打开）、`manager.ts`（设备级令牌 `dvt_` 只对设备服务生效、跨 Host 挂载与代理、串口独占/只读共享锁 + 10 分钟租约、WS 字节流、后台 logcat 复用任务、`~/.tandem/devices/audit.jsonl` 审计）；`routes/devices.ts`；`tools/device.ts` 7 个工具全部默认审批（install/SerialWrite 独立写审批）
- [x] 前端：侧栏「工作站」、按 Host 分组设备/状态/占用/一键挂载/卸载、跨主机自动签发设备令牌；串口终端（实时输出、时间戳、搜索、暂停滚动、波特率重连、保存日志、手机可用）；环境条已挂载设备胶囊；`useDevicesStore` 接 WS
- [x] 验证：两台 Host（`/tmp/tandem-dev-a:8421`、`/tmp/tandem-dev-b:8422`，假 adb + `TANDEM_MOCK_SERIAL=1`）；B 会话挂载 A 的 ADB/串口，agent 依次调用 DeviceList/AdbShell/AdbInstall/AdbLogcat×2/SerialOpen/SerialRead/SerialWrite，8 次审批、跨机 shell 型号、install Success、logcat 后台流、串口读写；串口独占拒绝/共享只读、设备令牌越权 403；Playwright 截图 `/tmp/devices-shots/`（工作站桌面/手机、串口终端）
- [x] 回归：`e2e/regression.mjs` 新增「工作站：跨主机 ADB/串口挂载、审批与终端」；全量 94/94 通过；新增 server 单测（adb 解析、虚拟串口启动/echo/reset）
- 保守取舍：跨 Host 要求会话 Host 能直连设备 Host（SSH 隧道-only 主机暂不能做设备提供方）；跨机 APK 必须在设备 Host 上，v1 不做文件传输；不做虚拟串口/scrcpy/无线 ADB；串口为文本/UTF-8 容错；设备令牌明文只返回一次


## 迭代 48（2026-11-08）账号制工作区 v1（多机一次登录、按账号授权）
- [x] 设计：`docs/accounts.md`（工作区=互信 Host 组；账号中心由一台 Host 兼任；一次性加入码交换 Ed25519 公钥；访问 30 分钟/刷新 7 天，中心离线时已签发访问令牌仍有效；角色×范围；吊销签名快照推送+10s 轮询；现有 token 全部保留与迁移路径；v1 边界）
- [x] 协议：`Workspace*` / `AccountLogin*` / `AccountTokens` / `AccountMe` / `WorkspaceAuditEntry`；`TeamIdentity` 增加账号信息；`/api/accounts*` 约定
- [x] 服务端 `src/accounts/store.ts`：中心/加入方两种模式（`~/.tandem/accounts.json` 600）；scrypt 密码 + 可选 TOTP（内置 HMAC-SHA1）；Ed25519 紧凑令牌；刷新令牌一次性轮换；一次性加入码；账号角色×范围（全部机器/指定机器/指定项目）；吊销快照中心签名、主动推送 + 加入方 10s 轮询；`routes/accounts.ts`；`server.ts` 把 `acw_…` 接成第四种凭据；账号令牌可用于设备服务与网关（按账号记账）
- [x] 前端：登录页（中心地址+用户名+密码/TOTP）、登录后自动写入全部可访问 Host 并选中、访问令牌到期前自动刷新；侧栏底部账号菜单（工作区管理/退出）；设置「成员与分享 → 工作区」创建/加入工作区、生成加入码、Host 列表、账号新建/改角色/吊销；复用 ui/ 原语，ui-audit 0
- [x] 验证：A/B/C 三个 Host（`TANDEM_HOME=/tmp/tandem-acc-a/b/c`，端口 8441/8442/8443），A 为账号中心，B/C 用加入码加入；所有者全新客户端登录后看到三台机器；协作者只拿到 B 且只看到授权项目会话；观察者读 200、建会话/WS 发消息 403；吊销后 B/C 立即 401 并断 WS；中心停机时已签发令牌在 B/C 仍可用、刷新失败；单机主 token 不受影响；Playwright 截图 `/tmp/accounts-shots/`
- [x] 回归：`e2e/regression.mjs` 新增「账号制工作区」API 用例（中心+第二台 Host 加入、范围、观察者 403、刷新轮换、吊销推送、单机 token）；`docs/accounts-test.md` 多机代测步骤
- 保守取舍：v1 单账号中心（无备用/多中心同步）；无 LDAP/SSO/TLS；账号中心管理页只给工作区所有者，管理员可管理范围内 Host 设置但不能改账号；项目范围按 Host 绝对路径；跨 Host 设备挂载仍用 `dvt_`；网关仍以 `tgw_` 为主、账号令牌可直接调用并按账号记账

## 迭代 49（2026-11-08）自用测试 v2 修复：R13/R14/R15/R16/R08
- [x] R13 复发：新增 `ui/AggregateRow`（行主体导航、右侧独立箭头展开、明细条可跳工具卡）；回合结束事件带 `messageId`，打开会话后定位到该轮；看板卡片回合写 `silent` turn_end（只进历史聚合、不计未读/通知），修复「长期回合进行中」
- [x] R14 复发：新增 `ui/Panel` 统一侧面板「顶部工具条 + 可伸缩贴顶内容区」，预览/改动审阅/文件预览/Wiki/浏览器面板共用；改动审阅文件列表按内容高度封顶；DiffView 增加「自动换行」开关
- [x] R15 新根因：轮次大纲改为真实文本节点 + 悬停全文浮层 + `sr-only` 全文列表；审批描述/收件箱/看板卡/侧栏会话标题补 `title`；手机审批描述默认两行、点按展开
- [x] R16 新根因：`@tandem/protocol` 新增 `countTurns`/`isUserTurnMessage`，压缩确认、轮次大纲、评测、上下文面板统一按真实用户消息计轮
- [x] R08 复发：手机环境条改横向滚动胶囊，显示文件夹名、分支名与 Worktree 文字（截断带全文提示）；反馈工具栏手机端移到顶部；模型菜单内置价显示「参考价」
- [x] 反馈根因建议：收紧 R03（只在文字/元素确有浮层越界证据时建议），新增 R14/R15 规则
- [x] 回归：`e2e/regression.mjs` 补收件箱导航/明细跳转、看板回合收敛、改动审阅布局与自动换行、大纲全文、手机审批展开、手机环境条、反馈工具栏、参考价、真实轮次；单测覆盖 R03 噪音、轮次口径与 silent turn_end
- 验证：全量 `node scripts/check.mjs` 通过（100/100 回归）

## 迭代 50（2026-11-08）发布 v0.3.0
- [x] 新功能导览 0.3.0：10 条手写条目（工作站设备共享、工作区账号、预览侧面板、收件箱按回合聚合、危险操作统一确认、看板完成态后续操作、轮次大纲悬停全文、手机环境条、模型参考价、反馈按功能/根因归类）；新增 `workstation` 导览目标；`features.ts` 新增工作站/工作区账号/环境条三项并补 8 条测试要点
- [x] `node scripts/release.mjs 0.3.0`：版本与 lockfile 同步、CHANGELOG 生成、本地标签 v0.3.0（未 push）
- 验证：发布前后各跑一次全量 `node scripts/check.mjs`，均通过（100/100 回归）
- 产物：`tandem-release.apk` / `.aab`、`tandem-debug.apk`、`Tandem-Setup-0.3.0-x64.exe` / `.blockmap` / `latest.yml`，均已复制到 Windows「下载」

## 迭代 51（2026-11-08）分工路由 v2
- [x] 设计：`docs/features/routing.md`（子代理分工、缓存成本账、直接做/便宜直做/分工、不分工清单、人工选择与确认、领域专长、预设）
- [x] 协议：`routeMode/routePreference/RoutePlan/DivisionPlanRequest`、Task `role/domain`、用量 `role/routeSavedUsd`、角色节省
- [x] 服务端：规则分类零额外模型调用；主会话模型不变；Task 角色解析到分工绑定；便宜直做跳过主模型；失败回退；成本上限阻止继续派发；确认卡（改模型/删子任务/直接做/便宜直做）与收件箱；子代理换模型重跑/主会话接管；按领域学习覆盖
- [x] 前端：模型菜单「分工」；输入框执行方式（自动/直接/便宜/分工 + 本会话保持）；每任务提示行与一键偏好；确认卡；子代理操作菜单；设置-模型路由角色/领域/预设/确认/成本/学习偏好；用量按角色与节省
- [x] 验证：mock 回归「分工路由」（直接做零派发、便宜直做、专长分工、缓存命中、确认卡改模型/删任务、收件箱、成本上限、学习偏好）；截图 `/tmp/route2-shots/`；真实账号冒烟 gpt-6-sol 规划 → gpt-6-luna 执行（≤20 次请求）
- 文档：设计 `docs/features/routing.md`；未做结构化子任务自动并行/跨任务预算/自动验收（列为后续）
