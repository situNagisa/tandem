# 发布说明

本文覆盖版本号、安卓签名、桌面更新源与上架材料。所有签名材料只放在仓库之外，发布产物只进入本机 `dist-*` 目录或内网静态目录。

## 1. 版本与发布流程

```bash
node scripts/release.mjs 0.2.1 --dry-run   # 先看会改哪些文件、CHANGELOG 内容
node scripts/release.mjs 0.2.1             # 写文件 → 提交 → 打本地标签 v0.2.1
```

脚本会：

- 统一根目录与 `packages/*` 的 `package.json` 版本，内部 `@tandem/*` 依赖同步为同一版本，并更新 `package-lock.json`；
- 按 `feat / fix / perf / refactor` 从 git log 生成 `CHANGELOG.md` 对应版本一节；
- 往 `packages/web/src/lib/changelog.ts` 插入新版本的新功能导览；
- 只提交上述文件，创建本地标签 `v<版本>`，**不 push**。

发布后按需执行：

```bash
node scripts/check.mjs
npm run apk:release -w @tandem/mobile
npm run dist:win -w @tandem/desktop
```

## 2. 安卓 release 签名

签名文件固定放在仓库外：

| 文件 | 说明 |
|---|---|
| `~/.tandem-release/android.keystore` | release keystore，首次打包时用 `keytool` 自动生成 |
| `~/.tandem-release/android.keystore.password` | 密码文件，权限必须是 600；自动生成时写入 |

密码也可以从环境变量 `TANDEM_ANDROID_KEYSTORE_PASSWORD` 读取；别名默认 `tandem`，可用 `TANDEM_ANDROID_KEY_ALIAS` 覆盖。密码不会写进仓库、Gradle 文件或日志。

```bash
npm run apk:release -w @tandem/mobile
```

产物：

- `dist-apk/tandem-release.apk`（已签名，脚本会用 `apksigner verify` 校验）
- `dist-apk/tandem-release.aab`（Google Play / 部分商店用）
- 同时复制到 Windows「下载」目录（与本机 debug 包流程相同）

release 构建启用了 R8 代码压缩与资源压缩；脚本会检查 APK 内仍存在 `assets/public/index.html` 与前端 JS，防止 WebView 资源被误删。debug 包流程 `npm run apk -w @tandem/mobile` 不变。

> **备份提醒**：`~/.tandem-release` 是整个安卓发布链路的根。请把 keystore 与密码离线备份到密码管理器或离线介质；丢失后无法给已安装用户发覆盖升级，只能换包名重新上架。

## 3. 桌面自动更新（内网）

### 3.1 生成更新源

```bash
npm run dist:win -w @tandem/desktop
```

`packages/desktop/dist/` 会同时产出：

- `Tandem-Setup-<版本>-x64.exe`
- `Tandem-Setup-<版本>-x64.exe.blockmap`
- `latest.yml`

把这三个文件原样放到任意内网 HTTP 静态目录，或直接放进共享目录。客户端不依赖公网。

### 3.2 配置客户端

设置 →「通用」→「桌面更新」：

- **更新源**：填 `http://192.168.1.10:8080/updates` 一类的内网地址，或 `\\nas\share\tandem` 共享目录；留空 = 完全关闭，不发起任何请求。
- 配置后启动 15 秒检查一次，此后每 6 小时一次；下载完成只弹一条「新版本 x · 重启以更新」，点击才重启安装。
- 更新源里的 `latest.yml` 版本高于客户端时才会下载；可手改 `latest.yml` 的 `version` 做联调。

### 3.3 由 Host 托管

设置 →「通用」→「Host 托管更新文件」填一个本机目录，Host 会把它公开为：

```
http://<Host地址>:<端口>/updates/
```

留空即关闭。该路径不需要 token，只允许读取该目录内的文件，不提供目录列表。适合把一台常开的机器作为内网更新源。

## 4. Windows 代码签名

本次不购买证书，安装包未签名。Windows 仍可安装，但 SmartScreen 会提示「Windows 已保护你的电脑」，需要用户点「更多信息 → 仍要运行」。

### 4.1 签名方式与大致费用

| 方式 | 说明 | 大致费用 |
|---|---|---|
| OV 代码签名证书 | 最常见，证书绑定企业/个人身份，需 U 盘或云签名服务 | 约 ¥2000–4000/年 |
| EV 代码签名证书 | 硬件令牌/云 HSM，SmartScreen 信誉更好 | 约 ¥4000–8000/年 |
| 云签名服务 | 按签名次数或订阅计费，无需保管 U 盘 | 以服务商报价为准 |
| 不签名 | 0 成本，保留 SmartScreen 警告 | 0 |

费用随服务商、年限、是否加急变化，采购前要报价单。个人开发者通常只能申请 OV/个人证书，部分 CA 要求企业资质。

### 4.2 SmartScreen 的影响

- 未签名或新证书：首次下载运行时大概率出现蓝色警告，部分用户会放弃安装。
- OV 证书：签名后警告会逐步减少，但需要累计下载量建立信誉。
- EV 证书：通常能更快获得信誉，仍不保证 100% 无提示。
- 内网分发可以引导用户核对 SHA-256；安装包哈希会随版本变化。

### 4.3 以后接入的步骤

1. 采购证书（OV/EV），确认是否支持 `signtool` 或云签名。
2. 在 CI/本机设置 `CSC_LINK` 与 `CSC_KEY_PASSWORD`（或云签名工具），不要把证书与密码写进仓库。
3. `electron-builder` 会自动签名 exe 与 NSIS 安装包；`CSC_IDENTITY_AUTO_DISCOVERY=false` 仅用于当前未签名流程。
4. 用 `signtool verify /pa /v Tandem-Setup-*.exe` 校验，并在 Windows 实机确认 SmartScreen 表现。
5. 在 `docs/release.md` 记录证书到期时间与续费负责人。

## 5. 安卓上架材料清单

### 5.1 所有商店通用

- 应用名称、包名 `com.tandem.app`、版本号、版本说明
- 应用图标（512×512）、商店截图（手机 1080×1920 左右，至少 3–5 张）、功能简介与完整描述
- 隐私政策链接（公网可访问的 HTTPS 页面），内容需覆盖：收集的信息、用途、存储位置、共享对象、保留期限、用户权利、联系方式
- 权限用途说明：逐项解释 INTERNET、通知、前台服务/数据同步、麦克风（语音输入）等
- 测试账号或测试步骤（如果商店要求登录后体验；Tandem 需要一台可达的 Host，建议提供内网测试说明或演示视频）
- 内容分级、目标用户、是否含广告/内购
- 安装包：Google Play 用 AAB；国内商店多数收 APK，部分也支持 AAB

### 5.2 国内主流商店（华为、小米、OPPO、vivo、应用宝、荣耀等）

- 企业营业执照（个人开发者部分商店受限）
- 软件著作权证书（软著）；名称需与 App 名称一致或提供授权说明
- **工信部 APP 备案**（2024 年起强制），备案主体、域名、公网服务需一致
- ICP 备案/域名证书（隐私政策页面所在域名）
- 隐私政策与「个人信息收集清单」「第三方 SDK 清单」
- 应用内隐私政策入口、首次启动隐私弹窗与同意/拒绝选项
- 权限申请前说明用途；拒绝非必要权限仍可使用核心功能
- 若使用自建中继/公网服务，需要说明服务用途与安全措施；当前产品默认只连内网 Host，商店审核时不要宣传为公网云服务

### 5.3 Google Play

- Google Play 开发者账号（一次性约 $25）
- AAB、targetSdk 达到当年要求、64 位
- 隐私政策 URL、Data safety 表单（收集/共享的数据类型、是否加密传输、能否删除）
- 内容分级问卷、广告声明、新闻/健康等敏感类别声明
- App access 说明（审核人员如何进入应用；需要可用的 Host 或演示模式）
- 若声明不需要账号，需确保没有隐藏登录门槛
- 使用 Play App Signing（上传密钥与签名密钥分离；本地 `~/.tandem-release` 仍要备份）

## 6. 产品内还需补的内容

上架前建议补以下几项，本次发布未实现：

1. **隐私政策页面**：应用内可打开的静态页面（设置 → 关于），并与商店填写的 URL 内容一致。
2. **首次启动隐私同意**：首次打开展示隐私摘要，同意后再初始化网络与通知；拒绝时进入只读/离线模式。
3. **权限用途说明页**：通知、前台服务、麦克风逐项说明「为什么需要、关闭后影响什么」。
4. **第三方 SDK 清单**：Capacitor、通知、前台服务、语音识别等 SDK 的名称、用途、收集信息。
5. **个人信息导出/删除**：当前数据都在本机 `~/.tandem` 与浏览器 localStorage，需要给用户一个「清除本机数据」入口和说明。
6. **关于页版本与更新日志**：已有新功能导览，但上架材料需要能展示版本号、隐私政策、开源许可。
7. **演示模式/审核账号**：审核人员没有内网 Host 时无法体验核心功能，需准备演示视频或内置演示 Host。
8. **应用备案与商店资质**：这是运营动作，不是代码改动，但必须在提审前完成。
