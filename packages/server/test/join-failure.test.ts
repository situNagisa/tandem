// join 失败归因：不同原因给不同提示（R56：以前一律说「绑定码过期」，误导）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { explainJoinFailure } from '../src/workstation/joinFailure.js';

test('绑定码失效：提示重新生成，不说成令牌问题', () => {
  const explained = explainJoinFailure({ status: 502, message: '绑定码无效、已使用或已过期', workstationUrl: 'http://127.0.0.1:8481' });
  assert.equal(explained.kind, 'bind-code');
  assert.match(explained.hints.join('\n'), /15 分钟/);
});

test('本机端口被另一个 Tandem Host 占用（Host 401）：提示换端口', () => {
  const explained = explainJoinFailure({ status: 401, message: '未授权：token 无效或已被吊销', hostPort: 7878 });
  assert.equal(explained.kind, 'host-token');
  assert.match(explained.title, /127\.0\.0\.1:7878/);
  assert.match(explained.hints.join('\n'), /--port 7879/);
});

test('工作站不可达：提示查地址/防火墙', () => {
  const explained = explainJoinFailure({ status: 502, message: '无法连接工作站：fetch failed', workstationUrl: 'http://10.1.2.3:8481' });
  assert.equal(explained.kind, 'workstation-unreachable');
  assert.match(explained.title, /http:\/\/10\.1\.2\.3:8481/);
});

test('已加入别的工作站（409）与未知错误', () => {
  assert.equal(explainJoinFailure({ status: 409, message: '本机已加入工作站 http://a，请先退出后再加入其他工作站' }).kind, 'already-joined');
  const unknown = explainJoinFailure({ status: 500, message: '', hostPort: 7000 });
  assert.equal(unknown.kind, 'unknown');
  assert.match(unknown.hints.join('\n'), /原始错误/);
});

test('CLI 失败路径不用 process.exit（Windows 上会撞 libuv 断言 0xC0000409）', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const tail = source.slice(source.lastIndexOf('main().catch'));
  assert.ok(tail.includes('process.exitCode = 1'), 'main().catch 应按 exitCode 退出');
  assert.ok(!/process\.exit\(/.test(tail), 'main().catch 里不能硬退出');
});
