import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getChanges, getFileDiff, repoRelativePath } from '../src/changes.js';

function tempRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tandem-changes-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('仓库内相对路径：统一 posix 分隔符并保留中文', () => {
  const root = path.resolve('/tmp/repo');
  assert.equal(repoRelativePath(root, 'src/a.ts'), 'src/a.ts');
  assert.equal(repoRelativePath(root, 'src\\a.ts'), 'src/a.ts');
  assert.equal(repoRelativePath(root, './docs/中文.md'), 'docs/中文.md');
});

test('仓库路径校验：拒绝绝对路径、目录穿越与空路径', () => {
  const root = path.resolve('/tmp/repo');
  assert.throws(() => repoRelativePath(root, '/etc/passwd'), /只接受仓库内相对路径/);
  assert.throws(() => repoRelativePath(root, '../outside.txt'), /路径不在仓库内/);
  assert.throws(() => repoRelativePath(root, ''), /不能为空/);
  assert.throws(() => repoRelativePath(root, '.'), /仓库根目录/);
});

test('未跟踪目录被 git 折叠时仍能列出其中文件并生成 diff', async (t) => {
  const root = tempRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'build-lease'), { recursive: true });
  writeFileSync(path.join(root, 'build-lease', 'CMakeCache.txt'), 'hello\nworld\n');

  const changes = await getChanges(root);
  assert.equal(changes.isRepo, true);
  assert.ok(changes.files.some((file) => file.path === 'build-lease/CMakeCache.txt'));

  const diff = await getFileDiff(root, 'build-lease/CMakeCache.txt');
  assert.equal(diff.path, 'build-lease/CMakeCache.txt');
  assert.match(diff.diff, /\+hello/);
  assert.equal(diff.emptyReason, undefined);
});

test('工作区改动按路径统计增删行数', async (t) => {
  const root = tempRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], {
    cwd: root,
  });
  writeFileSync(path.join(root, 'a.txt'), 'one\nchanged\nthree\n');

  const changes = await getChanges(root);
  const file = changes.files.find((item) => item.path === 'a.txt');
  assert.ok(file);
  assert.equal(file.status, 'modified');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
});
