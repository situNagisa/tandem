// 子代理派发、分工与工具可见性。
import { randomUUID } from 'node:crypto';
import type {
  DelegationStrategy,
  Message,
  PermissionMode,
  PromptTemplateKey,
  ReasoningEffort,
  RoutePreference,
  RouteDomain,
  RouteRole,
} from '@tandem/protocol';
import { runTurn } from '../agent/loop.js';
import { TASK_DESCRIPTION_DEFAULT } from '../prompts/registry.js';
import { resolveDivisionAssignment, routingSettingsOf } from '../model-routing.js';
import { modelAliasOf } from '../subagent-presets.js';
import { TOOLS, TOOL_MAP } from '../tools/index.js';
import type { SessionRecord, ToolDefinition, ToolResult } from '../types.js';
import type { Host } from '../host.js';

export function subagentConfig(host: Host, parent: SessionRecord,
    presetName?: string,
    modelOverride?: string,
    role?: RouteRole,
    domain?: RouteDomain): { profileId: string; groupId?: string; model: string; autoRoute?: boolean; effort?: ReasoningEffort; permissionMode: PermissionMode; delegation: DelegationStrategy; toolWhitelist?: string[]; systemPromptExtra?: string; presetName?: string; routeRole?: RouteRole; } {
  // 分工路由：内置执行者/专长角色优先于子代理预设，直接解析到设置里的绑定模型。
  if (role) {
    const settings = routingSettingsOf(host);
    const meta = settings
      ? resolveDivisionAssignment(host, settings, role, domain, routeBiasFor(host, parent))
      : undefined;
    if (meta) {
      return {
        profileId: meta.candidate.profileId,
        ...(meta.candidate.groupId ? { groupId: meta.candidate.groupId } : {}),
        model: modelOverride?.trim() || meta.candidate.model,
        ...(parent.effort ? { effort: parent.effort } : {}),
        permissionMode: parent.permissionMode,
        delegation: 'less',
        routeRole: role,
      };
    }
  }
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
    input: {
      description: string;
      prompt: string;
      subagentType?: string;
      model?: string;
      role?: RouteRole;
      domain?: RouteDomain;
      /** 派发它的 Task 工具 tool_use id；会话图据此定位到具体轮次。 */
      toolUseId?: string;
    },
    signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return { content: '用户中断', isError: true };
  const depth = (parent.depth ?? 0) + 1;
  if (depth > 3) return { content: '已达到最大代理层级，不能再派发子代理', isError: true };
  const config = host.subagentConfig(parent, input.subagentType, input.model, input.role, input.domain);
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
    ...(config.routeRole ? { routeRole: config.routeRole } : {}),
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
    ...(input.toolUseId ? { parentToolUseId: input.toolUseId } : {}),
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
  const subMeta = { subagent: { id: sub.id, model: sub.model } };
  try {
    const result = await runTurn(host, sub, { allowTask: depth < 3 });
    // 分工路由：子代理花费计入父会话本轮成本，节省归因合并到父会话（用量页仍按子会话角色单独统计）。
    const parentRt = host.ensureRuntime(parent.id);
    parentRt.turnCostUsd = (parentRt.turnCostUsd ?? 0) + (sub.usage.costUsd ?? 0);
    if (sub.routeSavings) {
      const byRole = { ...(parent.routeSavings?.byRole ?? {}) };
      for (const [roleKey, value] of Object.entries(sub.routeSavings.byRole ?? {})) {
        const key = roleKey as RouteRole;
        const current = byRole[key] ?? { calls: 0, costUsd: 0, savedUsd: 0 };
        byRole[key] = {
          calls: current.calls + value.calls,
          costUsd: Math.round((current.costUsd + value.costUsd) * 1e8) / 1e8,
          savedUsd: Math.round((current.savedUsd + value.savedUsd) * 1e8) / 1e8,
        };
      }
      parent.routeSavings = {
        savedUsd: (parent.routeSavings?.savedUsd ?? 0) + sub.routeSavings.savedUsd,
        baselineModel: sub.routeSavings.baselineModel,
        calls: (parent.routeSavings?.calls ?? 0) + sub.routeSavings.calls,
        ...(Object.keys(byRole).length ? { byRole } : {}),
      };
    }
    if (result.lastText) return { content: result.lastText, ...subMeta };
    if (result.reason === 'error') {
      return { content: `子代理执行失败: ${result.error ?? '未知错误'}`, isError: true, ...subMeta };
    }
    if (result.reason === 'interrupted') return { content: '子代理已被中断', isError: true, ...subMeta };
    return { content: '（子代理没有返回文本）', ...subMeta };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function delegationFor(host: Host, rec: SessionRecord): DelegationStrategy {
  return (
    host.runtimes.get(rec.id)?.turnRoute?.delegation ??
    rec.delegation ??
    ((rec.depth ?? 0) === 0 ? host.settings().defaultDelegation ?? 'less' : 'less')
  );
}

export function routeBiasFor(host: Host, rec: SessionRecord): RoutePreference {
  return (
    host.runtimes.get(rec.id)?.turnRoute?.routeBias ??
    rec.routeBias ??
    routingSettingsOf(host)?.preference ??
    'balanced'
  );
}

export function presetSummary(host: Host, cwd: string): string {
  const presets = host.subagentPresets.list(cwd);
  if (presets.length === 0) return '（无自定义预设）';
  return presets
    .map((preset) => `${preset.name}${preset.description ? `（${preset.description}）` : ''}`)
    .join('；');
}

export function taskToolDescription(host: Host, cwd: string): string {
  const base = TASK_DESCRIPTION_DEFAULT.replace(/\{\{presets\}\}/g, host.presetSummary(cwd));
  return (
    base +
    '\n分工路由：role="executor" 把机械子任务交给配置的便宜执行模型；role="specialist" 可带 domain（ui/backend/test/docs/data/ops/general）交给领域专长模型。' +
    '子代理只收到你写的 prompt，务必自包含：目标、文件路径、步骤、验收命令与限制；不要把整段对话粘贴进去。'
  );
}

export function delegationKey(host: Host, rec: SessionRecord): PromptTemplateKey {
  const strategy = host.delegationFor(rec);
  return strategy === 'more' ? 'delegationMore' : strategy === 'none' ? 'delegationNone' : 'delegationLess';
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
  const base = TOOLS
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
  const mcp = host.mcp.toolDefinitions(rec.cwd).filter((tool) => allowed(tool.name));
  return [...base, ...mcp];
}

export function toolDefinition(host: Host, name: string, cwd: string): ToolDefinition | undefined {
  return (
    TOOL_MAP.get(name) ??
    host.mcp.toolDefinitions(cwd).find((tool) => tool.name === name) ??
    host.mcp.findTool(name)
  );
}
