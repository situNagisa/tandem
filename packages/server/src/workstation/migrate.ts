// 旧「按主机」模型账号一次性搬迁：主机首次以账号身份连接时，把本机 profiles（含 Key）
// 上传到工作站账号，然后直接删除主机本地 profiles.json。单人测试阶段，不做备份、标记或冲突合并；
// 同名同协议以工作站已有为准，丢弃主机的。
import os from 'node:os';
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { ProfileStore } from '../config.js';
import type { Host } from '../host.js';

export interface MigrationResult {
  imported: number;
  discarded: number;
}

/**
 * 把本机 profiles.json 搬到工作站账号并删除本机文件。文件不存在时返回 null。
 * 搬迁失败时不删除本机文件，下次连接重试。
 */
export async function migrateHostProfiles(host: Host): Promise<MigrationResult | null> {
  if (!host.mirrorProfiles) return null;
  const accountId = host.accounts.ownerAccountId();
  const client = host.workstationProfiles();
  const file = path.join(host.home, 'profiles.json');
  if (!accountId || !client || !existsSync(file)) return null;
  const legacy = new ProfileStore(host.home);
  const profiles = legacy.list();
  if (!profiles.length) {
    rmSync(file, { force: true });
    return null;
  }
  const result = await client.importProfiles(accountId, profiles, os.hostname());
  rmSync(file, { force: true });
  await host.syncWorkstationProfiles(accountId, true).catch(() => undefined);
  console.log(
    `[tandem] 已把本机模型账号搬到工作站账号（导入 ${result.imported}，同名丢弃 ${profiles.length - result.imported}）；本机 profiles 已删除`,
  );
  return { imported: result.imported, discarded: profiles.length - result.imported };
}
