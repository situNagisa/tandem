import type { HLJSApi } from 'highlight.js'

let loader: Promise<HLJSApi> | null = null

/**
 * highlight.js 体积较大，拆成独立 chunk 按需加载；
 * 只注册 agent 输出里常见的十几种语言。
 */
export function loadHighlighter(): Promise<HLJSApi> {
  if (!loader) {
    loader = (async () => {
      const [
        core,
        bash,
        css,
        diff,
        go,
        javascript,
        json,
        markdown,
        python,
        rust,
        sql,
        typescript,
        xml,
        yaml,
      ] = await Promise.all([
        import('highlight.js/lib/core'),
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/diff'),
        import('highlight.js/lib/languages/go'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/markdown'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/rust'),
        import('highlight.js/lib/languages/sql'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/yaml'),
      ])
      const hljs = core.default
      hljs.registerLanguage('bash', bash.default)
      hljs.registerLanguage('css', css.default)
      hljs.registerLanguage('diff', diff.default)
      hljs.registerLanguage('go', go.default)
      hljs.registerLanguage('javascript', javascript.default)
      hljs.registerLanguage('json', json.default)
      hljs.registerLanguage('markdown', markdown.default)
      hljs.registerLanguage('python', python.default)
      hljs.registerLanguage('rust', rust.default)
      hljs.registerLanguage('sql', sql.default)
      hljs.registerLanguage('typescript', typescript.default)
      hljs.registerLanguage('xml', xml.default)
      hljs.registerLanguage('yaml', yaml.default)

      hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
      hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
      hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
      hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' })
      hljs.registerAliases(['md'], { languageName: 'markdown' })
      hljs.registerAliases(['yml'], { languageName: 'yaml' })
      hljs.registerAliases(['py'], { languageName: 'python' })
      hljs.registerAliases(['rs'], { languageName: 'rust' })
      hljs.registerAliases(['patch'], { languageName: 'diff' })
      return hljs
    })()
  }
  return loader
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'bash',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  html: 'xml',
  vue: 'xml',
  svg: 'xml',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  diff: 'diff',
  patch: 'diff',
}

export function languageFromPath(path?: string): string | undefined {
  if (!path) return undefined
  const name = path.split(/[\\/]/).pop() ?? ''
  const idx = name.lastIndexOf('.')
  if (idx < 0) return undefined
  return EXT_LANGUAGE[name.slice(idx + 1).toLowerCase()]
}

const DISPLAY: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  bash: 'Bash',
  python: 'Python',
  diff: 'Diff',
  css: 'CSS',
  xml: 'HTML/XML',
  markdown: 'Markdown',
  yaml: 'YAML',
  sql: 'SQL',
  go: 'Go',
  rust: 'Rust',
}

export function languageLabel(language?: string): string {
  if (!language) return '文本'
  return DISPLAY[language] ?? language
}
