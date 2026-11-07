// 可配置提示词：子代理/委派相关段落存 ~/.tandem/prompts.json，未修改时跟随内置默认。
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PromptTemplate, PromptTemplateKey } from '@tandem/protocol';
import { ensureDir, readJson, tandemHome } from './config.js';

interface PromptFile {
  values?: Partial<Record<PromptTemplateKey, string>>;
}

export const PROMPT_DEFAULTS: Record<
  PromptTemplateKey,
  { label: string; description: string; text: string }
> = {
  taskDescription: {
    label: 'Task 工具说明',
    description: '展示给主会话模型的 Task 工具描述；{{presets}} 会替换为预设名称与描述。',
    text:
      'Launch a new agent to handle a complex, multi-step task autonomously. ' +
      'The subagent has access to its own tools and working directory, and runs its own full loop. ' +
      'Use it for independent research or parallelizable work. ' +
      'subagent_type: "Explore" or "Plan" for read-only work, "general-purpose" for tasks that may modify files, ' +
      'or one of the configured presets: {{presets}}. ' +
      'You can override the subagent model with the optional model parameter.',
  },
  delegationOrchestrate: {
    label: '委派策略：编排',
    description: '主会话只规划/汇总，读写与命令都交给子代理。',
    text:
      '# 委派策略：编排（orchestrate）\n' +
      '你只负责规划、拆分与汇总：所有读写文件、搜索、运行测试和命令都交给子代理执行。' +
      '每轮先用 Task 派发可独立并行的子任务，保持主会话上下文精简；' +
      '自己只读少量关键文件用于决策。收到子代理结果后汇总给用户，不要亲自实现。\n' +
      '子代理完成后直接输出结论，不要重复派发同一任务。',
  },
  delegationMore: {
    label: '委派策略：多派',
    description: '鼓励并行派发可独立的子任务。',
    text:
      '# 委派策略：多派（more）\n' +
      '尽量把可独立、可并行的子任务交给子代理（探索、测试、审查分别派发），主会话负责整合结论。' +
      '小改动或必须共享上下文的操作可以自己做。',
  },
  delegationLess: {
    label: '委派策略：少派',
    description: '默认行为：只有明显独立且多步的任务才派。',
    text:
      '# 委派策略：少派（less，默认）\n' +
      '只有明显独立且多步的任务才派子代理；大多数工作直接自己做，避免为小事付出额外上下文与延迟。',
  },
  delegationNone: {
    label: '委派策略：不派',
    description: '不提供 Task 工具时注入的说明。',
    text: '# 委派策略：不派（none）\n不要派发子代理，所有工作自己完成。',
  },
  subagentDefault: {
    label: '子代理默认附加提示',
    description: '追加到每个子代理系统提示的通用要求。',
    text:
      '你是由主会话派发的子代理。只完成交给你的子任务，不改动无关文件；' +
      '完成后用简洁中文给出结论、关键文件路径与验证结果。',
  },
};

const KEYS = Object.keys(PROMPT_DEFAULTS) as PromptTemplateKey[];

export class PromptTemplateStore {
  private file: string;
  private values: Partial<Record<PromptTemplateKey, string>> = {};

  constructor(home = tandemHome()) {
    this.file = path.join(home, 'prompts.json');
    const data = readJson<PromptFile>(this.file);
    for (const key of KEYS) {
      const value = data?.values?.[key];
      if (typeof value === 'string' && value.trim()) this.values[key] = value;
    }
  }

  get(key: PromptTemplateKey): string {
    return this.values[key] ?? PROMPT_DEFAULTS[key].text;
  }

  /** 渲染模板变量：{{presets}} / {{cwd}} / {{delegation}}。 */
  render(key: PromptTemplateKey, vars: Record<string, string> = {}): string {
    return this.get(key).replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      name in vars ? vars[name]! : match,
    );
  }

  list(): PromptTemplate[] {
    return KEYS.map((key) => {
      const def = PROMPT_DEFAULTS[key];
      const custom = this.values[key];
      return {
        key,
        label: def.label,
        description: def.description,
        text: custom ?? def.text,
        defaultText: def.text,
        modified: !!custom && custom !== def.text,
      };
    });
  }

  save(input: unknown): PromptTemplate[] {
    if (!input || typeof input !== 'object') throw new Error('values 必须是对象');
    const raw = input as Record<string, unknown>;
    for (const key of KEYS) {
      if (!(key in raw)) continue;
      const value = raw[key];
      if (typeof value !== 'string') continue;
      if (!value.trim() || value === PROMPT_DEFAULTS[key].text) delete this.values[key];
      else this.values[key] = value;
    }
    ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ values: this.values }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmp, this.file);
    return this.list();
  }
}
