// 旧会话路由字段迁移：routeMode / routePreference 拆成分工 delegation 与取向 routeBias；只在首次读取时写回一次。
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

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-route-migrate-'));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('旧 routeMode=division（按规则规划）不再对应任何固定取值：去掉旧字段并写回一次', () => {
  withHome((home) => {
    writeSessions(home, [legacySession('s1', { autoRoute: true, routeMode: 'division' })]);
    const store = new SessionStore(home);
    const rec = store.get('s1');
    assert.equal('routeMode' in (rec ?? {}), false);
    assert.equal('routePreference' in (rec ?? {}), false);
    assert.equal(rec?.delegation, undefined);
    assert.equal(rec?.routeBias, undefined);
    store.flush();

    const saved = readSession(home, 's1');
    assert.equal('routeMode' in saved, false);
    assert.equal('routePreference' in saved, false);

    // 再次读取不再触发迁移，文件保持不变。
    const before = readFileSync(path.join(home, 'sessions', 's1.json'), 'utf8');
    const again = new SessionStore(home);
    again.flush();
    assert.equal(readFileSync(path.join(home, 'sessions', 's1.json'), 'utf8'), before);
  });
});

test('旧 routePreference=direct 迁移为分工关闭', () => {
  withHome((home) => {
    writeSessions(home, [legacySession('s1', { routePreference: 'direct', delegation: 'less' })]);
    const store = new SessionStore(home);
    assert.equal(store.get('s1')?.delegation, 'none');
    assert.equal('routePreference' in (store.get('s1') ?? {}), false);
    store.flush();
    assert.equal(readSession(home, 's1').delegation, 'none');
  });
});

test('旧 routePreference=division 迁移为分工积极', () => {
  withHome((home) => {
    writeSessions(home, [legacySession('s1', { routePreference: 'division', delegation: 'less' })]);
    const store = new SessionStore(home);
    assert.equal(store.get('s1')?.delegation, 'more');
    assert.equal(store.get('s1')?.routeBias, undefined);
  });
});

test('旧 routePreference=cheap 迁移为取向省钱，分工关闭时改为适度', () => {
  withHome((home) => {
    writeSessions(home, [
      legacySession('none', { routePreference: 'cheap', delegation: 'none' }),
      legacySession('more', { routePreference: 'cheap', delegation: 'more' }),
      legacySession('unset', { routePreference: 'cheap' }),
    ]);
    const store = new SessionStore(home);
    assert.equal(store.get('none')?.routeBias, 'cost');
    assert.equal(store.get('none')?.delegation, 'less');
    assert.equal(store.get('more')?.routeBias, 'cost');
    assert.equal(store.get('more')?.delegation, 'more');
    assert.equal(store.get('unset')?.delegation, 'less');
    store.flush();
    assert.equal(readSession(home, 'none').routeBias, 'cost');
  });
});

test('旧 routePreference=auto 与已移除的 orchestrate 分工：auto 丢弃，orchestrate 并入积极', () => {
  withHome((home) => {
    writeSessions(home, [
      legacySession('auto', { routePreference: 'auto', delegation: 'less' }),
      legacySession('orch', { delegation: 'orchestrate' }),
    ]);
    const store = new SessionStore(home);
    assert.equal(store.get('auto')?.delegation, 'less');
    assert.equal('routePreference' in (store.get('auto') ?? {}), false);
    assert.equal(store.get('orch')?.delegation, 'more');
    store.flush();
    assert.equal(readSession(home, 'orch').delegation, 'more');
  });
});

test('新字段 routeBias 与分工原样保留', () => {
  withHome((home) => {
    writeSessions(home, [legacySession('s1', { delegation: 'none', routeBias: 'quality' })]);
    const store = new SessionStore(home);
    assert.equal(store.get('s1')?.delegation, 'none');
    assert.equal(store.get('s1')?.routeBias, 'quality');
    store.flush();
    assert.equal(readFileSync(path.join(home, 'sessions', 's1.json'), 'utf8').includes('routePreference'), false);
  });
});
