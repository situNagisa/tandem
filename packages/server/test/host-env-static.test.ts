// 已迁移到 ctx.env 的工具文件不得再直接访问本机文件系统或进程。每迁移一个工具文件，把它加进 MIGRATED。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const MIGRATED = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'bash-output', 'kill-bash'];
const FORBIDDEN = [
  /from ['"]node:fs(\/promises)?['"]/,
  /from ['"]node:child_process['"]/,
  /from ['"]\.\.\/util\/fs-walk\.js['"]/,
];

const toolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/tools');

test('已迁移的工具只经 ctx.env 访问机器', () => {
  for (const name of MIGRATED) {
    const src = readFileSync(path.join(toolsDir, `${name}.ts`), 'utf8');
    for (const re of FORBIDDEN) assert.doesNotMatch(src, re, `${name}.ts 不得直接 import：${re}`);
  }
});
