import { memo, useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react'
import type { ContentBlock } from '@tandem/protocol'
import { Check, Copy, GitFork, MoreHorizontal, PencilLine, Pin, Undo2 } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import type { UiMessage } from '../../lib/types'
import { RewindDialog } from '../RewindDialog'
import { Menu } from '../ui/Menu'
import { Button, IconButton } from '../ui/Button'
import { dataUrl } from './MessageNotes'

export const UserMessage = memo(function UserMessage({
  message,
  animate,
  readOnly = false,
}: {
  message: UiMessage
  animate: boolean
  readOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [rewindOpen, setRewindOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const pressTimer = useRef<number | null>(null)
  const pressReady = useRef(false)
  const pressStart = useRef<{ x: number; y: number } | null>(null)
  const running = useAppStore((s) => s.active?.running ?? false)
  const pinnedTurns = useAppStore((s) => s.active?.summary?.pinnedTurns)
  const pinned = !!pinnedTurns?.includes(message.id)
  const timer = useRef<number | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const blocks = message.content.filter((b) => b.type !== 'tool_result')
  const images = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image',
  )
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
      if (pressTimer.current) window.clearTimeout(pressTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (!editing) return
    const el = editRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  if (!text.trim() && images.length === 0) return null

  const startPress = (e: ReactTouchEvent) => {
    if (readOnly || editing) return
    if (pressTimer.current) window.clearTimeout(pressTimer.current)
    pressStart.current = { x: e.touches[0]?.clientX ?? 0, y: e.touches[0]?.clientY ?? 0 }
    pressReady.current = false
    // 只标记已长按，等手指抬起再打开：否则菜单会出现在手指下，抬手的那一下会误触菜单项。
    pressTimer.current = window.setTimeout(() => {
      pressReady.current = true
    }, 480)
  }
  const endPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current)
    pressTimer.current = null
    if (!pressReady.current) return
    pressReady.current = false
    // 延迟到本次触摸产生的合成 click 结束后再开菜单，避免抬手那一下点中菜单第一项。
    window.setTimeout(() => setMenuOpen(true), 120)
  }
  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current)
    pressTimer.current = null
    pressReady.current = false
    pressStart.current = null
  }
  const movePress = (e: ReactTouchEvent) => {
    const start = pressStart.current
    if (!start) return
    const touch = e.touches[0]
    if (!touch) return
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) cancelPress()
  }

  const copy = async () => {
    if (!(await copyText(text))) return
    setCopied(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const togglePin = () => {
    const state = useAppStore.getState()
    const active = state.active
    if (!active?.summary) return
    const current = active.summary.pinnedTurns ?? []
    const next = current.includes(message.id)
      ? current.filter((id) => id !== message.id)
      : [...current, message.id]
    void state.updateSession(active.hostId, active.sessionId, { pinnedTurns: next })
  }

  const forkFromHere = () => {
    const active = useAppStore.getState().active
    if (!active) return
    void useAppStore.getState().forkSession(active.hostId, active.sessionId, message.id)
  }

  const startEdit = () => {
    setDraft(text)
    setEditing(true)
  }

  const submitEdit = () => {
    const next = draft.trim()
    if (!next) return
    if (next === text.trim()) {
      setEditing(false)
      return
    }
    if (useAppStore.getState().send([{ type: 'text', text: next }])) {
      setEditing(false)
    }
  }

  return (
    <div className={cn('msg-group flex justify-end', animate && 'chat-msg-enter')}>
      <div
        className="relative min-w-0 max-w-[80%]"
        onTouchStart={startPress}
        onTouchMove={movePress}
        onTouchEnd={endPress}
        onTouchCancel={cancelPress}
        onContextMenu={(e) => {
          if (readOnly) return
          // 触屏长按由 touch 逻辑处理，避免 contextmenu 在手指未抬起时弹出菜单造成误触。
          if (window.matchMedia('(pointer: coarse)').matches) return
          e.preventDefault()
          setMenuOpen(true)
        }}
      >
        {images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {images.map((img, i) => (
              <img
                key={i}
                src={dataUrl(img)}
                alt={`图片 ${i + 1}`}
                className="max-h-64 max-w-full rounded-[14px] border border-border object-contain"
              />
            ))}
          </div>
        )}
        {editing ? (
          <div className="rounded-[14px] bg-surface-2 px-3 py-2.5 text-left">
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(false)
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submitEdit()
                }
              }}
              rows={3}
              aria-label="编辑并重发"
              className="min-h-16 w-full resize-y bg-transparent text-[14.5px] leading-[1.68] text-text outline-none"
            />
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button size="sm" variant="primary" onClick={submitEdit} disabled={!draft.trim()}>
                编辑并重发
              </Button>
            </div>
          </div>
        ) : (
          text.trim() && (
            <div className="whitespace-pre-wrap break-words rounded-[14px] bg-surface-2 px-4 py-2.5 text-[14.5px] leading-[1.68] text-text">
              {text}
            </div>
          )
        )}
        {text.trim() && !editing && (
          <>
            <div className="msg-actions mt-0.5 flex h-7 justify-end gap-0.5">
              <IconButton
                size="sm"
                onClick={copy}
                label={copied ? '已复制' : '复制消息'}
                tooltip={copied ? '已复制' : '复制'}
                className="[&_svg]:size-[12.5px]"
              >
                {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
              </IconButton>
              {!readOnly && (
                <>
                  <IconButton
                    size="sm"
                    onClick={togglePin}
                    label={pinned ? '取消固定此轮' : '固定此轮'}
                    tooltip={pinned ? '取消固定此轮' : '固定此轮（轮次大纲中特殊显示）'}
                    className={cn('[&_svg]:size-[12.5px]', pinned && 'text-accent-text')}
                  >
                    <Pin size={12.5} fill={pinned ? 'currentColor' : 'none'} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={forkFromHere}
                    label="从这里分叉"
                    tooltip="从这里分叉（复制到这条消息为止）"
                    className="[&_svg]:size-[12.5px]"
                  >
                    <GitFork size={12.5} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={startEdit}
                    label="编辑并重发"
                    className="[&_svg]:size-[12.5px]"
                  >
                    <PencilLine size={12.5} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={() => setRewindOpen(true)}
                    disabled={running}
                    label="回退到此处"
                    tooltip={running ? '会话运行中，结束后才能回退' : '回退到此处'}
                    className="[&_svg]:size-[12.5px]"
                  >
                    <Undo2 size={12.5} />
                  </IconButton>
                </>
              )}
            </div>
            <div className="msg-more mt-0.5 h-7 justify-end max-md:h-11">
              {readOnly ? (
                <IconButton
                  onClick={() => void copy()}
                  label={copied ? '已复制' : '复制消息'}
                  className="[&_svg]:size-[13px] max-md:size-11 [&_svg]:max-md:size-[17px]"
                >
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </IconButton>
              ) : (
              <Menu
                aria-label="消息操作"
                align="right"
                side="top"
                open={menuOpen}
                onOpenChange={setMenuOpen}
                trigger={({ open }) => (
                  <IconButton label="消息操作" tooltip={open ? '' : undefined} className="[&_svg]:size-[15px] max-md:size-11 [&_svg]:max-md:size-[17px]">
                    <MoreHorizontal size={15} />
                  </IconButton>
                )}
              >
                <>
                    <Menu.Item
                      icon={<Copy />}
                      onSelect={() => {
                        void copy()
                      }}
                    >
                      {copied ? '已复制' : '复制消息'}
                    </Menu.Item>
                    <Menu.Item
                      icon={<Pin />}
                      onSelect={() => {
                        togglePin()
                      }}
                    >
                      {pinned ? '取消固定此轮' : '固定此轮'}
                    </Menu.Item>
                    <Menu.Item
                      icon={<GitFork />}
                      onSelect={() => {
                        forkFromHere()
                      }}
                    >
                      从这里分叉
                    </Menu.Item>
                    <Menu.Item
                      icon={<PencilLine />}
                      onSelect={() => {
                        startEdit()
                      }}
                    >
                      编辑并重发
                    </Menu.Item>
                    <Menu.Item
                      icon={<Undo2 />}
                      disabled={running}
                      disabledReason={running ? '会话运行中，结束后才能回退' : undefined}
                      onSelect={() => {
                        setRewindOpen(true)
                      }}
                    >
                      回退到此处
                    </Menu.Item>
</>
              </Menu>
              )}
            </div>
          </>
        )}
        {message.queued && (
          <div className="mt-1 text-right text-[12px] text-muted">已排队，当前回合结束后发送</div>
        )}
      </div>
      {rewindOpen && (
        <RewindDialog message={message} onClose={() => setRewindOpen(false)} />
      )}
    </div>
  )
})
