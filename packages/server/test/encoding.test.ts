import assert from 'node:assert/strict';
import test from 'node:test';
import { cmdUtf8Command, decodeProcessOutput } from '../src/util/encoding.js';

test('UTF-8 输出原样解码（中文不被改动）', () => {
  const bytes = new TextEncoder().encode('构建完成：12 个测试通过');
  assert.equal(decodeProcessOutput(bytes), '构建完成：12 个测试通过');
});

test('非 UTF-8 字节回退 GBK 解码（Windows cmd 中文输出）', () => {
  // “中文”的 GBK/CP936 编码
  assert.equal(decodeProcessOutput(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])), '中文');
});

test('空输出与损坏字节不抛错', () => {
  assert.equal(decodeProcessOutput(new Uint8Array()), '');
  assert.doesNotThrow(() => decodeProcessOutput(Uint8Array.from([0xff, 0xfe, 0xfd])));
});

test('cmd.exe 先切 65001 再执行原命令', () => {
  assert.equal(cmdUtf8Command('dir'), 'chcp 65001 >NUL & dir');
});
