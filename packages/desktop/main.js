'use strict';
// Tandem 桌面端主进程：内置本机 Host（packages/server），窗口加载 Host 托管的 web UI。
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  dialog,
} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

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

/**
 * 构建风味：scripts/write-flavor.mjs 在打包前把常量写进 flavor.generated.js，
 * 运行时不读环境变量。开发模式首次未生成时按 debug 处理。
 */
const { resolveFlavor } = require('./flavor-core.js');
let generatedFlavor = null;
try {
  generatedFlavor = require('./flavor.generated.js');
} catch {
  // 开发模式尚未生成；打包产物必须有这个文件（check-debug 会扫描）。
}
const flavor = resolveFlavor(generatedFlavor, { packaged: app.isPackaged });
const debugFlavor = flavor === 'debug';
/** 手机预览只在调试版加载；发布版连入口与 IPC 都不注册。 */
const mobilePreview = debugFlavor ? require('./mobile-preview.js') : null;
/** 反馈草稿实时落盘与 .tfb 导出同样只在调试版注册。 */
let feedbackDrafts = null;
if (debugFlavor) {
  try {
    feedbackDrafts = require('./feedback-drafts.js');
  } catch (err) {
    // 模块缺失时不要让整个应用起不来；check-debug 会阻止这种包发出去。
    console.error('[debug] 反馈草稿模块加载失败，实时落盘不可用:', (err && err.message) || err);
  }
}

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
/** 内嵌（或同机复用）Host 的 hostId：判断所选主机是否与桌面客户端同一台机器。 */
let localHostId = null;
let quitting = false;
let serverModules = null;
let saveStateTimer = null;
let updateTimer = null;
let updateStatus = { state: 'idle' };
/** 共享目录更新源：在回环地址起一个只读静态服务，交给 electron-updater 的 generic provider。 */
let localUpdate = null;

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
  localHostId = config.hostId;

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
      // preload 在沙箱里只能 require('electron')，风味由主进程通过启动参数传入。
      additionalArguments: [`--tandem-flavor=${flavor}`],
      // 反馈9：默认关闭拼写检查下划线与建议（输入框不再出现浏览器自带波浪线）。
      spellcheck: false,
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
    ...(mobilePreview
      ? [
          { type: 'separator' },
          {
            label: '手机预览（模拟）',
            click: () => {
              void mobilePreview.open().catch((err) => {
                dialog.showErrorBox('打开手机预览失败', (err && err.message) || String(err));
              });
            },
          },
        ]
      : []),
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
        ...(mobilePreview
          ? [
              {
                label: '手机预览（模拟）',
                accelerator: 'CmdOrCtrl+Shift+M',
                click: () => {
                  void mobilePreview.open().catch((err) => {
                    dialog.showErrorBox('打开手机预览失败', (err && err.message) || String(err));
                  });
                },
              },
              { type: 'separator' },
            ]
          : []),
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

// ---------- 自动更新（electron-updater generic） ----------

function updateConfigFile() {
  return path.join(app.getPath('userData'), 'update-config.json');
}

function readUpdateConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(updateConfigFile(), 'utf8'));
    return { source: typeof raw?.source === 'string' ? raw.source.trim() : '' };
  } catch {
    return { source: '' };
  }
}

function writeUpdateConfig(config) {
  const source = typeof config?.source === 'string' ? config.source.trim() : '';
  fs.mkdirSync(path.dirname(updateConfigFile()), { recursive: true });
  fs.writeFileSync(updateConfigFile(), JSON.stringify({ source }, null, 2));
  return { source };
}

const UPDATE_TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.msi': 'application/octet-stream',
  '.zip': 'application/zip',
  '.dmg': 'application/octet-stream',
  '.appimage': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

function stopLocalUpdateServer() {
  if (!localUpdate) return;
  try {
    localUpdate.server.close();
  } catch {
    // ignore
  }
  localUpdate = null;
}

function serveLocalUpdate(root, req, res) {
  let stat;
  let file;
  try {
    const rel = decodeURIComponent(String(req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const headers = {
    'Content-Type': UPDATE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    res.end();
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (match) {
    const suffix = !match[1] && match[2] ? Number(match[2]) : 0;
    const start = suffix ? Math.max(0, stat.size - suffix) : Number(match[1] || 0);
    const end = match[2] && !suffix ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (Number.isFinite(start) && start <= end && start < stat.size) {
      res.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

/** http(s) 直接用；共享目录/本地路径起一个 127.0.0.1 只读静态服务。 */
async function feedUrlFor(source) {
  const value = String(source ?? '').trim();
  if (/^https?:\/\//i.test(value)) {
    stopLocalUpdateServer();
    return value;
  }
  const root = /^file:\/\//i.test(value) ? fileURLToPath(value) : path.resolve(value);
  if (localUpdate?.root === root) return localUpdate.url;
  stopLocalUpdateServer();
  if (!fs.existsSync(root)) throw new Error(`更新源目录不存在：${root}`);
  const server = http.createServer((req, res) => serveLocalUpdate(root, req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  localUpdate = { root, server, url: `http://127.0.0.1:${port}/` };
  return localUpdate.url;
}

function sendUpdateStatus(next) {
  updateStatus = next;
  if (win && !win.isDestroyed()) win.webContents.send('updater:status', next);
}

function autoUpdater() {
  // 延迟加载：未配置更新源时不初始化更新器，也不发起任何请求。
  return require('electron-updater').autoUpdater;
}

function setupUpdater() {
  const updater = autoUpdater();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  updater.on('update-available', (info) =>
    sendUpdateStatus({ state: 'available', version: info?.version }),
  );
  updater.on('update-not-available', () =>
    sendUpdateStatus({ state: 'current', version: app.getVersion() }),
  );
  updater.on('download-progress', (progress) =>
    sendUpdateStatus({
      state: 'downloading',
      version: updateStatus.version,
      percent: Math.round(progress?.percent ?? 0),
    }),
  );
  updater.on('update-downloaded', (info) =>
    sendUpdateStatus({ state: 'downloaded', version: info?.version }),
  );
  updater.on('error', (err) =>
    sendUpdateStatus({ state: 'error', message: (err && err.message) || String(err) }),
  );
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    sendUpdateStatus({ state: 'disabled', message: '开发模式不检查更新，请用安装版验证' });
    return updateStatus;
  }
  const { source } = readUpdateConfig();
  if (!source) {
    // 默认关闭：不配置更新源时绝不发起请求。
    stopLocalUpdateServer();
    sendUpdateStatus({ state: 'idle' });
    return updateStatus;
  }
  try {
    const url = await feedUrlFor(source);
    const updater = autoUpdater();
    updater.setFeedURL({ provider: 'generic', url });
    sendUpdateStatus({ state: 'checking' });
    await updater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({ state: 'error', message: (err && err.message) || String(err) });
  }
  return updateStatus;
}

function scheduleUpdateCheck(delay = 15000) {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (!app.isPackaged || !readUpdateConfig().source) return;
  setTimeout(() => void checkForUpdates(), delay).unref?.();
  updateTimer = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
  updateTimer.unref?.();
}

function setupUpdaterIpc() {
  // 反馈9：右键菜单的复制/粘贴走主进程剪贴板，避免浏览器异步剪贴板权限弹窗。
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());
  ipcMain.handle('clipboard:write-text', (_event, text) =>
    clipboard.writeText(typeof text === 'string' ? text : ''),
  );
  // 反馈1323#09：本机目录用系统文件夹对话框选择。渲染层只在
  // 「桌面版 + 所选主机 hostId 等于 localHostId」时调用。
  ipcMain.handle('host:local-id', () => localHostId);
  ipcMain.handle('folder:pick', async (event, options) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? win;
    const defaultPath =
      options && typeof options.defaultPath === 'string' && options.defaultPath
        ? options.defaultPath
        : undefined;
    const dialogOptions = {
      title: '打开文件夹',
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('updater:get-config', () => readUpdateConfig());
  ipcMain.handle('updater:set-config', (_event, config) => {
    const saved = writeUpdateConfig(config);
    scheduleUpdateCheck(500);
    if (!saved.source) sendUpdateStatus({ state: 'idle' });
    return saved;
  });
  ipcMain.handle('updater:check', () => checkForUpdates());
  ipcMain.handle('updater:status', () => updateStatus);
  ipcMain.handle('updater:install', () => {
    if (updateStatus.state !== 'downloaded') return;
    quitting = true;
    autoUpdater().quitAndInstall(false, true);
  });
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
    if (mobilePreview) {
      mobilePreview.register({
        getHostUrl: () => hostUrl,
        getTheme: theme,
        iconFile,
        preloadPath: path.join(__dirname, 'preload.js'),
        isAppUrl,
      });
    }
    if (feedbackDrafts) feedbackDrafts.register();
    createWindow();
    createTray();
    setupUpdaterIpc();
    if (app.isPackaged) setupUpdater();
    scheduleUpdateCheck();

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

  app.on('will-quit', stopLocalUpdateServer);

  app.on('window-all-closed', () => {
    if (isMac) return;
    // 窗口只是隐藏到托盘，保留 Host 进程
  });
}
