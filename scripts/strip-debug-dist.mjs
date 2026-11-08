#!/usr/bin/env node
/**
 * 发布构建后处理：从 packages/server/dist 移除调试专用模块。
 *
 * 演示路由、演示剧本、种子数据、内置演示模型与演示设备都不进入发布产物；
 * 仍被正常模块静态引用的设备演示文件换成空实现，保证发布版启动不报错。
 * 同时把 dist/flavor.js 固定为 release，避免运行时默认回到 debug。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDist = path.join(ROOT, 'packages', 'server', 'dist')

if (!fs.existsSync(path.join(serverDist, 'flavor.js'))) {
  console.error('[strip-debug] 未找到 server dist/flavor.js，请先构建 server。')
  process.exit(1)
}

function remove(relative) {
  const targets = [relative, `${relative}.map`].map((file) => path.join(serverDist, file))
  for (const target of targets) {
    if (fs.existsSync(target)) {
      fs.rmSync(target)
      console.log(`[strip-debug] 移除 ${path.relative(serverDist, target)}`)
    }
  }
}

function write(relative, content) {
  const target = path.join(serverDist, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  remove(`${relative}.map`)
}

// 演示工作区本体：剧本、种子、内置 provider 与管理器。
for (const file of ['demo/manager.js', 'demo/provider.js', 'demo/scenarios.js', 'demo/seed.js', 'demo/seed.js']) {
  remove(file)
}
// 启动期按 flavor 动态加载的调试入口。
for (const file of ['debug/demoRoutes.js', 'debug/demoProvider.js']) {
  remove(file)
}
if (fs.existsSync(path.join(serverDist, 'debug')) && fs.readdirSync(path.join(serverDist, 'debug')).length === 0) {
  fs.rmdirSync(path.join(serverDist, 'debug'))
}
remove('routes/demo.js')

// devices/manager.js 仍静态引用演示设备提供者：换成不暴露任何假设备的空实现。
write(
  'devices/demo.js',
  `export const DEMO_ADB_ID = 'adb:demo-pixel-8';
export const DEMO_SERIAL_ID = 'serial:demo-board';
const DEMO_IDS = new Set([DEMO_ADB_ID, DEMO_SERIAL_ID]);
export function isDemoDevice(deviceId) {
  return DEMO_IDS.has(deviceId);
}
export function demoDeviceInfos() {
  return [];
}
export function runDemoAdb() {
  return { ok: false, output: 'Not available in this build', exitCode: 1 };
}
export function demoLogcatLine() {
  return '';
}
export function createDemoBoardConnection() {
  throw new Error('Not available in this build');
}
`,
)

// 固定风味，避免已安装的发布版依赖环境变量。
write(
  'flavor.js',
  `export const FLAVOR = 'release';
export const IS_DEBUG_FLAVOR = false;
`,
)

console.log('[strip-debug] 发布版 server dist 已剔除调试模块')
