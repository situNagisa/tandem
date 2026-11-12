// 子代理预设：Tandem 自定义（~/.tandem/subagent-presets.json）+ 只读兼容 Claude Code agents/*.md。
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  PermissionMode,
  ReasoningEffort,
  SubagentPreset,
  SubagentPresetInput,
} from '@tandem/protocol';
import { ensureDir, readJson, tandemHome } from './config.js';
import { normalizeDelegation } from './routing-settings.js';

const EFFORTS = new Set<ReasoningEffort>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const ALIASES = new Set(['sonnet', 'opus', 'haiku']);
const MAX_PROMPT = 20_000;

interface PresetFile {
  presets?: SubagentPresetInput[];
}

/** Claude Code 的 model 别名（sonnet/opus/haiku）；其它名称原样返回。 */
export function modelAliasOf(model: string | undefined): string | undefined {
  const value = model?.trim().toLowerCase();
  return value && ALIASES.has(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = [...new Set(value.map((item) => asString(item)).filter((item): item is string => !!item))];
  return list.length ? list : undefined;
}

function normalizeInput(value: unknown, fallbackId?: string): SubagentPresetInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const name = asString(raw.name);
  if (!name) return undefined;
  const effort = asString(raw.effort) as ReasoningEffort | undefined;
  const permissionMode = asString(raw.permissionMode) as PermissionMode | undefined;
  const delegation = normalizeDelegation(raw.delegation);
  return {
    ...(fallbackId || asString(raw.id) ? { id: fallbackId ?? asString(raw.id)! } : {}),
    name: name.slice(0, 60),
    ...(asString(raw.description) ? { description: asString(raw.description)!.slice(0, 500) } : {}),
    ...(asString(raw.profileId) ? { profileId: asString(raw.profileId)! } : {}),
    ...(asString(raw.groupId) ? { groupId: asString(raw.groupId)! } : {}),
    ...(asString(raw.model) ? { model: asString(raw.model)! } : {}),
    ...(effort && EFFORTS.has(effort) ? { effort } : {}),
    ...(permissionMode && MODES.has(permissionMode) ? { permissionMode } : {}),
    ...(delegation ? { delegation } : {}),
    ...(cleanList(raw.allowedTools) ? { allowedTools: cleanList(raw.allowedTools)! } : {}),
    ...(asString(raw.systemPrompt)
      ? { systemPrompt: asString(raw.systemPrompt)!.slice(0, MAX_PROMPT) }
      : {}),
  };
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

function parseTools(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  const list = stripped
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return list.length ? [...new Set(list)] : undefined;
}

function readAgentDir(dir: string, source: 'claude' | 'project'): SubagentPreset[] {
  if (!existsSync(dir)) return [];
  const out: SubagentPreset[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.md'));
  } catch {
    return out;
  }
  for (const file of files.sort()) {
    const full = path.join(dir, file);
    try {
      const text = readFileSync(full, 'utf8');
      const { fields, body } = parseFrontmatter(text);
      const name = asString(fields.name) ?? file.replace(/\.md$/i, '');
      const model = asString(fields.model);
      const alias = modelAliasOf(model);
      out.push({
        id: `${source}:${path.relative(dir, full).replace(/\\/g, '/')}`,
        name: name.slice(0, 60),
        description: (asString(fields.description) ?? '').slice(0, 500),
        ...(model ? { model } : {}),
        ...(alias ? { modelAlias: alias } : {}),
        ...(parseTools(fields.tools) ? { allowedTools: parseTools(fields.tools)! } : {}),
        systemPrompt: body.trim().slice(0, MAX_PROMPT),
        source,
        file: full,
      });
    } catch {
      // 单个文件读失败不影响其它预设
    }
  }
  return out;
}

export class SubagentPresetStore {
  private file: string;
  private custom: SubagentPresetInput[] = [];

  constructor(home = tandemHome()) {
    this.file = path.join(home, 'subagent-presets.json');
    const data = readJson<PresetFile>(this.file);
    this.custom = (data?.presets ?? [])
      .map((item) => normalizeInput(item, asString((item as { id?: unknown })?.id)))
      .filter((item): item is SubagentPresetInput => !!item);
  }

  private toPublic(input: SubagentPresetInput, index: number): SubagentPreset {
    return {
      id: input.id ?? `tandem-${index + 1}`,
      name: input.name,
      description: input.description ?? '',
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.delegation ? { delegation: input.delegation } : {}),
      ...(input.allowedTools?.length ? { allowedTools: [...input.allowedTools] } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      source: 'tandem',
    };
  }

  /** Tandem 自定义 + 只读文件预设；同名时自定义优先。 */
  list(cwd?: string): SubagentPreset[] {
    const custom = this.custom.map((item, i) => this.toPublic(item, i));
    const file: SubagentPreset[] = [];
    const userDir = path.join(os.homedir(), '.claude', 'agents');
    file.push(...readAgentDir(userDir, 'claude'));
    if (cwd) file.push(...readAgentDir(path.join(cwd, '.claude', 'agents'), 'project'));
    const seen = new Set(custom.map((item) => item.name.toLowerCase()));
    return [...custom, ...file.filter((item) => !seen.has(item.name.toLowerCase()))];
  }

  /** 按名称或 id 解析（大小写不敏感）；文件预设同名时项目优先。 */
  resolve(nameOrId: string, cwd?: string): SubagentPreset | undefined {
    const needle = nameOrId.trim().toLowerCase();
    if (!needle) return undefined;
    const list = this.list(cwd);
    return (
      list.find((item) => item.name.toLowerCase() === needle) ??
      list.find((item) => item.id.toLowerCase() === needle)
    );
  }

  /** 整体替换 Tandem 自定义预设，返回包含只读来源的完整列表。 */
  save(inputs: unknown, cwd?: string): SubagentPreset[] {
    if (!Array.isArray(inputs)) throw new Error('presets 必须是数组');
    const next: SubagentPresetInput[] = [];
    const names = new Set<string>();
    for (const raw of inputs) {
      const item = normalizeInput(raw);
      if (!item) continue;
      if (names.has(item.name.toLowerCase())) throw new Error(`预设名称重复: ${item.name}`);
      names.add(item.name.toLowerCase());
      next.push({ ...item, id: item.id ?? randomUUID() });
    }
    this.custom = next;
    ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ presets: next }, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    return this.list(cwd);
  }
}
