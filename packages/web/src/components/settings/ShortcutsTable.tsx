import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  COMMANDS,
  getCommandShortcut,
  resetCommandShortcuts,
  setCommandShortcut,
  shortcutConflict,
} from '../../lib/commands'
import { formatShortcut, shortcutFromEvent } from '../../lib/shortcut'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'

/**
 * 外观页的快捷键表：直接由命令注册表生成，修改结果保存在本机 localStorage。
 * 命令面板与全局快捷键读取同一份配置。
 */
export function ShortcutsTable() {
  const [version, setVersion] = useState(0)
  const [recording, setRecording] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        setWarning(null)
        return
      }
      const spec = shortcutFromEvent(e)
      if (!spec) {
        setWarning('请使用 Ctrl / ⌘ / Alt 加字母或数字，系统保留的组合不可用')
        return
      }
      const conflict = shortcutConflict(spec, recording)
      if (conflict) {
        setWarning(`与「${conflict.title}」冲突，换一个组合`)
        return
      }
      setCommandShortcut(recording, spec)
      setRecording(null)
      setWarning(null)
      setVersion((v) => v + 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  // version 只用于触发重新读取 localStorage。
  void version

  return (
    <div data-setting-id="appearance.shortcuts">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-medium">键盘快捷键</div>
        <span className="text-[12px] text-muted">点击「修改」后按下新组合</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={12} />}
          onClick={() => {
            resetCommandShortcuts()
            setRecording(null)
            setWarning(null)
            setVersion((v) => v + 1)
          }}
        >
          全部恢复默认
        </Button>
      </div>
      <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
        {COMMANDS.map((command) => {
          const shortcut = getCommandShortcut(command.id)
          const isRecording = recording === command.id
          return (
            <div
              key={command.id}
              data-command-shortcut={command.id}
              className="flex min-h-8 min-w-0 items-center gap-2 text-[13px]"
            >
              <dt title={command.title} className="min-w-0 flex-1 truncate text-text-soft">{command.title}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                <kbd
                  className={cn(
                    'whitespace-nowrap rounded-[4px] border px-1.5 py-0.5 font-mono text-[12px] leading-none',
                    isRecording
                      ? 'border-accent bg-[var(--t-bg-active)] text-text'
                      : shortcut
                        ? 'border-border bg-[var(--t-surface-2)] text-text-soft'
                        : 'border-dashed border-border text-muted',
                  )}
                >
                  {isRecording ? '按下快捷键…' : shortcut ? formatShortcut(shortcut) : '未绑定'}
                </kbd>
                <button
                  type="button"
                  onClick={() => {
                    setWarning(null)
                    setRecording(isRecording ? null : command.id)
                  }}
                  aria-label={`修改 ${command.title} 快捷键`}
                  className="rounded px-1 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
                >
                  {isRecording ? '取消' : '修改'}
                </button>
                {shortcut !== command.defaultShortcut && (
                  <button
                    type="button"
                    onClick={() => {
                      setCommandShortcut(command.id, null)
                      setWarning(null)
                      setVersion((v) => v + 1)
                    }}
                    aria-label={`恢复 ${command.title} 默认快捷键`}
                    className="rounded px-1 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
                  >
                    默认
                  </button>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
      {warning && (
        <p role="status" className="mt-2 rounded-md bg-[var(--t-warning-soft)] px-2 py-1.5 text-[12px] text-warning">
          {warning}
        </p>
      )}
      <p className="mt-2 text-[12px] leading-5 text-muted">
        快捷键保存在当前设备；命令面板、移动端顶栏搜索与设置搜索共用同一份命令注册表。
      </p>
    </div>
  )
}
