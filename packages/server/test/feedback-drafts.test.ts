import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../desktop/feedback-drafts-core.js');

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'tandem-draft-'));
}

test('草稿目录写入是原子的：无临时文件残留，内容完整', () => {
  const root = tempRoot();
  try {
    const dir = core.draftDirFor(root, '草稿-20261109-1530');
    core.syncDraftDir(dir, [
      { path: 'feedback.md', text: '# 反馈\n' },
      { path: '01-元素截图.png', base64: Buffer.from([1, 2, 3]).toString('base64') },
      { path: 'manifest.json', text: '{"version":1}\n' },
    ]);
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['01-元素截图.png', 'feedback.md', 'manifest.json']);
    assert.equal(readFileSync(path.join(dir, 'feedback.md'), 'utf8'), '# 反馈\n');
    assert.deepEqual([...readFileSync(path.join(dir, '01-元素截图.png'))], [1, 2, 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('删除条目后旧编号文件被清掉，导出标记保留', () => {
  const root = tempRoot();
  try {
    const dir = core.draftDirFor(root, '草稿-20261109-1530');
    core.syncDraftDir(dir, [
      { path: '01-元素截图.png', base64: '' },
      { path: '02-元素截图.png', base64: '' },
    ]);
    core.markExportedDir(dir, 1_700_000_000_000);
    core.syncDraftDir(dir, [{ path: '01-元素截图.png', base64: '' }]);
    assert.deepEqual(readdirSync(dir).sort(), ['.exported.json', '01-元素截图.png']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非法目录名/文件名被拒绝（防路径穿越）', () => {
  const root = tempRoot();
  try {
    assert.throws(() => core.draftDirFor(root, '../evil'));
    assert.throws(() => core.draftDirFor(root, '草稿-2026'));
    const dir = core.draftDirFor(root, '草稿-20261109-1530');
    assert.throws(() => core.syncDraftDir(dir, [{ path: '../x.png', text: '' }]));
    assert.throws(() => core.syncDraftDir(dir, [{ path: 'a/b.png', text: '' }]));
    assert.throws(() => core.exportArchiveFile(root, '../tandem-feedback-1.tfb', ''));
    assert.throws(() => core.exportArchiveFile(root, 'x.tfb', ''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('已导出草稿 7 天后清理，未导出的保留', () => {
  const root = tempRoot();
  try {
    const exported = core.draftDirFor(root, '草稿-20261101-0900');
    const unexported = core.draftDirFor(root, '草稿-20261102-0900');
    core.syncDraftDir(exported, [{ path: 'feedback.md', text: 'old' }]);
    core.markExportedDir(exported, 1_700_000_000_000);
    core.syncDraftDir(unexported, [{ path: 'feedback.md', text: 'keep' }]);
    const removed = core.pruneDrafts(root, 1_700_000_000_000 + 8 * 24 * 60 * 60 * 1000);
    assert.deepEqual(removed, ['草稿-20261101-0900']);
    assert.ok(!readdirSync(root).includes('草稿-20261101-0900'));
    assert.ok(readdirSync(root).includes('草稿-20261102-0900'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('导出包落在「Tandem 反馈」目录，文件名受限', () => {
  const root = tempRoot();
  try {
    mkdirSync(root, { recursive: true });
    const target = core.exportArchiveFile(
      root,
      'tandem-feedback-20261109-1530.tfb',
      Buffer.from('zip').toString('base64'),
    );
    assert.equal(path.dirname(target), root);
    assert.equal(readFileSync(target, 'utf8'), 'zip');
    writeFileSync(path.join(root, 'keep.txt'), 'x');
    assert.ok(readdirSync(root).includes('keep.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
