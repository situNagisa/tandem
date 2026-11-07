// 子代理派发、委派策略与工具可见性。
import { randomUUID } from 'node:crypto';
import type {
  DelegationStrategy,
  Message,
  PermissionMode,
  PromptTemplateKey,
  ReasoningEffort,
} from '@tandem/protocol';
import { runTurn } from '../agent/loop.js';
import { TASK_DESCRIPTION_DEFAULT } from '../prompts/registry.js';
import { modelAliasOf } from '../subagent-presets.js';
import { TOOLS, TOOL_MAP } from '../tools/index.js';
import type { SessionRecord, ToolDefinition, ToolResult } from '../types.js';
import type { Host } from '../host.js';

export function subagentConfig(host: Host, parent: SessionRecord,
    presetName?: string,
    modelOverride?: string): { profileId: string; groupId?: string; model: string; autoRoute?: boolean; effort?: ReasoningEffort; permissionMode: PermissionMode; delegation: DelegationStrategy; toolWhitelist?: string[]; systemPromptExtra?: string; presetName?: string; } {
  const preset = presetName ? host.subagentPresets.resolve(presetName, parent.cwd) : undefined;
  let profileId = parent.profileId;
  let groupId = parent.groupId;
  if (preset?.profileId && host.profiles.get(preset.profileId)) {
    profileId = preset.profileId;
    groupId =
      preset.groupId && host.groupFor(profileId, preset.groupId) ? preset.groupId : undefined;
  } else if (preset?.groupId && host.groupFor(profileId, preset.groupId)) {
    groupId = preset.groupId;
  }

  let model = modelOverride?.trim() || preset?.model?.trim() || '';
  let autoRoute = model === 'auto';
  if (autoRoute) model = '';
  const alias = modelAliasOf(model);
  if (alias) {
    const found = host.findModelForAlias(alias, profileId, groupId);
    if (found) {
      profileId = found.profileId;
      groupId = found.groupId;
      model = found.model;
    } else {
      // 找不到对应模型时沿用主会话，不把 sonnet 之类的别名直接发给 provider
      profileId = parent.profileId;
      groupId = parent.groupId;
      model = parent.model;
    }
  }
  if (!model) model = host.profileFor(profileId, groupId)?.defaultModel || parent.model;

  return {
    profileId,
    ...(groupId ? { groupId } : {}),
    model,
    ...(autoRoute ? { autoRoute: true } : {}),
    ...((preset?.effort ?? parent.effort) ? { effort: preset?.effort ?? parent.effort } : {}),
    permissionMode: preset?.permissionMode ?? parent.permissionMode,
    delegation: preset?.delegation ?? 'less',
    ...(preset?.allowedTools?.length ? { toolWhitelist: [...preset.allowedTools] } : {}),
    ...(preset?.systemPrompt ? { systemPromptExtra: preset.systemPrompt } : {}),
    ...(preset ? { presetName: preset.name } : {}),
  };
}

export async function runSubagent(host: Host, parent: SessionRecord,
    input: { description: string; prompt: string; subagentType?: string; model?: string },
    signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return { content: '用户中断', isError: true };
  const depth = (parent.depth ?? 0) + 1;
  if (depth > 3) return { content: '已达到最大代理层级，不能再派发子代理', isError: true };
  const config = host.subagentConfig(parent, input.subagentType, input.model);
  const systemPromptExtra = [
    host.promptTemplates.render('subagentDefault', {}, parent.cwd),
    config.systemPromptExtra,
  ]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join('\n\n');
  const now = Date.now();
  const sub: SessionRecord = {
    id: randomUUID(),
    title: input.description.slice(0, 120) || '子代理',
    cwd: parent.cwd,
    profileId: config.profileId,
    ...(config.groupId ? { groupId: config.groupId } : {}),
    model: config.model,
    ...(config.autoRoute ? { autoRoute: true } : {}),
    permissionMode: config.permissionMode,
    ...(config.effort ? { effort: config.effort } : {}),
    delegation: config.delegation,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [],
    todos: [],
    allowedTools: [...parent.allowedTools],
    ...(config.toolWhitelist ? { toolWhitelist: config.toolWhitelist } : {}),
    ...(systemPromptExtra ? { systemPromptExtra } : {}),
    parentId: parent.id,
    depth,
  };
  host.store.add(sub);
  host.broadcastSummary(sub);

  const promptMessage: Message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: input.prompt }],
    createdAt: Date.now(),
  };
  sub.messages.push(promptMessage);
  const subRt = host.ensureRuntime(sub.id);
  subRt.checkpoint = host.checkpoints.create(sub.id, promptMessage.id);
  host.hub.broadcastSession(sub.id, {
    type: 'message_start',
    sessionId: sub.id,
    message: promptMessage,
  });
  host.hub.broadcastSession(sub.id, {
    type: 'message_end',
    sessionId: sub.id,
    message: promptMessage,
  });
  host.store.markDirty(sub.id, true);
  host.broadcastSummary(sub);

  // 主会话中断时级联中断子会话
  const onAbort = () => host.interrupt(sub.id);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) host.interrupt(sub.id);
  try {
    const result = await runTurn(host, sub, { allowTask: depth < 3 });
    if (result.lastText) return { content: result.lastText };
    if (result.reason === 'error') {
      return { content: `子代理执行失败: ${result.error ?? '未知错误'}`, isError: true };
    }
    if (result.reason === 'interrupted') return { content: '子代理已被中断', isError: true };
    return { content: '（子代理没有返回文本）' };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function delegationFor(host: Host, rec: SessionRecord): DelegationStrategy {
  return rec.delegation ?? ((rec.depth ?? 0) === 0 ? host.settings().defaultDelegation ?? 'less' : 'less');
}

export function orchestrateTools(host: Host, rec: SessionRecord): ToolDefinition[] {
  const allowed = new Set([
    'Task',
    'TodoWrite',
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'BashOutput',
    ...(rec.permissionMode === 'plan' ? ['ExitPlanMode'] : []),
    ...(rec.board ? ['ProposeCards'] : []),
  ]);
  return TOOLS.filter((tool) => allowed.has(tool.name));
}

export function presetSummary(host: Host, cwd: string): string {
  const presets = host.subagentPresets.list(cwd);
  if (presets.length === 0) return '（无自定义预设）';
  return presets
    .map((preset) => `${preset.name}${preset.description ? `（${preset.description}）` : ''}`)
    .join('；');
}

export function taskToolDescription(host: Host, cwd: string): string {
  return TASK_DESCRIPTION_DEFAULT.replace(/\{\{presets\}\}/g, host.presetSummary(cwd));
}

export function delegationKey(host: Host, rec: SessionRecord): PromptTemplateKey {
  const strategy = host.delegationFor(rec);
  return strategy === 'orchestrate'
    ? 'delegationOrchestrate'
    : strategy === 'more'
      ? 'delegationMore'
      : strategy === 'none'
        ? 'delegationNone'
        : 'delegationLess';
}

export function delegationPrompt(host: Host, rec: SessionRecord): string {
  const strategy = host.delegationFor(rec);
  return host.promptTemplates.render(
    host.delegationKey(rec),
    {
      presets: host.presetSummary(rec.cwd),
      cwd: rec.cwd,
      delegation: strategy,
    },
    rec.cwd,
  );
}

export function toolDefinitions(host: Host, rec: SessionRecord, allowTask = true): ToolDefinition[] {
  const strategy = host.delegationFor(rec);
  const canDelegate = allowTask && strategy !== 'none' && (rec.depth ?? 0) < 3;
  const hasSkills = host.skills
    .list(rec.cwd)
    .some((skill) => skill.enabled && skill.modelInvocable);
  const whitelist = rec.toolWhitelist?.length
    ? new Set(rec.toolWhitelist.map((name) => name.toLowerCase()))
    : null;
  const allowed = (name: string) => !whitelist || whitelist.has(name.toLowerCase());
  const orchestrating = strategy === 'orchestrate' && (rec.depth ?? 0) === 0;
  const source = orchestrating
    ? host.orchestrateTools(rec).filter((tool) => allowed(tool.name))
    : TOOLS;
  const base = source
    .filter(
      (tool) =>
        (canDelegate || tool.name !== 'Task') &&
        // 没有可用技能时不暴露 Skill，避免模型空调用
        (tool.name !== 'Skill' || hasSkills) &&
        // 仅计划模式暴露 ExitPlanMode，其它模式下不打扰模型
        (tool.name !== 'ExitPlanMode' || rec.permissionMode === 'plan') &&
        // 浏览器工具默认关闭，启用后才对模型可见
        (!tool.name.startsWith('browser_') || host.browser.settings.enabled) &&
        // 只有看板卡片会话能提议新卡
        (tool.name !== 'ProposeCards' || !!rec.board) &&
        allowed(tool.name),
    )
    .map((tool) =>
      tool.name === 'Task'
        ? { ...tool, description: host.taskToolDescription(rec.cwd) }
        : tool,
    );
  // 编排模式主会话不接 MCP，避免绕过委派直接产生副作用
  const mcp = orchestrating
    ? []
    : host.mcp.toolDefinitions(rec.cwd).filter((tool) => allowed(tool.name));
  return [...base, ...mcp];
}

export function toolDefinition(host: Host, name: string, cwd: string): ToolDefinition | undefined {
  return (
    TOOL_MAP.get(name) ??
    host.mcp.toolDefinitions(cwd).find((tool) => tool.name === name) ??
    host.mcp.findTool(name)
  );
}
