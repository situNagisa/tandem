import type { PreviewSelection } from '@tandem/protocol'

/** 附件胶囊上的短标签：<button> 登录。 */
export function selectionLabel(selection: PreviewSelection): string {
  const name = selection.name || selection.text || selection.tag
  return `<${selection.tag}> ${name}`.trim()
}

/** 胶囊上的源码位置：src/components/Login.tsx:42。 */
export function selectionSource(selection: PreviewSelection): string | undefined {
  const component = selection.component
  if (!component) return undefined
  if (component.file) {
    return `${component.file}${component.line ? `:${component.line}` : ''}`
  }
  return component.name
}

/**
 * 发送给 agent 的上下文行。示例：
 * 关于这个元素：<button> 登录，LoginForm（src/components/Login.tsx:42），选择器 #login
 */
export function selectionContext(selection: PreviewSelection): string {
  const name = selection.name || selection.text || selection.tag
  const component = selection.component
  const source = component
    ? component.file
      ? `${component.name}（${component.file}${component.line ? `:${component.line}` : ''}）`
      : component.name
    : ''
  const parts = [`<${selection.tag}> ${name}`]
  if (source) parts.push(source)
  let text = `关于这个元素：${parts.join('，')}`
  if (selection.selector) text += `，选择器 ${selection.selector}`
  return text
}

export function selectionContextText(selections: PreviewSelection[]): string {
  return selections.map(selectionContext).join('\n')
}
