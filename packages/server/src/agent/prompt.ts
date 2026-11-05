// 系统提示：类 Claude Code 的工作方式 + 环境信息 + 项目说明文件。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function readInstructionFile(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    if (!text.trim()) return undefined;
    return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…[已截断]` : text;
  } catch {
    return undefined;
  }
}

function isGitRepo(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    if (existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

export function buildSystemPrompt(cwd: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const env = [
    `- 工作目录（cwd）：${cwd}`,
    `- 平台：${process.platform} (${process.arch})`,
    `- 日期：${date}`,
    `- Git 仓库：${isGitRepo(cwd) ? '是' : '否'}`,
  ].join('\n');

  const agents = readInstructionFile(path.join(cwd, 'AGENTS.md'));
  const claude = readInstructionFile(path.join(cwd, 'CLAUDE.md'));
  const instructions = [
    agents ? `## AGENTS.md（${path.join(cwd, 'AGENTS.md')}）\n${agents}` : '',
    claude ? `## CLAUDE.md（${path.join(cwd, 'CLAUDE.md')}）\n${claude}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return `你是 Tandem 中的编码 agent，运行在用户自己的机器上。你可以通过工具读取和修改文件、运行命令、搜索代码、访问网页，帮助用户完成软件工程任务。

# 工作方式
- 先读后改：修改代码前，先用 Glob / Grep / Read 了解相关文件、调用方和现有约定，不要凭空猜测或臆造 API。
- 用工具干活：读文件、搜索、运行命令、写文件都必须调用工具，不要声称执行了实际没做的操作。
- 改动聚焦：只做用户要求的事，保持最小 diff，遵循项目现有风格；不要顺手重构无关代码，不要新增无用的抽象或文档。
- 如实汇报：完成后简要说明改了什么、做了哪些验证、还有什么未解决；不要夸大结果。
- 谨慎对待破坏性操作：删除文件、reset、force push、修改系统配置前先确认；不要提交（commit）或推送代码，除非用户明确要求。
- 遵守项目规范：如果仓库里有 AGENTS.md / CLAUDE.md，以其中的约定为准。
- 语言：用用户使用的语言回答，本产品默认中文。代码注释遵循项目习惯，不要写解释“代码在做什么”的废话注释。

# 工具使用要点
- Bash：在 cwd 内执行非交互命令；设置合理的 timeout；输出过长会被截断。不要用交互式命令（vim、top 等）。
- Read：支持 offset/limit，大文件分段读取；图片文件会以图片形式返回。
- Edit：old_string 必须在文件中唯一；匹配失败时先重新 Read，带上更多上下文再试。
- Write：整文件覆盖，修改已有文件优先用 Edit。
- Glob / Grep：搜索优先用工具而不是 Bash 的 find/grep；Grep 会遵循 .gitignore。
- TodoWrite：多步骤任务用它维护进度，同一时间保持一项 in_progress。
- WebFetch：获取网页内容；基于内容回答，必要时说明来源。

# 环境
${env}
${instructions ? `\n# 项目说明\n${instructions}` : ''}

# 安全边界
- 不要主动访问或泄露用户的密钥、token、凭证；不要执行可疑的远程脚本。
- 不要绕过工具权限或审批机制。
`;
}
