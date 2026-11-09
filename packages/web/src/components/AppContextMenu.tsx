import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Link2,
  Scissors,
  TextSelect,
} from 'lucide-react'
import { Menu } from './ui/Menu'

interface Editable {
  el: HTMLElement
  value(): string
  selected(): string
  insert(text: string): void
  removeSelection(): void
  selectAll(): void
}

interface MenuState {
  x: number
  y: number
  editable: Editable | null
  selection: string
  link: string | null
  image: string | null
}

function editableOf(node: Element | null): Editable | null {
  const el = node?.closest<HTMLElement>('input, textarea, [contenteditable=""], [contenteditable="true"]')
  if (!el) return null
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return null
    const read = () => el.value
    return {
      el,
      value: read,
      selected: () => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
      insert: (text) => {
        const start = el.selectionStart ?? el.value.length
        const end = el.selectionEnd ?? start
        el.focus()
        el.setRangeText(text, start, end, 'end')
        el.dispatchEvent(new Event('input', { bubbles: true }))
      },
      removeSelection: () => {
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? start
        if (start === end) return
        el.focus()
        el.setRangeText('', start, end, 'end')
        el.dispatchEvent(new Event('input', { bubbles: true }))
      },
      selectAll: () => {
        el.focus()
        el.select()
      },
    }
  }
  const currentSelection = () => window.getSelection()?.toString() ?? ''
  return {
    el,
    value: () => el.innerText,
    selected: () => (el.contains(document.activeElement) ? currentSelection() : ''),
    insert: (text) => {
      el.focus()
      document.execCommand('insertText', false, text)
    },
    removeSelection: () => {
      if (!window.getSelection()?.isCollapsed) document.execCommand('delete')
    },
    selectAll: () => {
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    },
  }
}

async function writeClipboard(text: string): Promise<void> {
  const desktop = window.tandemDesktop?.clipboard
  if (desktop?.writeText) {
    await desktop.writeText(text)
    return
  }
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 非安全上下文 / 权限被拒时退回选区复制。
    document.execCommand('copy')
  }
}

async function readClipboard(): Promise<string> {
  const desktop = window.tandemDesktop?.clipboard
  if (desktop?.readText) return desktop.readText()
  return navigator.clipboard.readText()
}

/**
 * 全局接管右键菜单（反馈9）：浏览器/Electron 默认菜单不再出现，统一用 ui/Menu。
 * 复制/剪切/粘贴/全选，链接与图片额外提供地址操作。文本选择本身保持可用。
 */
export function AppContextMenu() {
  const [state, setState] = useState<MenuState | null>(null)
  const [open, setOpen] = useState(false)
  const lastEditable = useRef<Editable | null>(null)

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      // 预览 iframe / 反馈圈选浮层有自己的交互，不接管。
      if (target.closest('[data-feedback-ui], iframe')) return
      event.preventDefault()
      const selection = window.getSelection()?.toString() ?? ''
      const editable = editableOf(target)
      if (editable) lastEditable.current = editable
      const link = target.closest<HTMLAnchorElement>('a[href]')?.href ?? null
      const image = target.closest<HTMLImageElement>('img')?.currentSrc ?? null
      setState({
        x: event.clientX,
        y: event.clientY,
        editable,
        selection,
        link,
        image,
      })
      setOpen(true)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  // 链接/图片默认拖拽不出 ghost（全局保留文本与元素的正常点击）。
  useEffect(() => {
    const onDragStart = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest('input, textarea, [contenteditable="true"], [draggable="true"]')) return
      if (target.closest('img, a')) event.preventDefault()
    }
    document.addEventListener('dragstart', onDragStart)
    return () => document.removeEventListener('dragstart', onDragStart)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const copy = () => {
    if (!state) return
    const text = state.selection || state.editable?.selected() || ''
    if (text) void writeClipboard(text)
  }

  const cut = () => {
    if (!state?.editable) return
    const text = state.editable.selected()
    if (!text) return
    void writeClipboard(text).then(() => state.editable?.removeSelection())
  }

  const paste = () => {
    const editable = state?.editable ?? lastEditable.current
    if (!editable?.el.isConnected) return
    void readClipboard()
      .then((text) => {
        if (text) editable.insert(text)
      })
      .catch(() => {
        // 浏览器只允许通过原生菜单粘贴；这里保持静默，不弹二级提示。
      })
  }

  const selectAll = () => {
    const editable = state?.editable ?? lastEditable.current
    if (editable?.el.isConnected) {
      editable.selectAll()
      return
    }
    const selection = window.getSelection()
    if (!selection) return
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(document.body)
    selection.addRange(range)
  }

  const link = state?.link ?? null
  const image = state?.image ?? null
  const canCopy = Boolean(state?.selection || state?.editable?.selected())
  const canCut = Boolean(state?.editable?.selected())
  const canPaste = Boolean(state?.editable ?? lastEditable.current)

  return (
    <Menu
      key={`${state?.x ?? 0}:${state?.y ?? 0}`}
      open={open}
      onOpenChange={(next) => setOpen(next)}
      modal={false}
      side="bottom"
      align="start"
      sideOffset={2}
      aria-label="页面右键菜单"
      trigger={
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: state?.x ?? -100,
            top: state?.y ?? -100,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      }
    >
      <Menu.Item icon={<Copy size={13} />} disabled={!canCopy} onSelect={() => { copy(); close() }}>
        复制
      </Menu.Item>
      <Menu.Item icon={<Scissors size={13} />} disabled={!canCut} onSelect={() => { cut(); close() }}>
        剪切
      </Menu.Item>
      <Menu.Item icon={<ClipboardPaste size={13} />} disabled={!canPaste} onSelect={() => { paste(); close() }}>
        粘贴
      </Menu.Item>
      <Menu.Item icon={<TextSelect size={13} />} onSelect={() => { selectAll(); close() }}>
        全选
      </Menu.Item>
      {link || image ? <Menu.Separator /> : null}
      {link ? (
        <Menu.Item
          icon={<Link2 size={13} />}
          onSelect={() => {
            if (link) void writeClipboard(link)
            close()
          }}
        >
          复制链接地址
        </Menu.Item>
      ) : null}
      {link ? (
        <Menu.Item
          icon={<ExternalLink size={13} />}
          onSelect={() => {
            if (link) window.open(link, '_blank', 'noopener')
            close()
          }}
        >
          在浏览器打开
        </Menu.Item>
      ) : null}
      {image ? (
        <Menu.Item
          icon={<ImageIcon size={13} />}
          onSelect={() => {
            if (image) void writeClipboard(image)
            close()
          }}
        >
          复制图片地址
        </Menu.Item>
      ) : null}
    </Menu>
  )
}
