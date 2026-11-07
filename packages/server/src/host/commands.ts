// 斜杠命令、技能列表与会话内本地消息（提示/通知/快照）。
import { randomUUID } from 'node:crypto';
import type { Message, ModelRouteDecision, SkillInfo, SlashCommand } from '@tandem/protocol';
import { BUILTIN_NAMES, findCommandBody, listCommands as loadCommands } from '../agent/commands.js';
import type { ParsedCommand } from '../agent/commands.js';
import { bodyOfMemory } from '../memory.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { costSummary, labelOfSource } from './helpers.js';

export function listCommands(host: Host, cwd: string): SlashCommand[] {
  // 技能命令排在后面，重名时让内置/自定义命令优先
  const commands = loadCommands(cwd);
  const names = new Set(commands.map((cmd) => cmd.name));
  for (const skill of host.skills.commands(cwd)) {
    if (!names.has(skill.name)) {
      names.add(skill.name);
      commands.push(skill);
    }
  }
  return commands;
}

export function listSkills(host: Host, cwd: string): SkillInfo[] {
  return host.skills.list(cwd);
}

export function setSkillState(host: Host, disabled: string[], cwd: string): SkillInfo[] {
  return host.skills.setDisabled(disabled, cwd);
}

export async function handleCommand(host: Host, rec: SessionRecord, cmd: ParsedCommand): Promise<boolean> {
  switch (cmd.name) {
    case 'clear': {
      rec.messages = [];
      delete rec.plan;
      const clearedRt = host.runtimes.get(rec.id);
      if (clearedRt) clearedRt.sessionStartDone = false;
      host.store.markDirty(rec.id, true);
      host.setStatus(rec, 'idle');
      host.broadcastSummary(rec);
      host.broadcastSnapshot(rec);
      return true;
    }
    case 'compact': {
      await host.compactSession(rec);
      return true;
    }
    case 'model': {
      const profile = host.profileFor(rec.profileId, rec.groupId);
      const models = profile?.models ?? [];
      if (cmd.args) {
        rec.model = cmd.args.split(/\s+/)[0]!;
        host.store.markDirty(rec.id, true);
        host.broadcastSummary(rec);
        host.appendLocalAssistant(
          rec,
          `已切换模型为 ${rec.model}（下一轮生效）。${models.length ? `\n可选模型: ${models.join(', ')}` : ''}`,
        );
      } else {
        host.appendLocalAssistant(
          rec,
          [
            `当前模型: ${rec.model}`,
            models.length ? `可选模型: ${models.join(', ')}` : '该账号未列出模型',
            '切换方式: /model <模型名>，或在界面上选择（下一轮生效）。',
          ].join('\n'),
        );
      }
      return true;
    }
    case 'init': {
      host.titleFromCommand(rec, cmd);
      await host.sendToModel(rec, [
        { type: 'text', text: host.promptTemplates.get('init', rec.cwd) },
      ]);
      return true;
    }
    case 'schedule': {
      host.appendLocalAssistant(rec, '请在客户端「设置 → 定时任务」中新建或管理定时任务（输入 /schedule 可直接打开）。');
      return true;
    }
    case 'help': {
      const commands = host.listCommands(rec.cwd);
      const lines = commands.map((c) => `/${c.name} - ${c.description}（${labelOfSource(c.source)}）`);
      host.appendLocalAssistant(rec, `可用命令:\n${lines.join('\n')}`);
      return true;
    }
    case 'cost': {
      // 本地统计用量与花费，不调用模型
      host.appendLocalAssistant(rec, costSummary(rec));
      return true;
    }
    case 'memory': {
      const project = host.memory.read('project', rec.cwd);
      const global = host.memory.read('global');
      const projectBody = bodyOfMemory(project.text).trim();
      const globalBody = bodyOfMemory(global.text).trim();
      host.appendLocalAssistant(
        rec,
        [
          `## 项目记忆（${project.name} · ${project.entries} 条）`,
          projectBody || '（空）',
          '',
          `## 全局记忆（${global.entries} 条）`,
          globalBody || '（空）',
          '',
          '可在右侧「记忆」卡片或「设置 → 记忆」中编辑；输入 #记住 <内容> 可直接追加。',
        ].join('\n'),
      );
      return true;
    }
    default:
      break;
  }

  // 自定义命令：cwd/.claude/commands 或 ~/.claude/commands 下的 md
  const body = findCommandBody(cmd.name, rec.cwd);
  if (body !== undefined) {
    host.titleFromCommand(rec, cmd);
    const expanded = body.replace(/\$ARGUMENTS/g, cmd.args);
    await host.sendToModel(rec, [{ type: 'text', text: expanded }]);
    return true;
  }

  // Skill：/<skill-name> 显式加载技能正文
  const skillInfo = host.skills.list(rec.cwd).find((skill) => skill.name === cmd.name);
  if (skillInfo) {
    if (!skillInfo.enabled) {
      host.appendLocalAssistant(
        rec,
        `技能「${cmd.name}」已停用。可在「设置 → Skills」中重新启用，或直接用自然语言描述任务。`,
      );
      return true;
    }
    if (!skillInfo.userInvocable) {
      host.appendLocalAssistant(
        rec,
        `技能「${cmd.name}」不允许用户直接调用（user-invocable: false），模型会在需要时自行使用。`,
      );
      return true;
    }
    const skill = host.skills.resolve(cmd.name, rec.cwd);
    if (skill) {
      host.titleFromCommand(rec, cmd);
      let expanded = skill.body.replace(/\$ARGUMENTS/g, cmd.args);
      if (cmd.args && !skill.body.includes('$ARGUMENTS')) {
        expanded += `\n\n用户参数：${cmd.args}`;
      }
      await host.sendToModel(rec, [
        { type: 'text', text: `[使用技能 ${skill.info.name}]\n\n${expanded}` },
      ]);
      return true;
    }
  }

  host.appendLocalAssistant(
    rec,
    `未知命令 /${cmd.name}。输入 /help 查看可用命令。`,
  );
  return true;
}

export function titleFromCommand(host: Host, rec: SessionRecord, cmd: ParsedCommand): void {
  if (rec.title && rec.title !== '新会话') return;
  const title = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`.replace(/\s+/g, ' ').trim();
  rec.title = title.slice(0, 40);
}

export function appendNotice(host: Host, rec: SessionRecord, text: string, route?: ModelRouteDecision): void {
  const message: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: Date.now(),
    notice: true,
    ...(route ? { route } : {}),
  };
  rec.messages.push(message);
  host.hub.broadcastSession(rec.id, {
    type: 'message_start',
    sessionId: rec.id,
    message,
  });
  host.hub.broadcastSession(rec.id, {
    type: 'message_end',
    sessionId: rec.id,
    message,
  });
  host.store.markDirty(rec.id, true);
  host.broadcastSummary(rec);
}

export function appendLocalAssistant(host: Host, rec: SessionRecord, text: string): void {
  const message: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: Date.now(),
  };
  rec.messages.push(message);
  host.hub.broadcastSession(rec.id, {
    type: 'message_start',
    sessionId: rec.id,
    message,
  });
  host.hub.broadcastSession(rec.id, {
    type: 'message_end',
    sessionId: rec.id,
    message,
  });
  host.store.markDirty(rec.id, true);
  host.setStatus(rec, 'idle');
  host.broadcastSummary(rec);
}

export function broadcastSnapshot(host: Host, rec: SessionRecord): void {
  const rt = host.runtimes.get(rec.id);
  // 快照作为一条会话事件下发，客户端据此重置到当前 seq
  host.hub.broadcastSession(rec.id, {
    type: 'session_snapshot',
    session: host.toSession(rec),
    pendingPermissions: rt ? [...rt.pending.values()].map((p) => p.request) : [],
  });
}
