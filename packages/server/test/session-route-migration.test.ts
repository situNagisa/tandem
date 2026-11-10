// 旧会话 routeMode=division 在读取时迁移为 routePreference='auto'，写回一次且幂等。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/store.js';

function legacySession(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: id,
    cwd: '/tmp',
    profileId: 'p1',
    model: 'm1',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [],
    todos: [],
    allowedTools: [],
    ...extra,
  };
}

function writeSessions(home: string, records: Record<string, unknown>[]): void {
  const dir = path.join(home, 'sessions');
  mkdirSync(dir, { recursive: true });
  for (const record of records) {
    writeFileSync(path.join(dir, `${record.id as string}.json`), JSON.stringify(record));
  }
}

function readSession(home: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, 'sessions', `${id}.json`), 'utf8')) as Record<string, unknown>;
}

test('旧 routeMode=division 迁移为 routePreference=auto 并写回', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-route-migrate-'));
  try {
    writeSessions(home, [legacySession('s1', { autoRoute: true, routeMode: 'division' })]);
    const store = new SessionStore(home);
    const rec = store.get('s1');
    assert.equal(rec?.routePreference, 'auto');
    assert.equal('routeMode' in (rec ?? {}), false);
    store.flush();

    const saved = readSession(home, 's1');
    assert.equal(saved.routePreference, 'auto');
    assert.equal('routeMode' in saved, false);

    // 再次读取不再触发迁移，文件保持不变。
    const before = readFileSync(path.join(home, 'sessions', 's1.json'), 'utf8');
    const again = new SessionStore(home);
    again.flush();
    assert.equal(readFileSync(path.join(home, 'sessions', 's1.json'), 'utf8'), before);
    assert.equal(again.get('s1')?.routePreference, 'auto');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('旧 routeMode=auto 直接丢弃，固定偏好优先', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-route-migrate-'));
  try {
    writeSessions(home, [
      legacySession('plain', { autoRoute: true, routeMode: 'auto' }),
      legacySession('fixed', { autoRoute: true, routeMode: 'division', routePreference: 'cheap' }),
    ]);
    const store = new SessionStore(home);
    assert.equal(store.get('plain')?.routePreference, undefined);
    assert.equal('routeMode' in (store.get('plain') ?? {}), false);
    assert.equal(store.get('fixed')?.routePreference, 'cheap');
    assert.equal('routeMode' in (store.get('fixed') ?? {}), false);
    store.flush();
    assert.equal('routeMode' in readSession(home, 'plain'), false);
    assert.equal(readSession(home, 'fixed').routePreference, 'cheap');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
