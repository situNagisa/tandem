import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { expandHome, isSubPath, normalizeIncomingPath, resolveHostPath } from '../src/util/path.js';

test('Windows 路径归一化：正反斜杠、盘符前多余斜杠、.. 折叠', () => {
  assert.equal(normalizeIncomingPath('D:/repo/src/../a.ts', 'win32'), 'D:\\repo\\a.ts');
  assert.equal(normalizeIncomingPath('/D:/repo/a.ts', 'win32'), 'D:\\repo\\a.ts');
  assert.equal(normalizeIncomingPath('C:\\repo\\a.ts', 'win32'), 'C:\\repo\\a.ts');
  assert.equal(normalizeIncomingPath('  /D:/repo//a.ts  ', 'win32'), 'D:\\repo\\a.ts');
});

test('file:// 链接解码为本地路径', () => {
  assert.equal(
    normalizeIncomingPath('file:///D:/reports/%E4%B8%AD%E6%96%87.md', 'win32'),
    'D:\\reports\\中文.md',
  );
  assert.equal(normalizeIncomingPath('file:///tmp/a%20b.ts', 'posix'), '/tmp/a b.ts');
});

test('posix 保留反斜杠（合法文件名字符），不误当分隔符', () => {
  assert.equal(normalizeIncomingPath('/tmp/a\\b.ts', 'posix'), '/tmp/a\\b.ts');
});

test('相对路径以 cwd 为基准解析（Windows 使用 win32 语义）', () => {
  assert.equal(resolveHostPath('src/a.ts', 'D:\\repo', 'win32'), 'D:\\repo\\src\\a.ts');
  assert.equal(resolveHostPath('../a.ts', '/tmp/repo', 'posix'), '/tmp/a.ts');
  assert.equal(resolveHostPath('D:/repo/a.ts', 'C:\\other', 'win32'), 'D:\\repo\\a.ts');
});

test('~ 展开到当前用户主目录', () => {
  assert.equal(expandHome('~/repo/a.ts'), path.join(os.homedir(), 'repo/a.ts'));
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('/abs/a.ts'), '/abs/a.ts');
});

test('isSubPath 拦截目录穿越', () => {
  const root = path.resolve('/tmp/tandem-sub');
  assert.equal(isSubPath(root, path.join(root, 'a/b.txt')), true);
  assert.equal(isSubPath(root, root), true);
  assert.equal(isSubPath(root, path.resolve('/tmp/tandem-sub-other/a.txt')), false);
  assert.equal(isSubPath(root, path.resolve('/tmp/a.txt')), false);
});
