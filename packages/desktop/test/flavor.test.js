'use strict';
// 产物风味测试：不依赖任何 TANDEM_FLAVOR 环境变量，直接检查构建写入的常量。
// debug 构建默认断言 debug；release 构建由 check-release 传 TANDEM_EXPECT_FLAVOR=release。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveFlavor,
  isDebugFlavor,
  feedbackRootFor,
  shouldEnableDebugAccount,
} = require('../flavor-core.js');

const ROOT = path.resolve(__dirname, '../../..');
const expected = process.env.TANDEM_EXPECT_FLAVOR === 'release' ? 'release' : 'debug';

function artifact(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('flavor 只认构建期常量，缺失时按是否打包兜底', () => {
  delete process.env.TANDEM_FLAVOR;
  assert.equal(resolveFlavor({ FLAVOR: 'debug' }, { packaged: true }), 'debug');
  assert.equal(resolveFlavor({ FLAVOR: 'release' }, { packaged: true }), 'release');
  assert.equal(resolveFlavor(null, { packaged: true }), 'release');
  assert.equal(resolveFlavor(null, { packaged: false }), 'debug');
  assert.equal(isDebugFlavor({ FLAVOR: 'debug' }, { packaged: true }), true);
});

test('桌面与 Host 产物里是写死的 flavor 常量', () => {
  const generated = require('../flavor.generated.js');
  assert.equal(generated.FLAVOR, expected, 'desktop flavor.generated.js 应等于本次构建风味');
  assert.equal(generated.IS_DEBUG_FLAVOR, expected === 'debug');
  assert.equal(resolveFlavor(generated, { packaged: true }), expected);

  const serverFlavor = artifact('packages/server/dist/flavor.js');
  assert.match(serverFlavor, new RegExp(`export const FLAVOR = '${expected}'`));
  assert.match(
    serverFlavor,
    new RegExp(`export const IS_DEBUG_FLAVOR = ${expected === 'debug'}`),
  );
  assert.ok(
    !serverFlavor.includes('process.env.TANDEM_FLAVOR'),
    'Host 产物不应在运行时读 TANDEM_FLAVOR',
  );
});

test('桌面主进程与 preload 带调试桥接，且不靠环境变量决定风味', () => {
  const main = artifact('packages/desktop/main.js');
  assert.ok(main.includes("require('./flavor.generated.js')"), '主进程应读取构建期 flavor');
  assert.ok(!main.includes('process.env.TANDEM_FLAVOR'), '主进程不应读 flavor 环境变量');
  assert.ok(main.includes("require('./feedback-drafts.js')"), '主进程应加载草稿落盘模块');
  assert.ok(
    main.includes('--tandem-flavor='),
    '主进程应把构建期风味传给 sandbox preload',
  );

  const preload = artifact('packages/desktop/preload.js');
  for (const handler of [
    'feedback:sync-draft',
    'feedback:mark-exported',
    'feedback:remove-draft',
    'feedback:export-archive',
  ]) {
    assert.ok(preload.includes(handler), `preload 应暴露 ${handler}`);
  }

  const drafts = artifact('packages/desktop/feedback-drafts.js');
  for (const handler of [
    'feedback:sync-draft',
    'feedback:mark-exported',
    'feedback:remove-draft',
    'feedback:export-archive',
  ]) {
    assert.ok(drafts.includes(handler), `主进程应注册 ${handler}`);
  }
});

test('草稿目录固定为 <下载>/Tandem 反馈', () => {
  assert.equal(
    feedbackRootFor(path.join('/home', 'u', 'Downloads')),
    path.join('/home', 'u', 'Downloads', 'Tandem 反馈'),
  );
});

test('调试账号只在该构建为 debug 时启用', () => {
  assert.equal(shouldEnableDebugAccount({ isDebug: true, isElectron: true }), true);
  assert.equal(shouldEnableDebugAccount({ isDebug: false, isElectron: true }), false);
  assert.equal(
    shouldEnableDebugAccount({ isDebug: true, isElectron: false, envFlag: '1' }),
    true,
  );
  assert.equal(
    shouldEnableDebugAccount({ isDebug: true, isElectron: false, envFlag: null }),
    false,
  );
});
