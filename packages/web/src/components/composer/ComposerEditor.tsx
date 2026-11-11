import {
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdownLive } from './markdownLive'

export interface ComposerEditorHandle {
  element: HTMLElement | null
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
  elementRef: MutableRefObject<HTMLElement | null>
  composingRef: MutableRefObject<boolean>
  setComposing: Dispatch<SetStateAction<boolean>>
  setCompletion: (value: null) => void
  onChange: (value: string, caret: number) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  onPaste: (e: ReactClipboardEvent<HTMLDivElement>) => void
}

/**
 * 输入框编辑面：CodeMirror 6 承担文本、撤销、选区与输入法；
 * 实时预览由 `markdownLive` 的装饰提供（光标行显示源码，其余行按渲染样式显示）。
 */
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
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latestText = useRef(text)
  latestText.current = text
  const syncingRef = useRef(false)
  const editableCompartment = useRef(new Compartment())
  const callbacks = useRef({
    onChange,
    setComposing,
    setCompletion,
    composingRef,
  })
  callbacks.current = { onChange, setComposing, setCompletion, composingRef }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initialState = EditorState.create({
      doc: text,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        markdownLive({
          onCompositionStart: () => {
            callbacks.current.composingRef.current = true
            callbacks.current.setComposing(true)
          },
          onCompositionEnd: () => {
            callbacks.current.composingRef.current = false
            callbacks.current.setComposing(false)
            const view = viewRef.current
            if (!view) return
            callbacks.current.onChange(
              view.state.doc.toString(),
              view.state.selection.main.head,
            )
          },
        }),
        editableCompartment.current.of(EditorView.editable.of(!disabled)),
        EditorView.contentAttributes.of({
          'aria-label': '消息输入框',
          'aria-multiline': 'true',
          role: 'textbox',
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          autocomplete: 'off',
          'data-testid': 'composer-input',
        }),
        EditorView.updateListener.of((update) => {
          const view = update.view
          view.contentDOM.dataset.value = view.state.doc.toString()
          view.contentDOM.dataset.caret = String(view.state.selection.main.head)
          if (syncingRef.current) return
          if (!update.docChanged) return
          callbacks.current.onChange(
            view.state.doc.toString(),
            view.state.selection.main.head,
          )
        }),
      ],
    })
    const view = new EditorView({ state: initialState, parent: host })
    viewRef.current = view
    elementRef.current = view.contentDOM
    view.contentDOM.dataset.value = view.state.doc.toString()
    view.contentDOM.dataset.caret = String(view.state.selection.main.head)
    view.contentDOM.setAttribute('autocomplete', 'off')
    return () => {
      if (elementRef.current === view.contentDOM) elementRef.current = null
      view.destroy()
      viewRef.current = null
    }
    // 只创建一次：后续文本、禁用状态与外部选择通过 effect / handle 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 受控文本：外部（草稿恢复、补全插入、发送后清空）改文本时同步到 CodeMirror。
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === text) return
    const head = Math.min(view.state.selection.main.head, text.length)
    syncingRef.current = true
    view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      selection: { anchor: head },
    })
    syncingRef.current = false
  }, [text])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableCompartment.current.reconfigure(EditorView.editable.of(!disabled)),
    })
    const content = view.contentDOM
    if (disabled) content.setAttribute('aria-disabled', 'true')
    else content.removeAttribute('aria-disabled')
  }, [disabled])

  const placeholderText =
    placeholder ?? (running ? '运行中，可继续输入，消息会排队发送…' : '给 Tandem 发消息…')

  useEffect(() => {
    viewRef.current?.contentDOM.setAttribute('data-placeholder', placeholderText)
  }, [placeholderText])

  useImperativeHandle(
    editorRef,
    () => ({
      get element() {
        return viewRef.current?.contentDOM ?? null
      },
      focus: () => viewRef.current?.focus(),
      getSelection: () => {
        const view = viewRef.current
        if (!view) return { start: 0, end: 0 }
        const main = view.state.selection.main
        return { start: main.from, end: main.to }
      },
      setSelection: (start: number, end = start) => {
        const view = viewRef.current
        if (!view) return
        const target = latestText.current
        const from = Math.max(0, Math.min(start, target.length))
        const to = Math.max(from, Math.min(end, target.length))
        if (view.state.doc.toString() !== target) {
          syncingRef.current = true
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: target },
            selection: { anchor: from, head: to },
          })
          syncingRef.current = false
        } else {
          view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
        }
        view.focus()
      },
    }),
    [],
  )

  const handlePaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    onPaste(e)
    if (e.defaultPrevented) {
      // 图片/长文本由外层接管，别让 CodeMirror 再把剪贴板内容插一遍。
      e.stopPropagation()
      return
    }
    const plain = e.clipboardData?.getData('text/plain')
    if (!plain) return
    e.preventDefault()
    e.stopPropagation()
    const view = viewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: plain },
      selection: { anchor: from + plain.length },
      scrollIntoView: true,
    })
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown(e)
    // 发送/续号/缩进等由外层接管时，不再让 CodeMirror 的默认键位重复生效。
    if (e.defaultPrevented) e.stopPropagation()
  }

  return (
    <div className="composer-editor" data-composing={composing || undefined}>
      <div
        ref={hostRef}
        className="composer-cm"
        onKeyDownCapture={handleKeyDown}
        onPasteCapture={handlePaste}
        onBlur={() => setCompletion(null)}
      />
      {!text && (
        <span className="composer-placeholder" aria-hidden="true">
          {placeholderText}
        </span>
      )}
    </div>
  )
}
