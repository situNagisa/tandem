'use strict';
// 仅向 web 暴露最小标识，供页面识别桌面端（拖拽区、红绿灯留白等）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tandemDesktop', {
  platform: process.platform,
  isDesktop: true,
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
  // 手机预览：仅调试版主进程注册；发布版调用会返回不可用。
  mobilePreview: {
    open: (options) => ipcRenderer.invoke('mobile-preview:open', options),
    configure: (options) => ipcRenderer.invoke('mobile-preview:configure', options),
  },
});
