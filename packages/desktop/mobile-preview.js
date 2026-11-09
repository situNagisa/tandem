'use strict';
// 调试版「手机预览」：独立窗口加载同一个 Host，用 CDP 模拟手机尺寸、UA 与触摸。
// 发布版主进程不会注册这里的 IPC / 菜单入口。
const { BrowserWindow, ipcMain, shell } = require('electron');

const PRESETS = {
  pixel7: {
    label: 'Pixel 7',
    width: 412,
    height: 915,
    dpr: 2.625,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  },
  small: {
    label: '小屏',
    width: 360,
    height: 740,
    dpr: 3,
    ua: 'Mozilla/5.0 (Linux; Android 13; Tandem Small) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  },
  tablet: {
    label: '平板',
    width: 800,
    height: 1280,
    dpr: 1.5,
    ua: 'Mozilla/5.0 (Linux; Android 14; Tandem Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
};

let deps = null;
let previewWin = null;
let state = { preset: 'pixel7', orientation: 'portrait' };

function normalize(options) {
  const preset = options && PRESETS[options.preset] ? options.preset : 'pixel7';
  const orientation =
    options && options.orientation === 'landscape' ? 'landscape' : 'portrait';
  return { preset, orientation };
}

function dimensions(current = state) {
  const preset = PRESETS[current.preset];
  return current.orientation === 'landscape'
    ? { width: preset.height, height: preset.width }
    : { width: preset.width, height: preset.height };
}

function previewUrl() {
  const hostUrl = deps.getHostUrl();
  if (!hostUrl) throw new Error('Host 尚未启动');
  const url = new URL(hostUrl);
  url.searchParams.set('mobilePreview', '1');
  url.searchParams.set('previewPreset', state.preset);
  url.searchParams.set('previewOrientation', state.orientation);
  url.hash = '';
  return url.toString();
}

function title() {
  const preset = PRESETS[state.preset];
  const size = dimensions();
  return `手机预览（模拟） · ${preset.label} · ${size.width}×${size.height}`;
}

async function applyEmulation(win, opts = {}) {
  if (!win || win.isDestroyed()) return;
  const preset = PRESETS[state.preset];
  const size = dimensions();
  try {
    win.setContentSize(size.width, size.height);
  } catch {
    // 窗口最小尺寸等限制时忽略，页面仍按 CDP 视口渲染
  }
  win.setTitle(title());
  const dbg = win.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: preset.dpr,
      mobile: true,
      screenWidth: size.width,
      screenHeight: size.height,
      screenOrientation: {
        angle: state.orientation === 'landscape' ? 90 : 0,
        type: state.orientation === 'landscape' ? 'landscapePrimary' : 'portraitPrimary',
      },
    });
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await dbg.sendCommand('Emulation.setEmitTouchEventsForMouse', {
      enabled: true,
      configuration: 'mobile',
    });
    await dbg.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: preset.ua,
      platform: 'Android',
    });
  } catch (err) {
    if (!opts.silent) console.warn('[mobile-preview] 触摸模拟不可用：', err && err.message);
  }
}

function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!deps.isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (deps.isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

async function open(options) {
  if (!deps) return { ok: false, error: '手机预览未初始化' };
  const next = normalize(options || state);
  if (previewWin && !previewWin.isDestroyed()) {
    state = next;
    await applyEmulation(previewWin);
    previewWin.show();
    previewWin.focus();
    return { ok: true };
  }
  state = next;
  const size = dimensions();
  previewWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: title(),
    backgroundColor: deps.getTheme().background,
    icon: deps.iconFile,
    autoHideMenuBar: true,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  guardNavigation(previewWin);
  previewWin.once('ready-to-show', () => {
    if (previewWin && !previewWin.isDestroyed()) previewWin.show();
  });
  previewWin.on('closed', () => {
    previewWin = null;
  });
  previewWin.webContents.on('did-finish-load', () => {
    void applyEmulation(previewWin, { silent: true });
  });
  await applyEmulation(previewWin);
  previewWin.loadURL(previewUrl());
  return { ok: true };
}

async function configure(options) {
  if (!previewWin || previewWin.isDestroyed()) return { ok: false, error: '预览窗口未打开' };
  const previous = state;
  state = normalize(options || state);
  await applyEmulation(previewWin);
  // UA / DPR 只对新的文档生效：换预设时重载；仅旋转时保留当前页面。
  if (previous.preset !== state.preset) previewWin.webContents.reload();
  return { ok: true };
}

function register(options) {
  deps = options;
  ipcMain.handle('mobile-preview:open', async (_event, opts) => {
    try {
      return await open(opts);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
  ipcMain.handle('mobile-preview:configure', async (_event, opts) => {
    try {
      return await configure(opts);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

module.exports = { register, open, isOpen: () => !!previewWin && !previewWin.isDestroyed() };
