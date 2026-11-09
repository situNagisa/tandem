# 手机调试

> 更新：2026-11-09。给产品所有者 / 维护者：在电脑上看真机页面、投屏操作，以及不装 APK 时的手机预览。

## 1. 调试版 APK + Chrome 远程调试

调试包（`npm run apk -w @tandem/mobile` 产出的 `tandem-debug.apk`）在主进程里用 `BuildConfig.DEBUG` 开了：

```java
WebView.setWebContentsDebuggingEnabled(true)
```

发布包不会执行这一行。

步骤：

1. 手机打开「开发者选项 → USB 调试」，用数据线连电脑；`adb devices` 能看到设备。
2. 电脑 Chrome 打开 `chrome://inspect/#devices`。
3. 手机打开 Tandem，页面上会出现 `com.tandem.app` 的 WebView；点「inspect」。
4. 在 DevTools 里看控制台、网络、DOM，也可以直接改样式验证移动布局。
5. 如果列表里没有设备：确认 `adb devices` 不是 `unauthorized`（手机上点允许调试），必要时重新插拔数据线。

> 只开调试包；正式包没有这个开关。看别人的真机页面需要对方手机已开 USB 调试并授权。

## 2. 投屏操作（scrcpy）

需要直接用鼠标键盘操作手机时用 scrcpy。**只写使用说明，不把第三方工具打进仓库或安装包。**

1. 从 scrcpy 官方发布页下载对应平台版本（Windows 解压即用），并确保 `adb` 在 PATH 里。
2. 连上手机后运行：

   ```bash
   scrcpy -s <设备序列号>
   ```

   `adb devices` 可查序列号；只有一台设备时可省略 `-s`。
3. 常用参数：

   ```bash
   scrcpy --turn-screen-off --stay-awake   # 关手机屏幕但保持投屏
   scrcpy --max-size 1024 --max-fps 30     # 降低带宽
   scrcpy --no-audio                       # 不转发音频
   ```

4. 投屏窗口里可以直接点击、滑动、输入；`Ctrl+H` 返回、`Ctrl+B` 返回键、`Ctrl+Shift+H` 主页。

## 3. 不装 APK：桌面调试版「手机预览」

调试版桌面：命令面板「打开手机预览」或 `Ctrl/Cmd + Shift + M`，也可从菜单/托盘打开。可选 Pixel 7、小屏、平板，支持旋转与模拟键盘，鼠标拖动会变成触摸。详见 [features/mobile-preview.md](../features/mobile-preview.md)。

浏览器调试构建也能从命令面板打开手机尺寸弹窗，但没有触摸模拟，顶栏会提示。

## 4. 要回传什么

遇到移动端问题，用调试版 App 的反馈模式（`Ctrl/Cmd + Shift + F`）导出 `tandem-feedback-*.json`，附上：设备型号、系统版本、是竖屏还是横屏、是否开了系统字体放大。手机预览里导出的反馈会标 `platform=mobile-preview`。
