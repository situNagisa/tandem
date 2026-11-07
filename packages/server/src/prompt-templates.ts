// 提示词注册表落地：可编辑提示词存 ~/.tandem/prompts.json，项目可用 <cwd>/.tandem/prompts.json 覆盖（只读）。
// 未修改时一律跟随内置默认（Host 升级后自动生效）；只读提示词只在设置页展示。
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  PromptCategory,
  PromptSource,
  PromptTemplate,
  PromptTemplateKey,
} from '@tandem/protocol';
import { ensureDir, readJson, tandemHome } from './config.js';
import { EDITABLE_PROMPTS, READONLY_PROMPTS } from './prompts/registry.js';
import type { ResolvedPrompt } from './agent/prompt.js';

interface PromptFile {
  values?: Partial<Record<string, string>>;
}

const EDITABLE_KEYS = Object.keys(EDITABLE_PROMPTS) as PromptTemplateKey[];

function normalizeValues(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const raw = (input as PromptFile).values ?? (input as Record<string, unknown>);
  const values: Record<string, string> = {};
  for (const key of EDITABLE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) values[key] = value;
  }
  return values;
}

function projectFile(cwd: string): string {
  return path.join(cwd, '.tandem', 'prompts.json');
}

export class PromptTemplateStore {
  private file: string;
  private values: Partial<Record<PromptTemplateKey, string>> = {};

  constructor(home = tandemHome()) {
    this.file = path.join(home, 'prompts.json');
    const data = readJson<PromptFile>(this.file);
    this.values = normalizeValues(data?.values) as Partial<Record<PromptTemplateKey, string>>;
  }

  /** 项目级覆盖：只读，每次按需读取（项目文件通常很小）。 */
  private projectValues(cwd?: string): Record<string, string> {
    if (!cwd) return {};
    try {
      const file = projectFile(cwd);
      if (!existsSync(file)) return {};
      return normalizeValues(readJson<PromptFile>(file)?.values);
    } catch {
      return {};
    }
  }

  private resolve(key: PromptTemplateKey, cwd?: string): { text: string; source: PromptSource } {
    const project = this.projectValues(cwd);
    if (project[key]) return { text: project[key]!, source: 'project' };
    if (this.values[key]) return { text: this.values[key]!, source: 'user' };
    const def = EDITABLE_PROMPTS[key];
    return { text: def?.text ?? '', source: 'builtin' };
  }

  get(key: PromptTemplateKey, cwd?: string): string {
    return this.resolve(key, cwd).text;
  }

  sourceOf(key: PromptTemplateKey, cwd?: string): PromptSource {
    return this.resolve(key, cwd).source;
  }

  /** 当前 cwd 下所有可编辑提示词的有效文本与来源（项目覆盖 > 用户 > 内置）。 */
  resolved(cwd?: string): Record<string, ResolvedPrompt> {
    const out: Record<string, ResolvedPrompt> = {};
    for (const key of EDITABLE_KEYS) out[key] = this.resolve(key, cwd);
    return out;
  }

  /** 渲染模板变量：{{presets}} / {{cwd}} / {{delegation}} / {{name}} / {{log}} / {{text}}。 */
  render(key: PromptTemplateKey, vars: Record<string, string> = {}, cwd?: string): string {
    return this.get(key, cwd).replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      name in vars ? vars[name]! : match,
    );
  }

  /** 设置页清单：可编辑项 + 只读项；带项目覆盖信息。 */
  list(cwd?: string): PromptTemplate[] {
    const project = this.projectValues(cwd);
    const entries: PromptTemplate[] = [];
    for (const key of EDITABLE_KEYS) {
      const def = EDITABLE_PROMPTS[key]!;
      const resolved = this.resolve(key, cwd);
      entries.push({
        key,
        label: def.label,
        description: def.description,
        text: resolved.text,
        defaultText: def.text,
        modified: resolved.source !== 'builtin',
        category: def.category as PromptCategory,
        editable: true,
        variables: def.variables,
        source: resolved.source,
        ...(project[key] ? { projectText: project[key] } : {}),
      });
    }
    for (const def of READONLY_PROMPTS) {
      entries.push({
        key: def.key as PromptTemplateKey,
        label: def.label,
        description: def.description,
        text: def.text,
        defaultText: def.text,
        modified: false,
        category: def.category as PromptCategory,
        editable: false,
        readOnlyReason: def.reason,
        variables: def.variables,
        source: 'builtin',
      });
    }
    return entries;
  }

  save(input: unknown, cwd?: string): PromptTemplate[] {
    if (!input || typeof input !== 'object') throw new Error('values 必须是对象');
    const raw = input as Record<string, unknown>;
    for (const key of EDITABLE_KEYS) {
      if (!(key in raw)) continue;
      const value = raw[key];
      if (typeof value !== 'string') continue;
      if (!value.trim() || value === EDITABLE_PROMPTS[key]!.text) delete this.values[key];
      else this.values[key] = value;
    }
    ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ values: this.values }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmp, this.file);
    return this.list(cwd);
  }
}
