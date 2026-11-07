import { useEffect, useMemo, useState } from 'react'
import { FlaskConical, Loader2, TriangleAlert } from 'lucide-react'
import type { ContentBlock, Message, SessionSummary } from '@tandem/protocol'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useEvalStore } from '../../store/useEvalStore'
import { useUiStore } from '../../store/useUiStore'
import type { HostConfig } from '../../lib/types'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Controls'
import { Modal } from '../ui/Modal'

const EMPTY_SUITES: string[] = []

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function singleLine(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/** 从会话某条用户消息截取为评测用例。 */
export function SaveEvalCaseDialog({
  open,
  onClose,
  host,
  session,
}: {
  open: boolean
  onClose: () => void
  host: HostConfig | null
  session: SessionSummary | null
}) {
  const saveCase = useEvalStore((state) => state.saveCase)
  const suites = useEvalStore((state) => (host ? state.byHost[host.id]?.suites ?? EMPTY_SUITES : EMPTY_SUITES))
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messageId, setMessageId] = useState<string | undefined>()
  const [suite, setSuite] = useState('default')
  const [name, setName] = useState('')
  const [passCriteria, setPassCriteria] = useState('')
  const [checkCommand, setCheckCommand] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useUiStore((state) => state.toast)
  const openSettings = useUiStore((state) => state.openSettings)

  useEffect(() => {
    if (!open || !host || !session) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setMessageId(undefined)
    setName('')
    setPassCriteria('')
    setCheckCommand('')
    setSuite(suites[0] ?? 'default')
    api
      .session(host, session.id)
      .then((detail) => {
        if (cancelled) return
        const userMessages = detail.messages.filter((message) => message.role === 'user' && textOf(message))
        setMessages(userMessages)
        setMessageId(userMessages[0]?.id)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '读取会话失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host?.id, session?.id])

  const selected = useMemo(
    () => messages.find((message) => message.id === messageId) ?? messages[0],
    [messages, messageId],
  )
  const prompt = selected ? textOf(selected) : ''

  const submit = async () => {
    if (!host || !session || !selected || saving) return
    setSaving(true)
    setError(null)
    try {
      const created = await saveCase(host, {
        sessionId: session.id,
        messageId: selected.id,
        suite: suite.trim() || 'default',
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(passCriteria.trim() ? { passCriteria: passCriteria.trim() } : {}),
        ...(checkCommand.trim() ? { checkCommand: checkCommand.trim() } : {}),
      })
      toast(`已保存评测用例 ${created.suite}/${created.name}`, 'success', {
        actionLabel: '去评测',
        onClick: () => openSettings('evals'),
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存评测用例失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="存为评测用例"
      title={
        <span className="flex items-center gap-2">
          <FlaskConical size={14} className="text-muted" />
          存为评测用例
        </span>
      }
      className="h-[min(86dvh,820px)] w-[min(94vw,760px)] max-w-none"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      footer={
        <>
          <Button size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            size="lg"
            variant="primary"
            onClick={() => void submit()}
            disabled={!host || !session || !selected || saving}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            保存用例
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
            <Loader2 size={14} className="animate-spin" /> 读取会话消息…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12.5px] leading-5 text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : (
          <>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-text-secondary">
                从哪条用户消息开始截取
              </div>
              <div className="max-h-[190px] space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                {messages.length === 0 ? (
                  <p className="px-2 py-3 text-[12px] text-muted">这个会话没有可用的用户消息。</p>
                ) : (
                  messages.map((message, index) => (
                    <button
                      key={message.id}
                      type="button"
                      onClick={() => setMessageId(message.id)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-5 transition-colors',
                        message.id === selected?.id
                          ? 'bg-[var(--t-bg-active)] text-text'
                          : 'text-text-soft hover:bg-[var(--t-bg-hover)]',
                      )}
                    >
                      <span className="mt-0.5 w-5 shrink-0 tabular-nums text-muted">{index + 1}</span>
                      <span className="min-w-0 flex-1 line-clamp-2">{singleLine(textOf(message))}</span>
                    </button>
                  ))
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted">
                只截取这条消息的文本作为评测初始输入；后续轮次不会带入。
              </p>
            </div>
            {prompt && (
              <div className="rounded-lg border border-border bg-bg/40 px-2.5 py-2">
                <div className="mb-1 text-[11px] text-muted">初始输入预览</div>
                <p className="max-h-[90px] overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-text-soft">
                  {prompt}
                </p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-text-secondary">
                用例集
                <Input
                  value={suite}
                  onChange={(event) => setSuite(event.target.value)}
                  placeholder="default"
                  size="sm"
                  aria-label="用例集"
                />
                {suites.length > 0 && (
                  <span className="flex flex-wrap gap-1 pt-0.5">
                    {suites.slice(0, 6).map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => setSuite(item)}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                          item === suite
                            ? 'bg-[var(--t-bg-active)] text-text'
                            : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text',
                        )}
                      >
                        {item}
                      </button>
                    ))}
                  </span>
                )}
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-text-secondary">
                用例名称（可选）
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="默认根据消息自动生成"
                  size="sm"
                  aria-label="用例名称"
                />
              </label>
            </div>
            <div className="rounded-lg border border-border bg-bg/40 px-2.5 py-2 text-[11.5px] leading-5 text-muted">
              git 仓库：记录当前 commit，运行时在独立临时 worktree 中检出，未提交改动不会包含；
              非 git 目录：保存时复制目录快照（不含 .git / 符号链接，上限 50MB）。
            </div>
            <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
              通过标准（可选，供评审模型判断）
              <Textarea
                value={passCriteria}
                onChange={(event) => setPassCriteria(event.target.value)}
                placeholder="例如：修复了空指针，并补充了对应单元测试；测试全部通过。"
                className="min-h-[70px]"
                size="sm"
                aria-label="通过标准"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
              自动检查命令（可选，退出码 0 即通过）
              <Input
                value={checkCommand}
                onChange={(event) => setCheckCommand(event.target.value)}
                placeholder="例如：npm test"
                size="sm"
                aria-label="自动检查命令"
              />
            </label>
          </>
        )}
      </div>
    </Modal>
  )
}
