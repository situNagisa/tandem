#!/usr/bin/env node
/**
 * 打主机安装包：packages/server/host-pack/tandem-host.tgz（Unix）与 tandem-host.zip（Windows）。
 * 包内根目录：dist/ + node_modules/ + package.json（解压后可直接 node dist/cli.js）。
 * 工作站用 GET /dl/tandem-host.tgz | /dl/tandem-host.zip 下发；安装脚本解压后运行 CLI。
 *
 * 只打运行所需文件：测试夹具、文档、示例、源码映射与 .ts 一并剔除；路径必须全为 ASCII
 * （Windows 自带 tar 遇到非 ASCII 路径会报 “Invalid empty pathname”），且必须有 dist/cli.js。
 * Windows 安装脚本用 Expand-Archive 解压 ZIP，不依赖 tar。
 *
 * 前置：npm run build -w @tandem/server（需要 dist/cli.js 与 flavor）。
 * 用法：node scripts/pack-host.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDependencyCopier } from './lib/dep-closure.mjs';
import { assertPackable, collectFiles, filterNativeModules, pruneRuntime, zipDirectory } from './lib/host-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'packages', 'server');
const DIST_DIR = path.join(SERVER_DIR, 'dist');
const OUT_DIR = path.join(SERVER_DIR, 'host-pack');
const TGZ_FILE = path.join(OUT_DIR, 'tandem-host.tgz');
const ZIP_FILE = path.join(OUT_DIR, 'tandem-host.zip');

if (!fs.existsSync(path.join(DIST_DIR, 'cli.js'))) {
  throw new Error('packages/server/dist 尚未构建：先运行 npm run build -w @tandem/server');
}

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-host-pack-'));
try {
  fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
  fs.cpSync(DIST_DIR, path.join(stage, 'dist'), { recursive: true, dereference: true });
  fs.copyFileSync(path.join(SERVER_DIR, 'package.json'), path.join(stage, 'package.json'));

  // 生产依赖闭包（npm workspaces 顶层 node_modules，按包解析）。
  const { copyPackage } = createDependencyCopier({
    fallbackNodeModules: path.join(stage, 'node_modules'),
    warn: (msg) => console.warn(`[pack-host] ${msg}`),
  });
  copyPackage(SERVER_DIR, stage);
  // 上一次生成的安装包（host-pack/）也在 server 目录里：不能在打包时把自己收进去。
  for (const extra of ['src', 'test', 'host-pack', 'tsconfig.json', 'package-lock.json']) {
    fs.rmSync(path.join(stage, extra), { recursive: true, force: true });
  }
  const removed = pruneRuntime(stage);
  const entries = collectFiles(stage);
  // 原生预编译模块按目标平台裁剪：在 WSL 里打包时，node_modules 里同时躺着各平台的 .node；
  // Windows 包只留 win32-*，Unix 包只留 linux-*/darwin-*。否则 Windows 上 dlopen Linux 模块会崩。
  const unixEntries = filterNativeModules(entries, 'unix');
  const winEntries = filterNativeModules(entries, 'win32');
  assertPackable(unixEntries, { target: 'unix' });
  assertPackable(winEntries, { target: 'win32' });
  fs.chmodSync(path.join(stage, 'dist', 'cli.js'), 0o755);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(TGZ_FILE, { force: true });
  fs.rmSync(ZIP_FILE, { force: true });
  execFileSync('tar', ['-czf', TGZ_FILE, '-C', stage, ...unixEntries], { stdio: 'inherit' });
  fs.writeFileSync(ZIP_FILE, zipDirectory(stage, winEntries));

  const size = (file) => fs.statSync(file).size;
  const deps = fs.existsSync(path.join(stage, 'node_modules')) ? fs.readdirSync(path.join(stage, 'node_modules')).length : 0;
  const dropped = entries.length - winEntries.length;
  console.log(
    `[pack-host] 完成：tandem-host.tgz ${(size(TGZ_FILE) / 1024 / 1024).toFixed(1)} MB、` +
      `tandem-host.zip ${(size(ZIP_FILE) / 1024 / 1024).toFixed(1)} MB（v${pkg.version}，` +
      `tgz ${unixEntries.length} / zip ${winEntries.length} 个文件（${dropped} 个别平台原生模块未进 zip），` +
      `node_modules 顶层 ${deps} 项，剔除 ${removed} 个非运行时文件）`,
  );
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
