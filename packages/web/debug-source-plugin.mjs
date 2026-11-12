/**
 * 调试版构建专用：给 JSX 里的原生 DOM 元素注入 `data-tandem-src="packages/web/src/…:行号"`。
 *
 * React 19 的生产运行时没有 `_debugSource`，调试构建也不启用开发运行时；
 * 因此在编译阶段标记源码位置，调整工具选中元素时读最近的 `data-tandem-src` 给出 file:line。
 * 发布版不加载本插件（`flavor !== 'debug'` 时 transform 直接返回），产物里也不应出现该属性。
 */
import path from 'node:path'
import { parseSync } from 'rolldown/utils'

export function debugSourcePlugin({ root, flavor }) {
  return {
    name: 'tandem-debug-source',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (flavor !== 'debug') return null
      const file = id.split('?')[0]
      if (!file || !/\.(tsx|jsx)$/.test(file) || file.includes('node_modules')) return null
      const relative = path.relative(root, file).split(path.sep).join('/')
      if (!relative.startsWith('packages/web/src/')) return null
      if (code.length > 2_000_000) return null
      let program
      try {
        program = parseSync(file, code, { lang: 'tsx', range: true, sourceType: 'module' }).program
      } catch {
        return null
      }
      const edits = []
      const visit = (node) => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) {
          for (const child of node) visit(child)
          return
        }
        if (node.type === 'JSXOpeningElement') {
          const name = node.name
          if (
            name &&
            name.type === 'JSXIdentifier' &&
            /^[a-z]/.test(name.name) &&
            typeof name.end === 'number'
          ) {
            const marked = (node.attributes ?? []).some(
              (attr) => attr?.type === 'JSXAttribute' && attr.name?.name === 'data-tandem-src',
            )
            if (!marked) {
              const line = code.slice(0, name.start).split('\n').length
              edits.push({ at: name.end, text: ` data-tandem-src="${relative}:${line}"` })
            }
          }
        }
        for (const key of Object.keys(node)) {
          if (key === 'parent' || key === 'range') continue
          const value = node[key]
          if (value && typeof value === 'object') visit(value)
        }
      }
      visit(program)
      if (edits.length === 0) return null
      edits.sort((a, b) => b.at - a.at)
      let output = code
      for (const edit of edits) {
        output = output.slice(0, edit.at) + edit.text + output.slice(edit.at)
      }
      return { code: output, map: null }
    },
  }
}
