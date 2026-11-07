import type { EvalResult, EvalRun, EvalRunSummary, Message } from '@tandem/protocol'
import type { ToolResultBlock } from '../../lib/types'

export function collectToolResults(messages: Message[] | undefined): Record<string, ToolResultBlock> {
  const map: Record<string, ToolResultBlock> = {}
  for (const message of messages ?? []) {
    for (const block of message.content) {
      if (block.type === 'tool_result') map[block.toolUseId] = block
    }
  }
  return map
}

export function findResult(
  run: EvalRun | EvalRunSummary | undefined,
  caseName: string,
  configId: string,
): EvalResult | Omit<EvalResult, 'messages'> | undefined {
  return run?.results.find((item) => item.caseName === caseName && item.configId === configId)
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

export function formatCost(usd?: number): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—'
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

export function resultLabel(result: Pick<EvalResult, 'status' | 'passed'> | undefined): string {
  if (!result) return '—'
  if (result.status === 'queued') return '排队中'
  if (result.status === 'running') return '运行中'
  if (result.status === 'cancelled') return '已取消'
  if (result.status === 'failed') return '失败'
  return result.passed ? '通过' : '未通过'
}

export function cellPassed(result: Pick<EvalResult, 'status' | 'passed'> | undefined): boolean | undefined {
  if (!result) return undefined
  if (result.status === 'done' || result.status === 'failed') return result.passed
  return undefined
}

export function runCases(run: EvalRun | EvalRunSummary): Array<{ name: string; title: string }> {
  const seen = new Map<string, string>()
  for (const result of run.results) {
    if (!seen.has(result.caseName)) seen.set(result.caseName, result.caseTitle)
  }
  return [...seen.entries()].map(([name, title]) => ({ name, title }))
}

export function runToMarkdown(run: EvalRun): string {
  const lines: string[] = []
  lines.push(`# 评测对比：${run.suite}`)
  lines.push('')
  lines.push(`- 运行时间：${new Date(run.startedAt).toLocaleString()}`)
  lines.push(`- 状态：${run.status === 'done' ? '已完成' : run.status === 'cancelled' ? '已取消' : '运行中'}`)
  lines.push(`- 进度：${run.finished}/${run.total}`)
  if (run.reviewer) lines.push(`- 评审模型：${run.reviewer.model}`)
  lines.push('')
  lines.push('## 配置')
  lines.push('')
  for (const config of run.configs) {
    const effort = config.effort ? ` · 思考 ${config.effort}` : ''
    const delegation = config.delegation ? ` · 委派 ${config.delegation}` : ''
    const overrides = config.promptOverrides
      ? ` · 提示词覆盖 ${Object.keys(config.promptOverrides).length} 项`
      : ''
    lines.push(`- **${config.name}**：${config.model}${effort}${delegation}${overrides}`)
  }
  lines.push('')
  lines.push('## 对比表')
  lines.push('')
  lines.push(`| 用例 | ${run.configs.map((config) => config.name.replace(/\|/g, '\\|')).join(' | ')} |`)
  lines.push(`| --- | ${run.configs.map(() => '---').join(' | ')} |`)
  for (const testCase of runCases(run)) {
    const cells = run.configs.map((config) => {
      const result = findResult(run, testCase.name, config.id)
      if (!result) return '—'
      const verdict = resultLabel(result)
      const extra = [
        result.costUsd !== undefined ? formatCost(result.costUsd) : '',
        result.durationMs ? formatDuration(result.durationMs) : '',
      ]
        .filter(Boolean)
        .join(' / ')
      return `${verdict}${extra ? `（${extra}）` : ''}`
    })
    lines.push(`| ${testCase.title.replace(/\|/g, '\\|')} | ${cells.join(' | ')} |`)
  }
  lines.push('')
  lines.push('## 明细')
  for (const testCase of runCases(run)) {
    for (const config of run.configs) {
      const result = findResult(run, testCase.name, config.id)
      if (!result) continue
      lines.push('')
      lines.push(`### ${testCase.title} · ${config.name}`)
      lines.push('')
      lines.push(`- 结论：${resultLabel(result)}${result.passed ? '' : ''}`)
      lines.push(`- 轮数：${result.turns} · 工具调用：${result.toolCalls}`)
      lines.push(
        `- Token：输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens}` +
          (result.usage.cacheReadTokens ? ` / 缓存读 ${result.usage.cacheReadTokens}` : ''),
      )
      lines.push(`- 花费：${formatCost(result.costUsd)} · 耗时：${formatDuration(result.durationMs)}`)
      if (result.check) {
        lines.push(`- 检查命令：\`${result.check.command}\` 退出码 ${result.check.exitCode ?? 'null'}（${result.check.ok ? '通过' : '失败'}）`)
        if (result.check.output) {
          lines.push('')
          lines.push('```')
          lines.push(result.check.output.slice(-4000))
          lines.push('```')
        }
      }
      if (result.review) {
        lines.push(`- 评审（${result.review.model}）：${result.review.verdict === 'pass' ? '通过' : '不通过'} —— ${result.review.reason}`)
      }
      if (result.error) lines.push(`- 错误：${result.error}`)
      if (result.finalAnswer) {
        lines.push('')
        lines.push('**最终回答**')
        lines.push('')
        lines.push(result.finalAnswer.slice(0, 4000))
      }
    }
  }
  return `${lines.join('\n')}\n`
}

export function downloadText(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
