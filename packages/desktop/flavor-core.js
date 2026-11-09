'use strict';
// 桌面端 flavor 决策与路径的纯函数，供主进程与产物测试共用：
// flavor 只认构建时写入的 flavor.generated.js，运行时不读环境变量。
const path = require('node:path');

const FEEDBACK_DIR_NAME = 'Tandem 反馈';

/** generated 为 flavor.generated.js 的 module.exports；缺失时按是否打包兜底。 */
function resolveFlavor(generated, options = {}) {
  const value = generated && generated.FLAVOR;
  if (value === 'debug' || value === 'release') return value;
  return options.packaged ? 'release' : 'debug';
}

function isDebugFlavor(generated, options = {}) {
  return resolveFlavor(generated, options) === 'debug';
}

/** 反馈草稿/导出默认目录：<下载>/Tandem 反馈/。 */
function feedbackRootFor(downloadsDir) {
  return path.join(downloadsDir, FEEDBACK_DIR_NAME);
}

/** 调试账号只在 debug 构建、且桌面进程或显式联调开关下启用。 */
function shouldEnableDebugAccount({ isDebug, isElectron, envFlag }) {
  return !!isDebug && (!!isElectron || envFlag === '1');
}

module.exports = {
  FEEDBACK_DIR_NAME,
  resolveFlavor,
  isDebugFlavor,
  feedbackRootFor,
  shouldEnableDebugAccount,
};
