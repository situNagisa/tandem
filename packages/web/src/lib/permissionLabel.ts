import type { PermissionRequest } from '@tandem/protocol'

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 审批卡标题里的动作词与目标：Bash 是命令首行，文件工具是路径，其余用工具名。 */
export function permissionTarget(request: PermissionRequest): { verb: string; target: string } {
  const input = asRecord(request.input)
  const toolName = request.toolName
  if (toolName === 'Bash') {
    const command = str(input.command).split('\n')[0]?.trim() ?? ''
    return { verb: '允许运行', target: command || request.description || '这条命令' }
  }
  if (FILE_TOOLS.has(toolName)) {
    const filePath = str(input.file_path) || str(input.path) || str(input.pattern)
    return { verb: '允许访问', target: filePath || request.description || '这个路径' }
  }
  return { verb: '允许使用', target: request.description || toolName }
}

/** 一句话说明批准后会发生什么（参考 Claude Code 的说明行）。 */
export function permissionExplain(request: PermissionRequest): string {
  if (request.toolName === 'Bash') return '批准后本条命令会立即执行。'
  if (FILE_TOOLS.has(request.toolName)) return '批准后本次会话可以访问该路径。'
  return '批准后本次会话可以调用该工具。'
}
