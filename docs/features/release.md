# 发布说明

> 更新：2026-11-10。覆盖版本号、调试版/发布版、安卓签名、桌面更新源与上架材料。签名材料只放在仓库外；产物只进 `dist-*` 或内网静态目录。

## 调试版与发布版

构建开关 `TANDEM_FLAVOR=debug|release`，默认 `debug`。flavor 在构建时写死进每个产物（web 由 Vite define；server `dist/flavor.js` 与桌面 `flavor.generated.js` 由 `scripts/write-flavor.mjs` 写常量），运行时不读环境变量。`prepare-resources` 打包前断言 web/server/desktop 三者一致；`dist:win` 打包后再查 `win-unpacked/resources`。`check.mjs` 的 `debug-artifacts` 与 `check-release.mjs` 做产物扫描。

发布版**完全不存在**：反馈模式、演示工作区/设备、体验清单、组件画廊、手机预览、调试日志/轨迹、调试工作站账号/演示主机、测试开关。正常功能两版都有：主机诊断、配置导入导出、用量预算、更新检查等。

```bash
npm run build:debug / build:release
npm run apk -w @tandem/mobile          # debug：tandem-debug.apk
npm run apk:release -w @tandem/mobile  # release：tandem-release.apk/.aab
npm run dist:win -w @tandem/desktop        # release 安装包
npm run dist:win:debug -w @tandem/desktop  # debug 安装包
```

桌面 debug/release 使用同一 appId、产品名与安装目录，不能同时安装。

## 版本与发布流程

```bash
node scripts/release.mjs 0.2.1 --dry-run
node scripts/release.mjs 0.2.1
```

脚本同步根与 `packages/*` 版本、内部依赖与 lockfile；按 `feat/fix/perf/refactor` 从 git log 生成 `CHANGELOG.md`；往 `packages/web/src/lib/changelog.ts` 插入导览；只提交这些文件并打本地标签 `v<版本>`，**不 push**。发布后跑 `check.mjs`、`apk:release`、`dist:win`。

## 安卓 release 签名

签名固定放仓库外：`~/.tandem-release/android.keystore` 与 `android.keystore.password`（600）。密码也可读 `TANDEM_ANDROID_KEYSTORE_PASSWORD`；别名默认 `tandem`（`TANDEM_ANDROID_KEY_ALIAS`）。密码不进仓库/Gradle/日志。`apk:release` 产物为 `dist-apk/tandem-release.apk` 与 `.aab`，脚本用 `apksigner verify` 校验并检查 WebView 资源；同时复制到 Windows「下载」。R8 压缩已启用。**务必备份 `~/.tandem-release`**，丢失后无法覆盖升级。

## 桌面自动更新（内网）

`dist:win` 产出 `Tandem-Setup-<版本>-x64.exe`、`.blockmap`、`latest.yml`；放到任意内网 HTTP 静态目录或共享目录。客户端设置 →「通用」→「桌面更新」填更新源（留空完全关闭）；启动 15 秒后检查一次，此后每 6 小时；下载完只提示「新版本 x · 重启以更新」。也可让 Host 托管：设置 →「Host 托管更新文件」指向本机目录，Host 公开 `/updates/`（无需 token，只读该目录，不列目录）。

## Windows 代码签名

当前未购买证书，安装包未签名；SmartScreen 会提示「更多信息 → 仍要运行」。以后接入：采购 OV/EV 证书 → 设置 `CSC_LINK`/`CSC_KEY_PASSWORD`（或云签名）→ electron-builder 自动签名 exe/NSIS → `signtool verify /pa /v` 校验 → 在本页记录到期时间与负责人。费用与服务商报价为准，不要把证书/密码写进仓库。

## 安卓上架材料

通用：应用名、包名 `com.tandem.app`、版本与说明、512×512 图标、3–5 张截图、简介/描述、隐私政策 URL（HTTPS，覆盖收集信息/用途/存储/共享/保留/权利/联系方式）、权限用途（INTERNET、通知、前台服务、麦克风）、测试账号或内网测试说明、内容分级、广告/内购声明、AAB（Google Play）或 APK（国内商店）。

国内商店：营业执照、软著、工信部 APP 备案（2024 起强制）、ICP/域名证书、隐私政策与个人信息收集清单/第三方 SDK 清单、首次启动隐私弹窗、权限申请前说明、拒绝非必要权限仍可用核心功能；不要宣传为公网云服务。Google Play：开发者账号（约 $25）、AAB、targetSdk、64 位、Data safety、内容分级、App access 说明、Play App Signing。

## 发布前仍需补

- 应用内隐私政策页与首次启动隐私同意（拒绝可进入离线/只读）。
- 权限用途说明页、第三方 SDK 清单、个人信息导出/删除/清除本机数据入口。
- 关于页展示版本号、隐私政策、开源许可；审核用演示 Host/视频；备案与商店资质。
- iOS 暂不做（用户 2026-11-07 决定）。

## 限制

- 桌面/安卓签名与商店材料需用户实机与账号操作；本仓库只提供脚本与检查。
- 未签名 Windows 包会被 SmartScreen 拦截；内网分发可引导核对 SHA-256。
