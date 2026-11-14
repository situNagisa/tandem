/**
 * 源码路径 → 回归功能文件 的映射。
 *
 * `--changed` 取提交改动（基线见 changedFiles）与工作区改动，去掉文档/非代码文件后逐个映射；
 * 没有改动或只改了非代码文件时跳过；任一文件命中共享层（e2e/regression/lib、scripts、protocol、store 等）
 * 或没有命中映射时回落全量，宁可多跑也不漏跑。
 */
import { execFileSync } from 'node:child_process'

export const FEATURE_NAMES = [
  'conversation',
  'composer',
  'sidebar',
  'session-graph',
  'mobile',
  'settings',
  'model-accounts',
  'routing',
  'sandbox',
  'workspace',
  'board',
  'feedback',
  'workstation',
  'shell',
]

const ALL = 'all'

// 顺序即优先级：先精确到功能，再共享层，最后回落。
const RULES = [
  // 回归自身：夹具/入口/映射改动影响所有用例；单个功能文件改动只跑自己。
  [/^e2e\/regression\/([a-z-]+)\.mjs$/, (match) => (FEATURE_NAMES.includes(match[1]) ? [match[1]] : ALL)],
  [/^e2e\/regression\/lib\//, ALL],
  [/^e2e\/regression\.mjs$/, ALL],
  [/^e2e\/(workstation-check|executor-check)\.mjs$/, ['workstation']],
  [/^e2e\//, ALL],
  [/^scripts\//, ALL],
  [/^packages\/protocol\//, ALL],
  [/^packages\/[^/]+\/(package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/, ALL],
  [/^(package(-lock)?\.json|tsconfig[^/]*\.json)$/, ALL],

  // Host：工作站/执行器/登录门
  [/^packages\/server\/src\/(workstation|executor|auth|devices)\//, ['workstation']],
  [/^packages\/server\/src\/(host|host-env|doctor|executor-check)\.ts$/, ['workstation']],
  [/^packages\/web\/src\/components\/(workstation|auth)\//, ['workstation']],
  [/^packages\/mobile\//, ['mobile']],

  // 模型与路由
  [/^packages\/server\/src\/(model-routing|routing-settings|quota|handoff|budgets|usage)\.ts$/, ['routing', 'model-accounts']],
  [/^packages\/server\/src\/accounts\//, ['model-accounts']],
  [/^packages\/server\/src\/providers\//, ['model-accounts', 'composer']],
  [/^packages\/web\/src\/components\/(accounts|settings\/(ProfilesSection|ModelRoutingSection|DivisionRoutingSection|BudgetsSection))/, ['model-accounts']],
  [/^packages\/web\/src\/components\/(ProviderIcon|ThinkingBlock)\.tsx$/, ['model-accounts', 'composer']],

  // 沙箱与审批
  [/^packages\/server\/src\/(permissions|sandbox|approval|secrets|hooks)\.ts$/, ['sandbox']],
  [/^packages\/server\/src\/tools\//, ['sandbox', 'conversation']],
  [/^packages\/web\/src\/components\/(PermissionCard|PlanCard)\.tsx$/, ['sandbox']],

  // 任务看板 / Wiki / 评测 / 演示
  [/^packages\/(server\/src|web\/src\/components)\/(board|PrPanel)/, ['board']],
  [/^packages\/server\/src\/(wiki|evals|demo|preview|browser)\.ts$/, ['workspace']],
  [/^packages\/server\/src\/(search|memory|skills|prompt-templates)\.ts$/, ['sidebar', 'settings']],
  [/^packages\/web\/src\/components\/(wiki|evals|demo|split)\//, ['workspace']],
  [/^packages\/web\/src\/components\/(BrowserPanel|PreviewPanel)\.tsx$/, ['workspace']],

  // 反馈与调整工具
  [/^packages\/web\/src\/components\/(feedback|dev)\//, ['feedback']],

  // 设置
  [/^packages\/web\/src\/components\/settings\//, ['settings']],
  [/^packages\/web\/src\/components\/(MemoryEditorDialog|DoctorDialog)\.tsx$/, ['settings']],

  // 侧栏 / 列表 / 搜索 / 收件箱
  [/^packages\/web\/src\/components\/(Sidebar|SessionList|SearchDialog)\.tsx$/, ['sidebar']],
  [/^packages\/web\/src\/components\/(inbox|session)\//, ['sidebar', 'session-graph']],
  [/^packages\/server\/src\/(inbox|share)\.ts$/, ['sidebar']],

  // 会话图 / 会话信息
  [/^packages\/web\/src\/components\/(sessionGraph|right-panel)\//, ['session-graph']],

  // 会话与消息
  [/^packages\/server\/src\/(agent\/(loop|prompt|resume|retry|timing|commands)|external|context|context-settings|checkpoints|changes|vcs|worktree|tasks|redact|search)\.ts$/, ['conversation']],
  [/^packages\/server\/src\/(routes|server|events|store|config|types|util)\b/, ALL],
  [/^packages\/web\/src\/components\/(chat|toolcard)\//, ['conversation']],
  [/^packages\/web\/src\/components\/(ChatView|MessageList|Markdown|CodeBlock|ToolCard|ExternalSessionPanel|ExternalSessionView|FilePreviewPanel|ChangeReviewPanel|DiffView|RewindDialog|StatusDot)\.tsx$/, ['conversation']],

  // 输入框与环境条
  [/^packages\/web\/src\/components\/(Composer|EnvBar|FileBrowser|NewSessionDialog)\.tsx$/, ['composer']],
  [/^packages\/web\/src\/components\/composer\//, ['composer']],

  // 应用外壳
  [/^packages\/web\/src\/components\/(TopBar|AppContextMenu|Welcome|BrandMark)\.tsx$/, ['shell']],
  [/^packages\/web\/src\/components\/tour\//, ['shell']],

  // 共享层：改了就走全量。
  [/^packages\/web\/src\/(store|lib|styles)\//, ALL],
  [/^packages\/web\/src\/(App|main)\.tsx$/, ALL],
  [/^packages\/web\/src\/components\/ui\//, ALL],
  [/^packages\/web\/src\/index\.css$/, ALL],
]

/** 返回命中的功能名数组、'all'，或 null（未命中）。 */
export function featuresForFile(file) {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const [pattern, target] of RULES) {
    const match = normalized.match(pattern)
    if (!match) continue
    return typeof target === 'function' ? target(match) : target
  }
  return null
}

// 不影响运行结果的文件：文档、产品定义、代理工具目录（.claude/ 下是 worktree 元数据）。
const NON_CODE = [/^docs\//, /^product\//, /\.md$/i, /^\.claude\//]

const isNonCode = (file) => NON_CODE.some((pattern) => pattern.test(file))

/**
 * 一批改动文件 → { skip: true, reason }、{ all: true, reason } 或 { features: [...] }。
 * skip：没有改动，或改动全是非代码文件；all：命中共享层或未命中映射。
 */
export function selectFeatures(files) {
  const normalized = files.map((file) => file.replace(/\\/g, '/').replace(/^\.\//, ''))
  if (!normalized.length) return { skip: true, reason: '无改动' }
  const code = normalized.filter((file) => !isNonCode(file))
  if (!code.length) return { skip: true, reason: '只改文档' }
  const selected = new Set()
  const unmapped = []
  for (const file of code) {
    const hit = featuresForFile(file)
    if (hit === ALL) return { all: true, reason: `${file} 属于共享层` }
    if (!hit) {
      unmapped.push(file)
      continue
    }
    for (const feature of hit) selected.add(feature)
  }
  if (unmapped.length) {
    return { all: true, reason: `未命中映射：${unmapped.slice(0, 3).join('、')}${unmapped.length > 3 ? ' 等' : ''}` }
  }
  return { all: false, features: FEATURE_NAMES.filter((name) => selected.has(name)) }
}

/**
 * 提交改动 + 工作区（含未跟踪）改动。
 *
 * 基线：
 * - 指定 base（--changed-base 验收/调试）：`base...HEAD`，传 HEAD 即只看工作区。
 * - 未指定、当前在 main 上（main 与 HEAD 同一提交）：HEAD 相对最近一次合并提交（不含 HEAD 自身）；
 *   没有合并提交时用 HEAD~1。不依赖 origin，离线也可用。
 * - 其他分支：`main...HEAD`。
 */
export function changedFiles(root, base = null) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    } catch {
      return ''
    }
  }
  const files = new Set()
  let range = base ? `${base}...HEAD` : 'main...HEAD'
  if (!base && git(['rev-parse', 'HEAD']).trim() === git(['rev-parse', 'main']).trim()) {
    range = `${git(['rev-list', '--merges', '-n', '1', 'HEAD~1']).trim() || 'HEAD~1'}..HEAD`
  }
  for (const line of git(['diff', '--name-only', range]).split('\n')) {
    const file = line.trim()
    if (file) files.add(file)
  }
  for (const line of git(['status', '--porcelain', '--', '.', ':!.claude']).split('\n')) {
    if (!line.trim()) continue
    const rest = line.slice(3).trim()
    // 重命名显示为 "old -> new"，取新路径。
    files.add(rest.includes(' -> ') ? rest.split(' -> ').pop() : rest)
  }
  return [...files]
}
