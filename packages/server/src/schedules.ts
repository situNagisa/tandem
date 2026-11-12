// 定时任务：~/.tandem/schedules.json + Host 进程内调度器。
// cron 为标准 5 段（分 时 日 月 周）；为方便本机测试也接受 6 段（秒 分 时 日 月 周）。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  PermissionMode,
  ReasoningEffort,
  Schedule,
  ScheduleInput,
  ScheduleRunRecord,
} from '@tandem/protocol';
import type { Host } from './host.js';
import { errorMessage } from './util/text.js';

const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);
const EFFORTS = new Set<ReasoningEffort>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TICK_MS = 5_000;

interface CronSpec {
  seconds?: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
  hasSeconds: boolean;
}

function parseField(raw: string, min: number, max: number, label: string): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  const text = raw.trim();
  if (!text) throw new Error(`${label}不能为空`);
  for (const part of text.split(',')) {
    if (!part) throw new Error(`无效的 ${label}: ${raw}`);
    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0)) {
      throw new Error(`无效的 ${label} 步长: ${part}`);
    }
    const step = stepPart ? Number(stepPart) : 1;
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (!/^\d+$/.test(a ?? '') || !/^\d+$/.test(b ?? '')) {
        throw new Error(`无效的 ${label}: ${part}`);
      }
      lo = Number(a);
      hi = Number(b);
    } else {
      if (!/^\d+$/.test(rangePart)) throw new Error(`无效的 ${label}: ${part}`);
      lo = Number(rangePart);
      hi = stepPart ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`${label} 超出范围（${min}-${max}）: ${part}`);
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return { values, any: text === '*' };
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error('cron 需要 5 段（分 时 日 月 周），测试模式可 6 段（秒 分 时 日 月 周）');
  }
  const hasSeconds = fields.length === 6;
  const offset = hasSeconds ? 1 : 0;
  const seconds = hasSeconds ? parseField(fields[0]!, 0, 59, '秒') : undefined;
  const minutes = parseField(fields[offset]!, 0, 59, '分钟');
  const hours = parseField(fields[offset + 1]!, 0, 23, '小时');
  const dom = parseField(fields[offset + 2]!, 1, 31, '日期');
  const months = parseField(fields[offset + 3]!, 1, 12, '月份');
  const dowRaw = parseField(fields[offset + 4]!, 0, 7, '星期');
  const dow = new Set<number>();
  for (const day of dowRaw.values) dow.add(day === 7 ? 0 : day);
  return {
    ...(seconds ? { seconds: seconds.values } : {}),
    minutes: minutes.values,
    hours: hours.values,
    dom: dom.values,
    months: months.values,
    dow,
    domAny: dom.any,
    dowAny: dowRaw.any,
    hasSeconds,
  };
}

function matches(spec: CronSpec, date: Date): boolean {
  if (!spec.months.has(date.getMonth() + 1)) return false;
  if (!spec.hours.has(date.getHours())) return false;
  if (!spec.minutes.has(date.getMinutes())) return false;
  if (spec.seconds && !spec.seconds.has(date.getSeconds())) return false;
  const domMatch = spec.dom.has(date.getDate());
  const dowMatch = spec.dow.has(date.getDay());
  // 标准 cron：日与周都受限时取并集，否则取受限的那一个
  if (!spec.domAny && !spec.dowAny) {
    if (!domMatch && !dowMatch) return false;
  } else if (!spec.domAny && !domMatch) {
    return false;
  } else if (!spec.dowAny && !dowMatch) {
    return false;
  }
  return true;
}

/** 严格晚于 after 的下一个触发时间；找不到（如 2 月 31 日）返回 undefined。 */
export function nextCronTime(expr: string, after: number): number | undefined {
  const spec = parseCron(expr);
  const step = spec.hasSeconds ? 1000 : 60_000;
  let time = Math.floor(after / step) * step + step;
  const limit = after + 366 * 24 * 3600 * 1000;
  while (time <= limit) {
    const date = new Date(time);
    if (matches(spec, date)) return time;
    time += step;
  }
  return undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class ScheduleManager {
  readonly file: string;
  private schedules: Schedule[] = [];
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();

  constructor(
    private readonly home: string,
    private readonly host: Host,
    private readonly onChange: () => void,
  ) {
    this.file = path.join(home, 'schedules.json');
    this.load();
    // 启动补跑：Host 未运行期间错过的时间点，若开启 catchUp 则补跑一次
    const now = Date.now();
    for (const schedule of this.schedules) {
      if (!schedule.enabled) continue;
      const missed = schedule.nextRunAt !== undefined && schedule.nextRunAt <= now;
      try {
        schedule.nextRunAt = nextCronTime(schedule.cron, now);
        if (missed && schedule.catchUp) void this.run(schedule.id, true);
      } catch (err) {
        // 手工改坏 cron 不应阻止 Host 启动
        console.warn(`[tandem] 定时任务「${schedule.name}」cron 无效，已暂停:`, errorMessage(err));
        schedule.enabled = false;
        delete schedule.nextRunAt;
      }
    }
    this.save();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        this.schedules = raw.filter((item): item is Schedule => !!item && typeof item === 'object' && str((item as Schedule).id) !== '');
      }
    } catch {
      this.schedules = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(this.home, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.schedules, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[tandem] 保存定时任务失败:', errorMessage(err));
    }
    this.onChange();
  }

  list(): Schedule[] {
    return this.schedules.map((schedule) => ({ ...schedule }));
  }

  get(id: string): Schedule | undefined {
    const found = this.schedules.find((schedule) => sameId(schedule.id, id));
    return found ? { ...found } : undefined;
  }

  private normalize(input: ScheduleInput): Omit<Schedule, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt' | 'lastRun'> {
    const name = str(input.name);
    if (!name) throw new Error('名称不能为空');
    const cron = str(input.cron);
    parseCron(cron);
    const prompt = str(input.prompt);
    if (!prompt) throw new Error('提示词不能为空');
    const target = input.target ?? { kind: 'new' };
    if (target.kind !== 'new' && target.kind !== 'session' && target.kind !== 'wiki') throw new Error('目标类型无效');
    const cwd = str(input.cwd);
    if (!cwd) throw new Error('工作目录不能为空');
    const profileId = str(input.profileId);
    if (target.kind === 'new' && !profileId) throw new Error('新建会话必须选择账号');
    if (target.kind === 'session' && !str(target.sessionId)) throw new Error('请选择要追加的会话');
    const permissionMode = PERMISSION_MODES.has(input.permissionMode)
      ? input.permissionMode
      : 'acceptEdits';
    const effort = EFFORTS.has(input.effort as ReasoningEffort)
      ? (input.effort as ReasoningEffort)
      : undefined;
    return {
      name,
      cron,
      enabled: input.enabled !== false,
      target:
        target.kind === 'new'
          ? { kind: 'new' }
          : target.kind === 'wiki'
            ? { kind: 'wiki' }
            : { kind: 'session', sessionId: str(target.sessionId) },
      cwd,
      ...(profileId ? { profileId } : {}),
      ...(str(input.groupId) ? { groupId: str(input.groupId) } : {}),
      ...(str(input.model) ? { model: str(input.model) } : {}),
      ...(effort ? { effort } : {}),
      permissionMode,
      prompt,
      ...(input.catchUp ? { catchUp: true } : {}),
    };
  }

  upsert(input: ScheduleInput, id?: string): Schedule {
    const base = this.normalize(input);
    const now = Date.now();
    const existing = id ? this.schedules.find((item) => sameId(item.id, id)) : undefined;
    if (id && !existing) throw new Error('定时任务不存在');
    if (existing) {
      const updated: Schedule = {
        ...existing,
        ...base,
        nextRunAt: base.enabled ? nextCronTime(base.cron, now) : undefined,
      };
      if (!base.enabled) delete updated.nextRunAt;
      this.schedules = this.schedules.map((item) => (item.id === existing.id ? updated : item));
      this.save();
      return { ...updated };
    }
    const created: Schedule = {
      ...base,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      nextRunAt: base.enabled ? nextCronTime(base.cron, now) : undefined,
    };
    this.schedules = [...this.schedules, created];
    this.save();
    return { ...created };
  }

  remove(id: string): boolean {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter((item) => !sameId(item.id, id));
    if (this.schedules.length === before) return false;
    this.save();
    return true;
  }

  private tick(): void {
    const now = Date.now();
    for (const schedule of this.schedules) {
      if (!schedule.enabled) continue;
      if (schedule.nextRunAt !== undefined && schedule.nextRunAt > now) continue;
      void this.run(schedule.id, false);
    }
  }

  /** 运行一次；manual=true 时忽略启用开关（「立即运行」）。 */
  async run(id: string, manual: boolean): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const schedule = this.schedules.find((item) => sameId(item.id, id));
    if (!schedule) return { ok: false, error: '定时任务不存在' };
    if (!manual && !schedule.enabled) return { ok: false, error: '任务已禁用' };
    if (this.running.has(schedule.id)) return { ok: false, error: '上一次运行尚未启动完成' };
    this.running.add(schedule.id);

    // 先把下次时间推进，避免同一分钟重复触发
    schedule.nextRunAt = schedule.enabled ? nextCronTime(schedule.cron, Date.now()) : undefined;
    if (!schedule.enabled) delete schedule.nextRunAt;
    schedule.updatedAt = Date.now();
    this.save();

    let record: ScheduleRunRecord;
    try {
      const sessionId = await this.execute(schedule);
      record = { at: Date.now(), sessionId, ok: true };
    } catch (err) {
      record = { at: Date.now(), ok: false, error: errorMessage(err) };
    } finally {
      this.running.delete(schedule.id);
    }
    const latest = this.schedules.find((item) => sameId(item.id, id));
    if (latest) {
      latest.lastRun = record;
      latest.updatedAt = Date.now();
      this.save();
    }
    return { ok: record.ok, ...(record.sessionId ? { sessionId: record.sessionId } : {}), ...(record.error ? { error: record.error } : {}) };
  }

  private async execute(schedule: Schedule): Promise<string> {
    if (schedule.target.kind === 'wiki') {
      const job = this.host.wiki.start({
        project: schedule.cwd,
        mode: 'update',
        ...(schedule.profileId ? { profileId: schedule.profileId } : {}),
        ...(schedule.groupId ? { groupId: schedule.groupId } : {}),
        ...(schedule.model ? { model: schedule.model } : {}),
        ...(schedule.effort ? { effort: schedule.effort } : {}),
      });
      return job.sessionId ?? '';
    }
    if (schedule.target.kind === 'session') {
      const sessionId = str(schedule.target.sessionId);
      const rec = this.host.getSession(sessionId);
      if (!rec) throw new Error('目标会话不存在或已删除');
      void this.host.send(rec.id, [{ type: 'text', text: schedule.prompt }]);
      return rec.id;
    }
    if (!schedule.profileId) throw new Error('未配置账号');
    const rec = await this.host.createSession({
      cwd: schedule.cwd,
      profileId: schedule.profileId,
      ...(schedule.groupId ? { groupId: schedule.groupId } : {}),
      ...(schedule.model ? { model: schedule.model } : {}),
      permissionMode: schedule.permissionMode,
      ...(schedule.effort ? { effort: schedule.effort } : {}),
      title: schedule.name,
    });
    this.host.markScheduled(rec.id, { id: schedule.id, name: schedule.name });
    void this.host.send(rec.id, [{ type: 'text', text: schedule.prompt }]);
    return rec.id;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
