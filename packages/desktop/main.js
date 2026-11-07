'use strict';
// Tandem 桌面端主进程：内置本机 Host（packages/server），窗口加载 Host 托管的 web UI。
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  shell,
  dialog,
} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const DEFAULT_PORT = 7878;
const MAX_PORT_TRIES = 20;

const THEMES = {
  light: { background: '#F5F4ED', symbol: '#3F3D3A' },
  dark: { background: '#1F1E1D', symbol: '#C9C7C0' },
};

const resourcesDir = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, 'resources');
const serverDir = path.join(resourcesDir, 'server', 'dist');
const iconFile = path.join(resourcesDir, 'icons', 'icon.png');

app.setName('Tandem');
app.setAppUserModelId('com.tandem.desktop');

/** @type {import('electron').BrowserWindow | null} */
let win = null;
/** @type {import('electron').Tray | null} */
let tray = null;
/** @type {any} */
let host = null;
/** @type {any} */
let fastifyApp = null;
/** @type {string | null} */
let hostUrl = null;
let listenPort = DEFAULT_PORT;
let listenHost = '127.0.0.1';
let reusingExternalHost = false;
let quitting = false;
let serverModules = null;
let saveStateTimer = null;

function theme() {
  return THEMES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
}

function isAppUrl(url) {
  try {
    const u = new URL(url);
    const port = listenPort ? String(listenPort) : '';
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      u.port === port &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

async function loadServerModules() {
  if (!serverModules) {
    const [server, hostMod, configMod] = await Promise.all([
      import(pathToFileURL(path.join(serverDir, 'server.js')).href),
      import(pathToFileURL(path.join(serverDir, 'host.js')).href),
      import(pathToFileURL(path.join(serverDir, 'config.js')).href),
    ]);
    serverModules = { createApp: server.createApp, Host: hostMod.Host, ...configMod };
  }
  return serverModules;
}

// ---------- 端口与已有 Host 探测 ----------

function requestJson(url, token, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      url,
      { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // 非 JSON
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

/** 7878 上如果已有同一数据目录的 Tandem Host，直接复用。 */
async function probeExistingHost(config) {
  try {
    const res = await requestJson(`http://127.0.0.1:${DEFAULT_PORT}/api/host`, config.token);
    if (res.status === 200 && res.json && typeof res.json.id === 'string') {
      if (!res.json.id || res.json.id !== config.hostId) return null;
      return { port: DEFAULT_PORT, token: config.token };
    }
  } catch {
    // 没人监听
  }
  return null;
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function findFreePort(startPort) {
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const port = startPort + i;
    if (port > 65535) break;
    if (await isPortFree(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function listen(port, hostName) {
  const mods = await loadServerModules();
  const home = mods.tandemHome();
  const config = mods.loadHostConfig(home);
  const instance = new mods.Host(config, home);
  const instanceApp = await mods.createApp(instance);
  await instanceApp.listen({ port, host: hostName });
  const address = instanceApp.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { host: instance, app: instanceApp, config, port: actualPort };
}

async function stopHost() {
  if (fastifyApp) {
    try {
      await fastifyApp.close();
    } catch {
      // ignore
    }
  }
  if (host) {
    try {
      host.store.flush();
    } catch {
      // ignore
    }
  }
  fastifyApp = null;
  host = null;
}

async function startHost() {
  const mods = await loadServerModules();
  const home = mods.tandemHome();
  const config = mods.loadHostConfig(home);

  const existing = await probeExistingHost(config);
  if (existing) {
    reusingExternalHost = true;
    listenPort = existing.port;
    listenHost = '127.0.0.1';
    hostUrl = `http://127.0.0.1:${existing.port}/?token=${encodeURIComponent(existing.token)}`;
    return;
  }

  reusingExternalHost = false;
  listenHost = '127.0.0.1';
  listenPort = await findFreePort(DEFAULT_PORT);
  const started = await listen(listenPort, listenHost);
  host = started.host;
  fastifyApp = started.app;
  listenPort = started.port;
  hostUrl = `http://127.0.0.1:${started.port}/?token=${encodeURIComponent(started.config.token)}`;
}

async function restartHost(nextHost) {
  const port = listenPort;
  await stopHost();
  let started;
  try {
    started = await listen(port, nextHost);
  } catch (err) {
    // 端口在切换瞬间被占用：换一个空闲端口
    started = await listen(await findFreePort(DEFAULT_PORT), nextHost);
  }
  host = started.host;
  fastifyApp = started.app;
  listenPort = started.port;
  listenHost = nextHost;
  const token = started.config.token;
  hostUrl = `http://127.0.0.1:${started.port}/?token=${encodeURIComponent(token)}`;
}

// ---------- 窗口状态 ----------

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (
      Number.isFinite(raw.width) &&
      Number.isFinite(raw.height) &&
      raw.width >= 960 &&
      raw.height >= 640
    ) {
      const visible =
        !Number.isFinite(raw.x) ||
        !Number.isFinite(raw.y) ||
        require('electron').screen.getAllDisplays().some((d) => {
          const b = d.workArea;
          return raw.x < b.x + b.width && raw.x + raw.width > b.x && raw.y < b.y + b.height && raw.y + raw.height > b.y;
        });
      return visible ? raw : { width: raw.width, height: raw.height };
    }
  } catch {
    // 没有保存过
  }
  return null;
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds();
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(bounds));
  } catch {
    // ignore
  }
}

function scheduleSaveWindowState() {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 400);
}

// ---------- 窗口 ----------

function applyTitleBarTheme() {
  const t = theme();
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(t.background);
  if (isWin) {
    try {
      win.setTitleBarOverlay({ color: t.background, symbolColor: t.symbol, height: 36 });
    } catch {
      // 旧版本 Electron 不支持
    }
  }
}

function createWindow() {
  const saved = loadWindowState();
  const t = theme();

  win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    ...(Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Tandem',
    backgroundColor: t.background,
    icon: iconFile,
    autoHideMenuBar: true,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } } : {}),
    ...(isWin
      ? { titleBarStyle: 'hidden', titleBarOverlay: { color: t.background, symbolColor: t.symbol, height: 36 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('resize', scheduleSaveWindowState);
  win.on('move', scheduleSaveWindowState);
  win.on('close', (event) => {
    scheduleSaveWindowState();
    if (!quitting) {
      event.preventDefault();
      win.hide();
      updateTrayMenu();
    }
  });
  win.on('show', updateTrayMenu);
  win.on('hide', updateTrayMenu);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (hostUrl) win.loadURL(hostUrl);

  nativeTheme.on('updated', applyTitleBarTheme);
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

// ---------- 托盘 ----------

function trayImage() {
  let img = nativeImage.createFromPath(iconFile);
  if (img.isEmpty()) return img;
  const size = isMac ? 18 : 16;
  return img.resize({ width: size, height: size, quality: 'best' });
}

function buildTrayMenu() {
  const lanEnabled = listenHost === '0.0.0.0';
  const visible = !!win && !win.isDestroyed() && win.isVisible();
  const menu = Menu.buildFromTemplate([
    { label: visible ? '隐藏窗口' : '显示窗口', click: () => toggleWindow() },
    { type: 'separator' },
    {
      label: '在局域网开放',
      type: 'checkbox',
      checked: lanEnabled,
      enabled: !reusingExternalHost,
      click: async (item) => {
        if (reusingExternalHost) return;
        try {
          await restartHost(item.checked ? '0.0.0.0' : '127.0.0.1');
          if (win && !win.isDestroyed() && hostUrl) win.loadURL(hostUrl);
        } catch (err) {
          dialog.showErrorBox('切换局域网监听失败', (err && err.message) || String(err));
        }
        updateTrayMenu();
      },
    },
    ...(isWin
      ? [
          {
            label: '首次开启会弹出 Windows 防火墙提示，请允许访问',
            enabled: false,
          },
        ]
      : []),
    { type: 'separator' },
    {
      label: '退出 Tandem',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  return menu;
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(hostUrl ? 'Tandem — 已连接本机 Host' : 'Tandem');
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', () => toggleWindow());
  updateTrayMenu();
}

// ---------- 菜单 ----------

function buildAppMenu() {
  if (!isMac) return null;
  return Menu.buildFromTemplate([
    {
      label: 'Tandem',
      submenu: [
        { role: 'about', label: '关于 Tandem' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Tandem' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Tandem' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        {
          label: '关闭窗口',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => BrowserWindow.getFocusedWindow()?.close(),
        },
      ],
    },
  ]);
}

// ---------- 生命周期 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildAppMenu());
    try {
      await startHost();
    } catch (err) {
      dialog.showErrorBox('Tandem Host 启动失败', (err && err.stack) || String(err));
      app.quit();
      return;
    }
    createWindow();
    createTray();

    app.on('activate', () => {
      showWindow();
    });
  });

  app.on('before-quit', (event) => {
    if (!quitting) return;
    if (fastifyApp || host) {
      event.preventDefault();
      const done = async () => {
        await stopHost();
        app.exit(0);
      };
      void done();
    }
  });

  app.on('window-all-closed', () => {
    if (isMac) return;
    // 窗口只是隐藏到托盘，保留 Host 进程
  });
}
