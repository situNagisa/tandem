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

  // Edge 划词迷你菜单（反馈11#06）：网页无法改 Edge 设置，但迷你菜单是在 mouseup 时按
  // 当前选区生成的。这里同步收起选区、下一帧恢复，菜单不再出现，选区与 Ctrl+C 保持可用。
  useEffect(() => {
    if (!/Edg\//.test(navigator.userAgent)) return
    document.documentElement.dataset.edgeSelectionGuard = 'on'
    let timer = 0
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      // 表单控件/自绘选区/预览 iframe 本来就不触发迷你菜单。
      if (
        target.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, [data-feedback-ui]',
        )
      )
        return
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return
      const ranges = Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
      selection.removeAllRanges()
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = 0
        const current = window.getSelection()
        // 收起期间用户又点了别处：以新的交互为准，不恢复旧选区。
        if (!current || !current.isCollapsed) return
        current.removeAllRanges()
        for (const range of ranges) current.addRange(range)
        window.dispatchEvent(new CustomEvent('tandem:selection-guard'))
      }, 80)
    }
    document.addEventListener('mouseup', onMouseUp, true)
    return () => {
      document.removeEventListener('mouseup', onMouseUp, true)
      window.clearTimeout(timer)
    }
  }, [])

  // 兜底关闭浏览器自动填充/拼写建议：覆盖所有路由与 Portal 里动态渲染的输入框
  // （组件层大多已显式关闭，这里防止新增输入框漏配）。密码框保留浏览器语义。
  useEffect(() => {
    const apply = (el: Element) => {
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
      if (el instanceof HTMLInputElement && el.type === 'password') return
      if (!el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off')
      if (!el.hasAttribute('spellcheck')) el.setAttribute('spellcheck', 'false')
      el.setAttribute('writingsuggestions', 'false')
    }
    document.querySelectorAll('input, textarea').forEach(apply)
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element) apply(event.target)
    }
    document.addEventListener('focusin', onFocus, true)
    // 弹层/设置页是后挂载的：新加入的输入框同样补齐属性。
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) apply(node)
          else if (node instanceof Element) node.querySelectorAll('input, textarea').forEach(apply)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      document.removeEventListener('focusin', onFocus, true)
      observer.disconnect()
    }
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
