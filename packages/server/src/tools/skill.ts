// Skill：加载某个已启用技能的 SKILL.md 正文（与 Claude Code 的 Skill 工具一致）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const definition: ToolDefinition = {
  name: 'Skill',
  readOnly: true,
  requiresApproval: false,
  description:
    "Load a skill's full instructions (SKILL.md) by name. Use it when the task matches a skill " +
    'listed in the system prompt. Returns the skill body and its directory, so bundled files can ' +
    'be read with Read or executed with Bash.',
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Skill name exactly as listed (without leading slash).' },
    },
    required: ['skill'],
    additionalProperties: false,
  },
};

const SOURCE_LABEL = {
  project: '项目',
  user: '用户',
  tandem: 'Tandem',
  plugin: '插件',
} as const;

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name = typeof input.skill === 'string' ? input.skill.trim().replace(/^\//, '') : '';
  if (!name) return { content: '缺少 skill 参数（技能名称）', isError: true };
  const skill = ctx.getSkill?.(name);
  if (!skill) {
    return {
      content: `找不到已启用的技能「${name}」。技能名称区分大小写；输入 /help 或在设置 → Skills 中查看可用技能。`,
      isError: true,
    };
  }
  const { info, body } = skill;
  const head = [
    `已加载技能 ${info.name}（来源：${SOURCE_LABEL[info.source]}）。`,
    `技能目录：${info.dir}`,
    '该技能自带的脚本、模板或参考资料都在上述目录，可继续用 Read / Glob / Bash 访问。',
    '',
    '--- SKILL.md ---',
  ].join('\n');
  return { content: `${head}\n${body || '（SKILL.md 正文为空）'}` };
}
