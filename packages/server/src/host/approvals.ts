// 审批策略学习：设置页统计/建议、一键采纳、自然语言规则草稿（需用户确认）。
import type {
  PermissionInsights,
  PermissionRule,
  PermissionRuleDraft,
  PermissionSuggestion,
} from '@tandem/protocol';
import { completeText } from '../providers/index.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { patternDanger } from '../approval.js';

const DRAFT_SYSTEM = [
  '你是 Tandem 的权限规则生成器。把用户的一句话转换成一条结构化规则，只输出 JSON 对象，不要解释、不要代码块。',
  'JSON 形状：{"tool":"Bash","pattern":"git *","action":"allow","scope":"project","explanation":"一句话说明"}',
  'tool 取值：Bash / Read / Write / Edit / Glob / Grep / WebFetch / browser_navigate，或用 * 表示全部工具。',
  'pattern：Bash 是命令前缀通配（* 表示任意后缀，如 "npm test*"）；文件工具是相对项目根目录的 glob；browser_* 是域名模式；留空表示该工具全部调用。',
  'action：allow（自动允许）/ ask（总是询问）/ deny（直接拒绝）。scope：project（仅当前项目）或 global（所有项目）。',
  '危险操作（rm、git push、curl | sh、sudo、chmod、scp/ssh、修改 .env 或 ~/.ssh 等）不能生成 allow 规则，应改为 ask 并在 explanation 说明。',
].join('\n');

export function permissionInsights(host: Host): PermissionInsights {
  return {
    stats: host.approvalHistory.stats(7),
    suggestions: host.approvalHistory.suggestions(host.permissionRules),
  };
}

export function adoptSuggestion(host: Host, id: string): PermissionRule[] {
  const suggestion = host.approvalHistory
    .suggestions(host.permissionRules)
    .find((item) => item.id === id);
  if (!suggestion) throw new Error('建议不存在或已失效');
  return host.permissionRules.add(ruleOfSuggestion(suggestion));
}

export function ignoreSuggestion(host: Host, id: string): void {
  host.approvalHistory.ignore(id);
}

function ruleOfSuggestion(suggestion: PermissionSuggestion): PermissionRule {
  return {
    tool: suggestion.tool,
    pattern: suggestion.pattern,
    action: suggestion.action,
    project: suggestion.project,
  };
}

/** 保存用户确认后的单条规则；allow 规则再过一遍危险模式表。 */
export function addRule(host: Host, input: unknown): PermissionRule[] {
  const rule = normalizeDraft(input);
  if (rule.action === 'allow') {
    const danger = patternDanger(rule.tool, rule.pattern ?? '');
    if (danger) throw new Error(`该规则会放行危险操作（${danger}），不能自动允许`);
  }
  return host.permissionRules.add(rule);
}

export async function draftRule(
  host: Host,
  rec: SessionRecord,
  text: string,
): Promise<PermissionRuleDraft> {
  const sentence = text.trim();
  if (!sentence) throw new Error('请输入一句话描述，例如：这个项目里所有只读的 git 命令都不用问我');
  if (sentence.length > 2000) throw new Error('描述太长，请控制在 2000 字以内');

  const key = host.keyCandidates(rec.profileId, rec.groupId).candidates[0];
  const profile = key?.profile ?? host.profileFor(rec.profileId, rec.groupId);
  const model = rec.model || profile?.defaultModel || '';
  if (!profile?.apiKey || !model) throw new Error('当前会话没有可用的模型账号，无法生成规则');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let raw = '';
  try {
    raw = await completeText({
      profile,
      model,
      system: DRAFT_SYSTEM,
      prompt: `当前项目路径：${rec.cwd}\n用户的话：${sentence}\n只输出一个 JSON 对象。`,
      maxTokens: 400,
      signal: controller.signal,
    });
    host.markKeySuccess(rec.profileId, rec.groupId, key?.keyId);
  } catch (err) {
    host.markKeyFailure(rec.profileId, rec.groupId, key?.keyId, err);
    throw new Error(`生成规则失败：${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('模型没有返回 JSON 规则，请换个说法再试');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    throw new Error('模型返回的 JSON 无法解析，请换个说法再试');
  }
  const rule = normalizeDraft(parsed, rec.cwd);
  const explanation =
    typeof parsed.explanation === 'string' && parsed.explanation.trim()
      ? parsed.explanation.trim()
      : `已生成：${rule.tool} ${rule.pattern ?? '（全部调用）'} → ${
          rule.action === 'allow' ? '允许' : rule.action === 'ask' ? '询问' : '拒绝'
        }`;
  if (rule.action === 'allow') {
    const danger = patternDanger(rule.tool, rule.pattern ?? '');
    if (danger) {
      throw new Error(`命中危险模式（${danger}），不能生成自动允许规则；请改为「询问」，或手动添加`);
    }
  }
  return { rule, explanation };
}

function normalizeDraft(input: unknown, defaultProject?: string): PermissionRule {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const tool = typeof value.tool === 'string' ? value.tool.trim() : '';
  const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : '';
  const action = value.action === 'allow' || value.action === 'ask' || value.action === 'deny'
    ? value.action
    : '';
  if (!tool) throw new Error('规则缺少 tool');
  if (!action) throw new Error('规则的 action 必须是 allow / ask / deny');
  const scope = value.scope === 'global' ? 'global' : 'project';
  const explicitProject = typeof value.project === 'string' ? value.project.trim() : '';
  const project = scope === 'project' ? explicitProject || defaultProject || '' : '';
  if (scope === 'project' && !project) throw new Error('规则草稿缺少作用项目，请从会话中生成');
  return {
    tool,
    ...(pattern ? { pattern } : {}),
    action,
    ...(project ? { project } : {}),
  };
}
