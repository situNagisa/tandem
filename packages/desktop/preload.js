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
});
