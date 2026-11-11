/**
 * 输入框的「实时预览」装饰（Obsidian 式）：
 * - 光标/选区所在行显示 Markdown 源码，标记符淡化可见；
 * - 其余行隐藏标记符，按渲染后的样式显示；
 * - 代码块与表格按整块处理：光标在块内显示源码，否则渲染成与消息区一致的卡片。
 * 只生成 CodeMirror 装饰，不改变文档内容；发送仍是原始 Markdown。
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { pathTokens } from './richEditor'

/** 只做语法解析，不启用 CodeMirror 自带的高亮与 Markdown 键位。 */
const MARKDOWN_SUPPORT: Extension = markdown({
  base: markdownLanguage,
  addKeymap: false,
  pasteURLAsLink: false,
})

const MARKER = Decoration.mark({ class: 'md-marker' })
const STRONG = Decoration.mark({ class: 'md-strong' })
const EMPHASIS = Decoration.mark({ class: 'md-em' })
const STRIKE = Decoration.mark({ class: 'md-strike' })
const INLINE_CODE = Decoration.mark({ class: 'md-inline-code' })
const LINK = Decoration.mark({ class: 'md-link' })
const LIST_MARK = Decoration.mark({ class: 'md-list-mark' })
const TASK_MARK = Decoration.mark({ class: 'md-marker md-task' })

const INLINE_REPLACE = Decoration.replace({})

/** 把光标放进被装饰块里：点渲染后的卡片就回到源码。 */
function selectInto(view: EditorView, pos: number) {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  view.focus()
}

abstract class ClickableWidget extends WidgetType {
  constructor(readonly from: number) {
    super()
  }
  protected wire(el: HTMLElement, view: EditorView) {
    el.addEventListener('mousedown', (event) => {
      event.preventDefault()
      selectInto(view, this.from)
    })
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'md-bullet'
    span.textContent = '•'
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  eq(): boolean {
    return true
  }
}

class PathWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly src: string,
    readonly name: string,
  ) {
    super()
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'ce-path'
    span.textContent = this.name
    span.title = this.src
    return span
  }
  eq(other: PathWidget): boolean {
    return other.src === this.src && other.name === this.name
  }
  ignoreEvent(): boolean {
    return true
  }
}

class RuleWidget extends ClickableWidget {
  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement('div')
    div.className = 'md-rule-widget'
    this.wire(div, view)
    return div
  }
  eq(other: RuleWidget): boolean {
    return other.from === this.from
  }
}

class CodeWidget extends ClickableWidget {
  constructor(
    from: number,
    readonly code: string,
    readonly language: string | undefined,
  ) {
    super(from)
  }
  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement('div')
    card.className = 'chat-code md-code-widget'
    if (this.language) card.dataset.language = this.language
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = this.code
    pre.appendChild(code)
    card.appendChild(pre)
    this.wire(card, view)
    return card
  }
  eq(other: CodeWidget): boolean {
    return (
      other.from === this.from &&
      other.code === this.code &&
      other.language === this.language
    )
  }
  get estimatedHeight(): number {
    return 18 + Math.min(30, this.code.split('\n').length) * 21
  }
}

function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\' && text[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function parseTable(raw: string): {
  header: string[]
  rows: string[][]
  align: Array<'left' | 'center' | 'right'>
} {
  const lines = raw.split('\n').filter((line) => line.trim())
  const header = lines[0] ? splitRow(lines[0]) : []
  const delimiter = lines[1] ? splitRow(lines[1]) : []
  const align = header.map((_, index) => {
    const cell = delimiter[index] ?? ''
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
  const rows = lines.slice(2).map(splitRow)
  return { header, rows, align }
}

function tableElement(raw: string): HTMLElement {
  const { header, rows, align } = parseTable(raw)
  const wrap = document.createElement('div')
  wrap.className = 'md-table-widget'
  const scroll = document.createElement('div')
  scroll.className = 'md-table-widget-scroll'
  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  header.forEach((cell, index) => {
    const th = document.createElement('th')
    th.textContent = cell
    th.style.textAlign = align[index] ?? 'left'
    headRow.appendChild(th)
  })
  thead.appendChild(headRow)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  rows.forEach((row) => {
    const tr = document.createElement('tr')
    for (let index = 0; index < header.length; index++) {
      const td = document.createElement('td')
      td.textContent = row[index] ?? ''
      td.style.textAlign = align[index] ?? 'left'
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  })
  table.appendChild(tbody)
  scroll.appendChild(table)
  wrap.appendChild(scroll)
  return wrap
}

class TableWidget extends ClickableWidget {
  constructor(
    from: number,
    readonly raw: string,
  ) {
    super(from)
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = tableElement(this.raw)
    this.wire(wrap, view)
    return wrap
  }
  eq(other: TableWidget): boolean {
    return other.from === this.from && other.raw === this.raw
  }
  get estimatedHeight(): number {
    return 20 + this.raw.split('\n').length * 30
  }
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child)
  return out
}

interface LineInfo {
  classes: Set<string>
  style?: string
}

function build(state: EditorState): DecorationSet {
  const doc = state.doc
  const ranges: Array<Range<Decoration>> = []
  const selection = state.selection.ranges
  const lineInfo = new Map<number, LineInfo>()
  const inactiveBlocks: Array<{ from: number; to: number }> = []
  const tokens = pathTokens(doc.toString())

  const lineActive = (from: number, to: number) =>
    selection.some((range) => range.from <= to && range.to >= from)
  const blockActive = (from: number, to: number) =>
    selection.some((range) =>
      range.from === range.to
        ? range.from >= from && range.from <= to
        : range.from < to && range.to > from,
    )
  const insideToken = (from: number, to: number) =>
    tokens.some((token) => from < token.to && to > token.from)

  const lineClass = (lineFrom: number, classes: string, style?: string) => {
    const info = lineInfo.get(lineFrom) ?? { classes: new Set<string>() }
    for (const name of classes.split(' ')) if (name) info.classes.add(name)
    if (style) info.style = style
    lineInfo.set(lineFrom, info)
  }

  const hide = (from: number, to: number) => {
    if (to <= from) return
    ranges.push(INLINE_REPLACE.range(from, to))
  }

  const dimMarker = (from: number, to: number) => {
    if (to <= from) return
    ranges.push(MARKER.range(from, to))
  }

  const skipSpaces = (pos: number, end = doc.length): number => {
    let next = pos
    while (next < end && doc.sliceString(next, next + 1) === ' ') next++
    return next
  }

  // 行内标记：命中选区所在行的标记符保持可见，只淡化。
  const handleMarker = (from: number, to: number, hideOnIdle: boolean) => {
    if (insideToken(from, to)) return
    const line = doc.lineAt(from)
    if (hideOnIdle && !lineActive(line.from, line.to)) hide(from, Math.min(to, line.to))
    else dimMarker(from, Math.min(to, line.to))
  }

  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
  tree.iterate({
    enter: (node) => {
      const name = node.name
      if (name === 'FencedCode') {
        const startLine = doc.lineAt(node.from)
        const endLine = doc.lineAt(node.to)
        if (blockActive(node.from, node.to)) {
          const total = endLine.number - startLine.number + 1
          for (let index = 0; index < total; index++) {
            const line = doc.line(startLine.number + index)
            let classes = 'md-code-line'
            let style = ''
            if (index === 0) classes += ' md-code-first'
            if (index === total - 1) {
              classes += ' md-code-last'
              if (index === 0) style = 'padding-bottom: 6px'
            }
            lineClass(line.from, classes, style || undefined)
          }
        } else {
          inactiveBlocks.push({ from: startLine.from, to: endLine.to })
          let codeFrom = Math.min(startLine.to + 1, doc.length)
          let codeTo = endLine.to
          if (endLine.number !== startLine.number && /^(\s{0,3})(`{3,}|~{3,})/.test(endLine.text)) {
            codeTo = endLine.from
          }
          if (endLine.number === startLine.number) {
            codeFrom = endLine.to
            codeTo = endLine.to
          }
          const code = doc.sliceString(codeFrom, codeTo).replace(/\n$/, '')
          const info = node.node.getChild('CodeInfo')
          const language = info ? doc.sliceString(info.from, info.to).trim() : undefined
          ranges.push(
            Decoration.replace({
              widget: new CodeWidget(startLine.from, code, language || undefined),
              block: true,
            }).range(startLine.from, endLine.to),
          )
        }
        return false
      }
      if (name === 'Table') {
        const startLine = doc.lineAt(node.from)
        const endLine = doc.lineAt(node.to)
        if (blockActive(node.from, node.to)) {
          for (let number = startLine.number; number <= endLine.number; number++) {
            lineClass(doc.line(number).from, 'md-table-source-line')
          }
        } else {
          inactiveBlocks.push({ from: startLine.from, to: endLine.to })
          const raw = doc.sliceString(startLine.from, endLine.to)
          ranges.push(
            Decoration.replace({
              widget: new TableWidget(startLine.from, raw),
              block: true,
            }).range(startLine.from, endLine.to),
          )
        }
        return false
      }
      if (name === 'Blockquote') {
        for (let number = doc.lineAt(node.from).number; number <= doc.lineAt(node.to).number; number++) {
          lineClass(doc.line(number).from, 'md-quote-line')
        }
        return true
      }
      if (name.startsWith('ATXHeading')) {
        const level = Number(name.slice(-1)) || 1
        const line = doc.lineAt(node.from)
        lineClass(line.from, `md-heading md-heading-${level}`)
        return true
      }
      if (name === 'HeaderMark') {
        handleMarker(node.from, skipSpaces(node.to, doc.lineAt(node.to).to), true)
        return false
      }
      if (name === 'QuoteMark') {
        handleMarker(node.from, skipSpaces(node.to, doc.lineAt(node.to).to), true)
        return false
      }
      if (name === 'ListMark') {
        const line = doc.lineAt(node.from)
        const list = node.node.parent?.parent?.name
        const marker = doc.sliceString(node.from, node.to)
        const bullet = list === 'BulletList' || /^[-*+]$/.test(marker)
        lineClass(line.from, 'md-list-line')
        if (bullet) {
          if (lineActive(line.from, line.to)) {
            dimMarker(node.from, node.to)
          } else {
            ranges.push(
              Decoration.replace({
                widget: new BulletWidget(),
              }).range(node.from, skipSpaces(node.to, line.to)),
            )
          }
        } else {
          ranges.push(LIST_MARK.range(node.from, node.to))
        }
        return false
      }
      if (name === 'TaskMarker') {
        ranges.push(TASK_MARK.range(node.from, node.to))
        return false
      }
      if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
        handleMarker(node.from, node.to, true)
        return false
      }
      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'Strikethrough') {
        if (insideToken(node.from, node.to)) return false
        const marks: Array<{ from: number; to: number }> = []
        for (const child of childrenOf(node.node)) {
          if (child.name === 'EmphasisMark' || child.name === 'StrikethroughMark') {
            marks.push({ from: child.from, to: child.to })
          }
        }
        const contentFrom = marks[0]?.to ?? node.from
        const contentTo = marks.length > 1 ? marks[marks.length - 1].from : node.to
        const deco =
          name === 'StrongEmphasis' ? STRONG : name === 'Emphasis' ? EMPHASIS : STRIKE
        if (contentTo > contentFrom) ranges.push(deco.range(contentFrom, contentTo))
        return true
      }
      if (name === 'InlineCode') {
        if (insideToken(node.from, node.to)) return false
        const marks: Array<{ from: number; to: number }> = []
        for (const child of childrenOf(node.node)) {
          if (child.name === 'CodeMark') marks.push({ from: child.from, to: child.to })
        }
        const from = marks[0]?.to ?? node.from
        const to = marks.length > 1 ? marks[marks.length - 1].from : node.to
        if (to > from) ranges.push(INLINE_CODE.range(from, to))
        return true
      }
      if (name === 'Link') {
        if (insideToken(node.from, node.to)) return false
        const line = doc.lineAt(node.from)
        const active = lineActive(line.from, line.to)
        const marks: Array<{ from: number; to: number }> = []
        let urlFrom: number | null = null
        let urlTo: number | null = null
        for (const child of childrenOf(node.node)) {
          if (child.name === 'LinkMark') marks.push({ from: child.from, to: child.to })
          if (child.name === 'URL' || child.name === 'LinkTitle') {
            urlFrom = child.from
            urlTo = child.to
          }
        }
        const labelFrom = marks[0]?.to ?? node.from
        const labelTo = marks.length > 1 ? marks[1].from : node.to
        if (labelTo > labelFrom) ranges.push(LINK.range(labelFrom, labelTo))
        for (const mark of marks) {
          if (active) dimMarker(mark.from, mark.to)
          else hide(mark.from, mark.to)
        }
        if (urlFrom != null && urlTo != null) {
          if (active) dimMarker(urlFrom, urlTo)
          else hide(urlFrom, urlTo)
        }
        return false
      }
      if (name === 'HorizontalRule') {
        const line = doc.lineAt(node.from)
        if (lineActive(line.from, line.to)) {
          dimMarker(line.from, line.to)
        } else {
          ranges.push(
            Decoration.replace({
              widget: new RuleWidget(line.from),
              block: true,
            }).range(line.from, line.to),
          )
        }
        return false
      }
      return undefined
    },
  })

  // 已登记的 @ 路径标记：显示名字、悬停完整路径，作为原子范围整体移动/删除。
  const visibleTokens = tokens.filter(
    (token) =>
      !inactiveBlocks.some((block) => token.from >= block.from && token.to <= block.to),
  )
  for (const token of visibleTokens) {
    ranges.push(
      Decoration.replace({
        widget: new PathWidget(token.from, token.src, token.name),
      }).range(token.from, token.to),
    )
  }

  // 收尾：被整块卡片替换的行不要再叠加行样式。
  for (const block of inactiveBlocks) {
    for (const [lineFrom] of lineInfo) {
      if (lineFrom >= block.from && lineFrom <= block.to) lineInfo.delete(lineFrom)
    }
  }
  for (const [lineFrom, info] of lineInfo) {
    if (!info.classes.size && !info.style) continue
    ranges.push(
      Decoration.line({
        class: [...info.classes].join(' '),
        attributes: info.style ? { style: info.style } : undefined,
      }).range(lineFrom),
    )
  }

  return Decoration.set(ranges, true)
}

const composingEffect = StateEffect.define<boolean>()

const composingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(composingEffect)) value = effect.value
    }
    return value
  },
})

const atomicCache = { text: '', set: RangeSet.empty as RangeSet<Decoration> }

function tokenSet(text: string): RangeSet<Decoration> {
  if (atomicCache.text === text) return atomicCache.set
  const ranges = pathTokens(text).map((token) =>
    Decoration.replace({}).range(token.from, token.to),
  )
  atomicCache.text = text
  atomicCache.set = RangeSet.of(ranges, true)
  return atomicCache.set
}

interface LiveOptions {
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
}

const decorationsField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    const composingChanged = tr.effects.some((effect) => effect.is(composingEffect))
    if (!tr.docChanged && !tr.selection && !composingChanged) return value
    if (!composingChanged && tr.state.field(composingField)) return value
    return build(tr.state)
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * 实时预览扩展。组合输入（IME）期间不重算装饰，避免打断候选窗；
 * 组合结束后补一次重算。
 */
export function markdownLive(options: LiveOptions = {}): Extension {
  return [
    MARKDOWN_SUPPORT,
    composingField,
    decorationsField,
    EditorView.domEventHandlers({
      compositionstart: (_event, view) => {
        view.dispatch({ effects: composingEffect.of(true) })
        options.onCompositionStart?.()
        return false
      },
      compositionend: (_event, view) => {
        view.dispatch({ effects: composingEffect.of(false) })
        options.onCompositionEnd?.()
        return false
      },
    }),
    EditorView.atomicRanges.of((view) => tokenSet(view.state.doc.toString())),
  ]
}

