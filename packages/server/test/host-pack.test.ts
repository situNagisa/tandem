// 主机安装包：只收运行时文件（排除测试夹具/文档/示例）、路径必须 ASCII、ZIP 可被标准解压器读取。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
// @ts-expect-error 打包脚本是 .mjs，无类型声明；这里只测纯函数。
import { assertPackable, collectFiles, createZip, filterNativeModules, isRuntimeFile, nativeModulePlatform, pruneRuntime } from '../../../scripts/lib/host-pack.mjs';

test('运行所需文件过滤：测试夹具/文档/示例/源码映射不进包', () => {
  assert.equal(isRuntimeFile('dist/cli.js'), true);
  assert.equal(isRuntimeFile('package.json'), true);
  assert.equal(isRuntimeFile('node_modules/fastify/fastify.js'), true);
  assert.equal(isRuntimeFile('node_modules/serialport/prebuilds/linux-x64/node.napi.node'), true);
  assert.equal(isRuntimeFile('node_modules/@fastify/send/test/fixtures/snow ☃/index.html'), false);
  assert.equal(isRuntimeFile('node_modules/thread-stream/test/helper.js'), false);
  assert.equal(isRuntimeFile('node_modules/@fastify/send/docs/readme.md'), false);
  assert.equal(isRuntimeFile('node_modules/fastify/examples/basic.js'), false);
  assert.equal(isRuntimeFile('dist/cli.js.map'), false);
  assert.equal(isRuntimeFile('node_modules/pkg/index.d.ts'), false);
});

test('pruneRuntime 删除非运行时文件与空目录，保留 dist/cli.js', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tandem-pack-prune-'));
  try {
    const write = (rel: string, text = 'x') => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    };
    write('dist/cli.js', 'console.log(1)');
    write('package.json', '{}');
    write('node_modules/pkg/index.js');
    write('node_modules/pkg/test/fixtures/snow ☃/index.html');
    write('node_modules/pkg/docs/readme.md');
    const removed = pruneRuntime(root);
    assert.ok(removed >= 2, `应剔除夹具与文档（实际 ${removed}）`);
    const left = collectFiles(root).sort();
    assert.deepEqual(left, ['dist/cli.js', 'node_modules/pkg/index.js', 'package.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertPackable：非 ASCII 路径、缺失 dist/cli.js 直接失败', () => {
  assert.doesNotThrow(() => assertPackable(['dist/cli.js', 'package.json', 'node_modules/a/b.js']));
  assert.throws(() => assertPackable(['dist/cli.js', 'package.json', 'node_modules/@fastify/send/test/fixtures/snow ☃/index.html']), /ASCII/);
  assert.throws(() => assertPackable(['dist/cli.js', 'package.json', 'dist\\cli.js']), /分隔符/);
  assert.throws(() => assertPackable(['package.json']), /dist\/cli\.js/);
});

const SERIAL = 'node_modules/@serialport/bindings-cpp/prebuilds';

test('原生模块按平台识别', () => {
  assert.equal(nativeModulePlatform(`${SERIAL}/win32-x64/@serialport+bindings-cpp.node`), 'win32-x64');
  assert.equal(nativeModulePlatform(`${SERIAL}/linux-x64/@serialport+bindings-cpp.glibc.node`), 'linux-x64');
  assert.equal(nativeModulePlatform('node_modules/pkg/build/Release/native.node'), 'unknown');
  assert.equal(nativeModulePlatform('node_modules/pkg/index.js'), undefined);
});

test('filterNativeModules：Windows 包只留 win32，Unix 包留 linux/darwin', () => {
  const entries = [
    'dist/cli.js',
    'package.json',
    `${SERIAL}/win32-x64/@serialport+bindings-cpp.node`,
    `${SERIAL}/win32-arm64/@serialport+bindings-cpp.armv8.node`,
    `${SERIAL}/linux-x64/@serialport+bindings-cpp.glibc.node`,
    `${SERIAL}/linux-arm64/@serialport+bindings-cpp.armv8.glibc.node`,
    `${SERIAL}/darwin-x64+arm64/@serialport+bindings-cpp.node`,
    `${SERIAL}/android-arm/@serialport+bindings-cpp.armv7.node`,
    'node_modules/@serialport/bindings-cpp/dist/index.js',
  ];
  const win = filterNativeModules(entries, 'win32');
  assert.deepEqual(
    win.filter((rel: string) => rel.endsWith('.node')).sort(),
    [`${SERIAL}/win32-arm64/@serialport+bindings-cpp.armv8.node`, `${SERIAL}/win32-x64/@serialport+bindings-cpp.node`],
  );
  assert.ok(win.includes('node_modules/@serialport/bindings-cpp/dist/index.js'), '普通 js 不受影响');
  const unix = filterNativeModules(entries, 'unix');
  assert.deepEqual(
    unix.filter((rel: string) => rel.endsWith('.node')).sort(),
    [
      `${SERIAL}/darwin-x64+arm64/@serialport+bindings-cpp.node`,
      `${SERIAL}/linux-arm64/@serialport+bindings-cpp.armv8.glibc.node`,
      `${SERIAL}/linux-x64/@serialport+bindings-cpp.glibc.node`,
    ],
  );
  assert.throws(() => filterNativeModules(entries, 'solaris'), /未知打包目标/);
});

test('assertPackable：Windows 包混入 Linux 原生模块必须失败（R56 复发防线）', () => {
  const base = ['dist/cli.js', 'package.json', `${SERIAL}/win32-x64/@serialport+bindings-cpp.node`];
  assert.doesNotThrow(() => assertPackable(base, { target: 'win32' }));
  assert.throws(
    () => assertPackable([...base, `${SERIAL}/linux-x64/@serialport+bindings-cpp.glibc.node`], { target: 'win32' }),
    /linux-x64 平台的原生模块/,
  );
  assert.throws(
    () => assertPackable(['dist/cli.js', 'package.json', 'node_modules/@serialport/bindings-cpp/dist/index.js'], { target: 'win32' }),
    /缺少 @serialport\/bindings-cpp 的 win32-x64/,
  );
  assert.throws(
    () => assertPackable(['dist/cli.js', 'package.json', 'node_modules/pkg/build/Release/native.node'], { target: 'win32' }),
    /无法判断平台/,
  );
  const unix = ['dist/cli.js', 'package.json', `${SERIAL}/linux-x64/@serialport+bindings-cpp.glibc.node`];
  assert.doesNotThrow(() => assertPackable(unix, { target: 'unix' }));
  assert.throws(() => assertPackable([...unix, `${SERIAL}/win32-x64/@serialport+bindings-cpp.node`], { target: 'unix' }), /win32-x64/);
});

test('createZip：生成标准 ZIP，能用中央目录读出全部文件', () => {
  const files = [
    { name: 'dist/cli.js', data: Buffer.from('#!/usr/bin/env node\nconsole.log("tandem")\n') },
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: 'tandem-host', version: '1.2.3' })) },
    { name: 'node_modules/pkg/index.js', data: Buffer.from('module.exports = 1;\n'.repeat(50)) },
  ];
  const zip = createZip(files);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, '应以本地文件头开始');
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, '应有 EOCD');
  const count = zip.readUInt16LE(eocd + 10);
  assert.equal(count, files.length);
  let offset = zip.readUInt32LE(eocd + 16);
  const read: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, '中央目录记录');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.match(name, /^[\x20-\x7e]+$/, 'ZIP 内路径必须是 ASCII');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(dataStart, dataStart + compressedSize);
    read[name] = (method === 8 ? zlib.inflateRawSync(body) : body).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
  }
  for (const file of files) {
    assert.equal(read[file.name], file.data.toString('utf8'), `${file.name} 内容应一致`);
  }
});

test('createZip：拒绝非 ASCII 文件名（Windows 解压会乱码/失败）', () => {
  assert.throws(() => createZip([{ name: 'dist/雪.js', data: Buffer.from('x') }]), /ASCII/);
});
