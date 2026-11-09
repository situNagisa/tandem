# 手机预览（调试版）

> 更新：2026-11-09。仅在调试版存在；发布版构建会剔除入口与模块，并在 `scripts/scan-release.mjs` 中扫描禁用标识。

## 是什么

在电脑上以手机尺寸打开与安卓 App 相同的 Web 界面，连接同一个 Host，用于检查移动布局、触摸交互和反馈问题，不必每次都装 APK。

- 入口：命令面板「打开手机预览」、快捷键 `Ctrl/Cmd + Shift + M`；调试版桌面还可以从菜单（macOS「视图」）或托盘打开。
- 预设：Pixel 7 `412×915`、小屏 `360×740`、平板 `800×1280`；可旋转横竖屏。
- 预览窗口顶栏标注「手机预览 · 模拟」，可切换预设、旋转、打开「模拟键盘」占位。
- 顶栏占独立的 30px 区域，页面内容与全屏浮层（侧栏抽屉、全屏面板、对话框）都从它下方开始，不会压住标题；回归用例断言抽屉标题与顶栏不相交。
- 浏览器版调试构建同样有入口：新开手机尺寸弹窗；无法真正模拟触摸时顶栏显示「无触摸模拟」。

## 桌面端如何模拟

- 独立 `BrowserWindow`，`useContentSize` 固定为预设尺寸，加载 `hostUrl?mobilePreview=1&previewPreset=…&previewOrientation=…`。
- 通过 `webContents.debugger` 发送 CDP：
  - `Emulation.setDeviceMetricsOverride`：宽高、`deviceScaleFactor`、`mobile: true`、屏幕方向；
  - `Emulation.setTouchEmulationEnabled` + `Emulation.setEmitTouchEventsForMouse`：鼠标拖动变成触摸手势；
  - `Emulation.setUserAgentOverride`：Android UA，反馈包里能看到真实 UA。
- 页面带 `mobilePreview=1` 时 `useIsMobile()` 强制为移动布局（平板预设也一样），并使用与安卓 App 相同的底部抽屉、返回手势与输入框。
- `lib/native.ts` 在预览中把 Capacitor 原生能力走桩：本地通知、前台服务只记录/返回成功，不加载安卓插件；相机、振动等目前没有调用点，保持 no-op。
- 「模拟键盘」只是在窗口底部盖一块键盘占位，方便检查软键盘弹出时的可用高度，不接管输入。
- 预览窗口里 `Ctrl/Cmd + Shift + F` 反馈模式照常可用；导出的反馈 `platform` 为 `mobile-preview`。

## 浏览器版

- 命令面板入口用 `window.open` 新开弹窗，尺寸按预设设置；浏览器通常不允许改窗口大小，且没有触摸模拟。
- 顶栏会明确提示「无触摸模拟」，不会假装成真机。

## 发布版如何剔除

- 入口在 `commands.ts` 的 `DEBUG_COMMANDS`、组件在 `App.tsx` 的 `__TANDEM_DEBUG__` 惰性分支中，发布构建为常量 `false`，模块不进入产物。
- `scripts/scan-release.mjs` 扫描 `手机预览`、`MobilePreview`、`mobile-preview`、`setTouchEmulationEnabled`、`setEmitTouchEventsForMouse`。
- 桌面主进程按 `resources/flavor.txt` 判断风味；release 包不注册手机预览 IPC，也不显示菜单/托盘入口。
- 发布版页面打开 `?mobilePreview=1` 不渲染预览顶栏（`e2e/release-flavor.mjs` 覆盖）。

## 限制

- 预览是 Chromium 页面的触摸模拟，不是安卓 WebView：真机字体、状态栏、软键盘、权限弹窗仍需真机验证。
- 不模拟推送、相机、振动等系统能力；这些能力在预览里是桩。
- 真机调试步骤见 [手机调试](../test-guides/mobile-debugging.md)。
