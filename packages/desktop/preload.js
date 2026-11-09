'use strict';
// 仅向 web 暴露最小标识，供页面识别桌面端（拖拽区、红绿灯留白等）。
const { contextBridge, ipcRenderer } = require('electron');

// sandbox 下 preload 不能 require 本地 flavor.generated.js；主进程用构建期常量
// 通过 additionalArguments 传入，发布版默认按 release 处理。
const flavorArg = process.argv.find((arg) => arg.startsWith('--tandem-flavor='));
const flavor = flavorArg ? flavorArg.slice('--tandem-flavor='.length) : 'release';
const debugFlavor = flavor === 'debug';

const api = {
  platform: process.platform,
  isDesktop: true,
  flavor,
  updater: {
    getConfig: () => ipcRenderer.invoke('updater:get-config'),
    setConfig: (config) => ipcRenderer.invoke('updater:set-config', config),
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    status: () => ipcRenderer.invoke('updater:status'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
  },
  // 反馈9：页面右键菜单使用系统剪贴板（不触发浏览器剪贴板权限弹窗）。
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:read-text'),
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  },
};

if (debugFlavor) {
  // 手机预览：仅调试版主进程注册；发布版不暴露入口。
  api.mobilePreview = {
    open: (options) => ipcRenderer.invoke('mobile-preview:open', options),
    configure: (options) => ipcRenderer.invoke('mobile-preview:configure', options),
  };
  // 反馈草稿实时落盘与 .tfb 导出：同样只在调试版主进程注册。
  api.feedback = {
    // 原生页面截图（CSS px 矩形），长会话里比页内 DOM 克隆快得多。
    capturePage: (rect) => ipcRenderer.invoke('feedback:capture-page', rect),
    syncDraft: (draftId, files) => ipcRenderer.invoke('feedback:sync-draft', { draftId, files }),
    markExported: (draftId) => ipcRenderer.invoke('feedback:mark-exported', { draftId }),
    removeDraft: (draftId) => ipcRenderer.invoke('feedback:remove-draft', { draftId }),
    exportArchive: (filename, base64) =>
      ipcRenderer.invoke('feedback:export-archive', { filename, base64 }),
    openFolder: (target) => ipcRenderer.invoke('feedback:open-folder', { target }),
    dir: () => ipcRenderer.invoke('feedback:dir'),
    prune: () => ipcRenderer.invoke('feedback:prune'),
  };
}

contextBridge.exposeInMainWorld('tandemDesktop', api);
