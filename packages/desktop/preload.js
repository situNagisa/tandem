'use strict';
// 仅向 web 暴露最小标识，供页面识别桌面端（拖拽区、红绿灯留白等）。
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('tandemDesktop', {
  platform: process.platform,
  isDesktop: true,
});
