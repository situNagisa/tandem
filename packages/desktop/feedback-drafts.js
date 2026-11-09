'use strict';
// 调试版「反馈草稿实时落盘」：把 web 端记录的条目写进 <下载>/Tandem 反馈/，
// 导出 .tfb 默认也存这里。发布版主进程不 require 这个模块。
const { app, ipcMain, shell, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  draftDirFor,
  syncDraftDir,
  markExportedDir,
  pruneDrafts,
  exportArchiveFile,
  removeDraftDir,
} = require('./feedback-drafts-core.js');
const { feedbackRootFor } = require('./flavor-core.js');

let rootDir = null;
/** 串行化同步，避免两个请求同时 rename 同一个目录。 */
let queue = Promise.resolve();

function root() {
  if (!rootDir) rootDir = feedbackRootFor(app.getPath('downloads'));
  return rootDir;
}

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function insideRoot(target) {
  const resolved = path.resolve(String(target ?? ''));
  const base = path.resolve(root());
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : root();
}

function register() {
  // 反馈截图：桌面端直接用 Chromium 的原生页面捕获，长会话里不必克隆 DOM。
  // rect 是 CSS px（= DIP），capturePage 会按窗口缩放返回原生像素。
  ipcMain.handle('feedback:capture-page', async (event, payload) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
      const bounds = win.getContentBounds();
      const clamp = (value, max) => Math.max(0, Math.min(Number(value) || 0, max));
      const x = clamp(payload?.x, bounds.width);
      const y = clamp(payload?.y, bounds.height);
      const width = Math.max(1, Math.min(Number(payload?.width) || bounds.width, bounds.width - x));
      const height = Math.max(1, Math.min(Number(payload?.height) || bounds.height, bounds.height - y));
      const image = await win.webContents.capturePage({ x, y, width, height });
      if (image.isEmpty()) return { ok: false, error: 'empty image' };
      return { ok: true, dataURL: image.toDataURL() };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('feedback:sync-draft', (_event, payload) =>
    enqueue(async () => {
      try {
        const draftId = payload?.draftId;
        const dir = draftDirFor(root(), draftId);
        const result = syncDraftDir(dir, payload?.files ?? []);
        return { ok: true, dir: result.dir };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    }),
  );

  ipcMain.handle('feedback:mark-exported', (_event, payload) =>
    enqueue(async () => {
      try {
        const dir = draftDirFor(root(), payload?.draftId);
        markExportedDir(dir);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    }),
  );

  ipcMain.handle('feedback:remove-draft', (_event, payload) =>
    enqueue(async () => {
      try {
        removeDraftDir(draftDirFor(root(), payload?.draftId));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    }),
  );

  ipcMain.handle('feedback:export-archive', (_event, payload) =>
    enqueue(async () => {
      try {
        const target = exportArchiveFile(root(), payload?.filename, payload?.base64);
        return { ok: true, path: target };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    }),
  );

  ipcMain.handle('feedback:open-folder', async (_event, payload) => {
    try {
      const target = insideRoot(payload?.target ?? root());
      const stat = fs.statSync(target, { throwIfNoEntry: false });
      if (stat && stat.isFile()) shell.showItemInFolder(target);
      else await shell.openPath(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('feedback:dir', () => {
    try {
      return { dir: root() };
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('feedback:prune', () =>
    enqueue(async () => ({ removed: pruneDrafts(root()).length })),
  );

  // 启动时清理超过 7 天的已导出草稿；未导出的永远保留。
  enqueue(async () => {
    try {
      pruneDrafts(root());
    } catch {
      // 下载目录不可写等场景忽略
    }
  });
}

module.exports = { register, root };
