import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { parseEditor, type EditorLine } from './richEditor'

export interface ComposerEditorHandle {
  element: HTMLDivElement | null
  focus: () => void
  getSelection: () => { start: number; end: number }
  setSelection: (start: number, end?: number) => void
}

interface ComposerEditorProps {
  text: string
  composing: boolean
  disabled: boolean
  placeholder: string | undefined
  running: boolean
  editorRef: MutableRefObject<ComposerEditorHandle | null>
  elementRef: MutableRefObject<HTMLDivElement | null>
  composingRef: MutableRefObject<boolean>
  setComposing: Dispatch<SetStateAction<boolean>>
  setCompletion: (value: null) => void
  onChange: (value: string, caret: number) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  onPaste: (e: ReactClipboardEvent<HTMLDivElement>) => void
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE', 'UL', 'OL'])

/** 从编辑区 DOM 读回纯文本（块级元素、<br> 都算换行；token 展开为完整路径）。 */
function readText(root: HTMLElement): string {
  const lines: string[] = []
  let current = ''
  const flush = () => {
    lines.push(current)
    current = ''
  }
  const walk = (parent: Node) => {
    const children = Array.from(parent.childNodes)
    children.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const element = child.parentElement
        current += element?.dataset.src ?? (child as Text).data
        return
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return
      const el = child as HTMLElement
      if (el.dataset.src) {
        current += el.dataset.src
      } else if (el.tagName === 'BR') {
        // 块尾的 <br> 只是给空行占位，换行由块边界负责。
        if (index < children.length - 1) flush()
      } else if (BLOCK_TAGS.has(el.tagName)) {
        walk(el)
        flush()
      } else {
        walk(el)
      }
    })
  }
  walk(root)
  flush()
  // 末尾多出的一行来自最后一次 flush；文本本身以它结尾时保留。
  if (lines.length > 1) lines.pop()
  return lines.join('\n')
}

function runLength(el: Element): number {
  if (el instanceof HTMLElement && el.dataset.src) {
    return Number(el.dataset.len ?? el.dataset.src.length)
  }
  return el.textContent?.length ?? 0
}

function fragmentLength(fragment: Node): number {
  let total = 0
  fragment.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      total += (child as Text).data.length
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement
      if (el.dataset.src) total += Number(el.dataset.len ?? el.dataset.src.length)
      else if (el.tagName !== 'BR') total += fragmentLength(el)
    }
  })
  return total
}

function withinLine(line: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(line, 0)
  range.setEnd(node, offset)
  return fragmentLength(range.cloneContents())
}

function caretOffset(root: HTMLElement): number | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const node = selection.focusNode
  if (!node || !root.contains(node)) return null
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  const line = element?.closest<HTMLElement>('.ce-line')
  if (line && root.contains(line)) {
    return Number(line.dataset.os ?? 0) + withinLine(line, node, selection.focusOffset)
  }
  // 原生粘贴/输入法可能临时把文本直接挂在根节点上：按整段文本算偏移。
  const range = document.createRange()
  range.setStart(root, 0)
  range.setEnd(node, selection.focusOffset)
  return fragmentLength(range.cloneContents())
}

function placeCaret(root: HTMLElement, offset: number): void {
  const lines = Array.from(root.querySelectorAll<HTMLElement>(':scope > .ce-line'))
  if (!lines.length) return
  let line = lines[lines.length - 1]!
  for (const candidate of lines) {
    if (offset <= Number(candidate.dataset.end ?? 0)) {
      line = candidate
      break
    }
  }
  const base = Number(line.dataset.os ?? 0)
  let delta = offset - base
  const range = document.createRange()
  let placed = false
  for (const child of Array.from(line.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const length = (child as Text).data.length
      if (delta <= length) {
        range.setStart(child, delta)
        placed = true
        break
      }
      delta -= length
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as HTMLElement
    const start = Number(el.dataset.os ?? base) - base
    const length = runLength(el)
    if (delta < start) {
      range.setStartBefore(el)
      placed = true
      break
    }
    if (delta <= start + length) {
      if (el.dataset.src) {
        if (delta <= start) range.setStartBefore(el)
        else range.setStartAfter(el)
      } else {
        const text = el.firstChild
        const inner = Math.min(delta - start, el.textContent?.length ?? 0)
        if (text && text.nodeType === Node.TEXT_NODE) range.setStart(text, inner)
        else range.setStart(el, inner)
      }
      placed = true
      break
    }
  }
  if (!placed) {
    range.setStart(line, line.childNodes.length)
  }
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function context(
  line: EditorLine,
  style: CSSStyleDeclaration,
): void {
  if (line.indent) style.setProperty('--ce-indent', `${Math.min(line.indent, 12) * 0.55}em`)
}

function paint(root: HTMLElement, text: string): void {
  const lines = parseEditor(text)
  const fragment = document.createDocumentFragment()
  for (const line of lines) {
    const div = document.createElement('div')
    div.className = line.cls ? `ce-line ${line.cls}` : 'ce-line'
    div.dataset.os = String(line.start)
    div.dataset.end = String(line.end)
    context(line, div.style)
    if (!line.runs.length) {
      div.appendChild(document.createElement('br'))
    }
    for (const run of line.runs) {
      const span = document.createElement('span')
      span.textContent = run.text
      span.dataset.os = String(run.os)
      if (run.cls) span.className = run.cls
      if (run.len !== undefined) span.dataset.len = String(run.len)
      if (run.src) {
        span.dataset.src = run.src
        span.contentEditable = 'false'
        span.className = `${span.className} ce-token`.trim()
        if (run.title) span.title = run.title
      }
      div.appendChild(span)
    }
    fragment.appendChild(div)
  }
  root.replaceChildren(fragment)
  root.dataset.value = text
}

export function ComposerEditor({
      text,
      composing,
      disabled,
      placeholder,
      running,
      editorRef,
      elementRef,
      composingRef,
      setComposing,
      setCompletion,
      onChange,
      onKeyDown,
      onPaste,
    }: ComposerEditorProps) {
    const rootRef = useRef<HTMLDivElement | null>(null)
    const caretRef = useRef(0)
    const paintedRef = useRef<string | null>(null)
    const callbacks = useRef({ onChange })
    callbacks.current.onChange = onChange

    const setRoot = (node: HTMLDivElement | null) => {
      rootRef.current = node
      elementRef.current = node
    }

    const selectionOf = (): { start: number; end: number } => {
      const root = rootRef.current
      if (!root) return { start: caretRef.current, end: caretRef.current }
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || !root.contains(selection.focusNode)) {
        return { start: caretRef.current, end: caretRef.current }
      }
      const range = selection.getRangeAt(0)
      const read = (node: Node, offset: number) => {
        const element =
          node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
        const line = element?.closest<HTMLElement>('.ce-line')
        if (line && root.contains(line)) {
          return Number(line.dataset.os ?? 0) + withinLine(line, node, offset)
        }
        const range = document.createRange()
        range.setStart(root, 0)
        range.setEnd(node, offset)
        return fragmentLength(range.cloneContents())
      }
      return {
        start: read(range.startContainer, range.startOffset),
        end: read(range.endContainer, range.endOffset),
      }
    }

    const setSelection = (start: number) => {
      const root = rootRef.current
      caretRef.current = Math.max(0, Math.min(start, text.length))
      if (!root) return
      root.focus()
      placeCaret(root, caretRef.current)
      root.dataset.caret = String(caretRef.current)
    }

    useImperativeHandle(
      editorRef,
      () => ({
        element: rootRef.current,
        focus: () => rootRef.current?.focus(),
        getSelection: selectionOf,
        setSelection,
      }),
      [text],
    )

    useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      if (composingRef.current || composing) return
      if (paintedRef.current === text) return
      paint(root, text)
      paintedRef.current = text
      const caret = Math.min(caretRef.current, text.length)
      if (document.activeElement === root) placeCaret(root, caret)
    }, [text, composing, composingRef])

    // 外部（草稿恢复、补全插入）直接清空文本后，把光标落到末尾。
    useEffect(() => {
      const root = rootRef.current
      if (!root) return
      if (document.activeElement === root && text.length < caretRef.current) {
        caretRef.current = text.length
        placeCaret(root, text.length)
      }
    }, [text])

    useEffect(() => {
      // div 上 React 没有 autoComplete 属性，直接落到 DOM 上，和输入框一致关闭自动填充。
      rootRef.current?.setAttribute('autocomplete', 'off')
    }, [])

    useEffect(() => {
      const onSelectionChange = () => {
        const root = rootRef.current
        if (!root || document.activeElement !== root) return
        const caret = caretOffset(root)
        if (caret === null) return
        caretRef.current = caret
        root.dataset.caret = String(caret)
      }
      document.addEventListener('selectionchange', onSelectionChange)
      return () => document.removeEventListener('selectionchange', onSelectionChange)
    }, [])

    const replaceSelection = (insert: string) => {
      const root = rootRef.current
      if (!root) return
      const { start, end } = selectionOf()
      const current = readText(root)
      const next = current.slice(0, start) + insert + current.slice(end)
      caretRef.current = start + insert.length
      paintedRef.current = null
      callbacks.current.onChange(next, caretRef.current)
    }

    return (
      <div className="composer-editor" data-composing={composing || undefined}>
        <div
          ref={setRoot}
          className="composer-rich max-sm:min-h-11"
          role="textbox"
          tabIndex={0}
          aria-label="消息输入框"
          aria-multiline="true"
          aria-disabled={disabled || undefined}
          data-testid="composer-input"
          data-empty={text ? undefined : 'true'}
          data-placeholder={
            placeholder ?? (running ? '运行中，可继续输入，消息会排队发送…' : '给 Tandem 发消息…')
          }
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onInput={() => {
            const root = rootRef.current
            if (!root) return
            const value = readText(root)
            root.dataset.value = value
            const caret = caretOffset(root) ?? Math.min(caretRef.current, value.length)
            caretRef.current = caret
            root.dataset.caret = String(caret)
            if (composingRef.current) return
            paintedRef.current = null
            callbacks.current.onChange(value, caret)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            onPaste(e)
            if (e.defaultPrevented) return
            const plain = e.clipboardData?.getData('text/plain')
            if (plain) {
              e.preventDefault()
              replaceSelection(plain)
            }
          }}
          onCopy={(e) => {
            const { start, end } = selectionOf()
            if (start === end) return
            e.preventDefault()
            e.clipboardData.setData('text/plain', text.slice(start, end))
          }}
          onCut={(e) => {
            const { start, end } = selectionOf()
            if (start === end) return
            e.preventDefault()
            e.clipboardData.setData('text/plain', text.slice(start, end))
            const root = rootRef.current
            if (!root) return
            const current = readText(root)
            const next = current.slice(0, start) + current.slice(end)
            caretRef.current = start
            paintedRef.current = null
            callbacks.current.onChange(next, start)
          }}
          onBlur={() => setCompletion(null)}
          onCompositionStart={() => {
            composingRef.current = true
            setComposing(true)
          }}
          onCompositionEnd={() => {
            composingRef.current = false
            setComposing(false)
            const root = rootRef.current
            if (!root) return
            const value = readText(root)
            const caret = caretOffset(root) ?? value.length
            caretRef.current = caret
            paintedRef.current = null
            callbacks.current.onChange(value, caret)
          }}
        />
        {!text && (
          <span className="composer-placeholder" aria-hidden="true">
            {placeholder ??
              (running ? '运行中，可继续输入，消息会排队发送…' : '给 Tandem 发消息…')}
          </span>
        )}
      </div>
    )
}
