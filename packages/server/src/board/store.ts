// 看板持久化：~/.tandem/boards/<id>.json，每块一个文件，原子替换，权限 600。
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Board } from '@tandem/protocol';

/** 派生字段（按会话实时推导）不落盘。 */
const DERIVED = new Set(['activity', 'blocked']);

export class BoardStore {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, 'boards');
  }

  load(): Board[] {
    if (!existsSync(this.dir)) return [];
    const boards: Board[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8')) as Board;
        if (raw && typeof raw.id === 'string' && Array.isArray(raw.cards)) boards.push(raw);
      } catch (err) {
        console.warn(`[tandem] 看板文件损坏，已跳过 ${name}:`, err instanceof Error ? err.message : err);
      }
    }
    return boards;
  }

  save(board: Board): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${board.id}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(board, (key, value) => (DERIVED.has(key) ? undefined : value), 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tmp, file);
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows 上 chmod 可能无效
      }
    } catch (err) {
      console.warn('[tandem] 保存看板失败:', err instanceof Error ? err.message : err);
    }
  }

  remove(id: string): void {
    rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }
}
