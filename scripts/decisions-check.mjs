#!/usr/bin/env node
/**
 * 用户决定落实检查（反馈16#07 的防线）。
 *
 * design.md 末尾每条用户结论都对应这里的一项检查：先确认结论仍在 design.md，
 * 再确认代码里确实按这条结论实现。用户说过「我之前说过……但你还没有改」时，
 * 说明只靠记忆/自觉不够，必须让决定在提交前被脚本拦一次。
 *
 * 用法：node scripts/decisions-check.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')

const design = read('docs/design.md')
const sources = {
  shared: read('packages/web/src/components/right-panel/shared.tsx'),
  rightPanel: read('packages/web/src/components/RightPanel.tsx'),
  externalPanel: read('packages/web/src/components/ExternalSessionPanel.tsx'),
  contextCard: read('packages/web/src/components/right-panel/ContextCard.tsx'),
  contextMeter: read('packages/web/src/components/chat/ContextMeter.tsx'),
  popover: read('packages/web/src/components/ui/Popover.tsx'),
  graphView: read('packages/web/src/components/sessionGraph/SessionGraphView.tsx'),
  graphCard: read('packages/web/src/components/sessionGraph/SessionGraphCard.tsx'),
  graphLayout: read('packages/web/src/components/sessionGraph/layout.ts'),
  protocol: read('packages/protocol/src/index.ts'),
  external: read('packages/server/src/external.ts'),
  contextServer: read('packages/server/src/context.ts'),
}

/** 每条决定：design.md 里必须有的原话/关键词 + 代码里必须存在的实现。 */
const DECISIONS = [
  {
    id: 'RP-01',
    decision: '会话信息面板可拖宽',
    design: ['会话信息面板可拖宽', '280–600px'],
    source: ['rightPanel', 'shared'],
    need: [/ResizeHandle/, /PANEL_WIDTH_MIN = 280/, /PANEL_WIDTH_MAX = 600/, /savePanelWidth/],
  },
  {
    id: 'RP-02',
    decision: '会话信息分组都可收起并记住',
    design: ['会话信息分组都可收起', '折叠状态跨会话记住'],
    source: ['shared', 'rightPanel'],
    need: [/data-card-toggle/, /loadCollapsedGroups/, /saveCollapsedGroups/],
  },
  {
    id: 'RP-03',
    decision: '会话信息面板不要顶栏框',
    design: ['会话信息面板不要顶栏框'],
    source: ['rightPanel'],
    deny: [/title="会话信息"/, /关闭信息面板/],
  },
  {
    id: 'RP-04',
    decision: '上下文卡参考 Claude Code /context 的分类、阈值与最占空间',
    design: ['上下文卡参考 Claude Code', '缓存命中率'],
    source: ['contextCard'],
    need: [/CONTEXT_PART_ORDER/, /data-context-threshold/, /ContextSpaceSection/],
  },
  {
    id: 'RP-05',
    decision: '「最占空间」按轮次聚合、可折叠',
    design: ['「最占空间」按轮次聚合、可折叠'],
    source: ['contextMeter'],
    need: [/data-context-top-toggle/, /tandem\.contextTopCollapsed\.v1/, /data-context-turn/],
  },
  {
    id: 'RP-06',
    decision: '反馈16#06 面板与卡片宽度只由拖拽决定',
    design: ['面板与卡片宽度只由拖拽决定'],
    source: ['shared', 'rightPanel', 'externalPanel', 'popover', 'contextMeter'],
    need: [
      /group\/card w-full min-w-0/,
      /scrollbarGutter: 'stable'/,
      /panelWidth/,
      /panelWidth="min\(92vw, 352px\)"/,
    ],
  },
  {
    id: 'RP-07',
    decision: '反馈16#07 折叠箭头放在标题文字右边、常显',
    design: ['折叠箭头放在标题文字右边'],
    source: ['shared'],
    need: [/data-card-toggle=\{id\}[\s\S]*?\{head\}[\s\S]*?<ChevronRight/],
  },
  {
    id: 'RP-08',
    decision: '反馈16#08 拖动手柄放到标题行右边',
    design: ['拖动手柄放到标题行右边'],
    source: ['shared'],
    need: [/\{!collapsed && right \?[\s\S]*?aria-label=\{`拖动排序/],
  },
  {
    id: 'RP-09',
    decision: '反馈16#03 会话图不再显示图例',
    design: ['会话图不再显示图例'],
    source: ['graphView'],
    deny: [/data-graph-legend/],
  },
  {
    id: 'RP-10',
    decision: '反馈16#09 会话图高度自适应并有上下限',
    design: ['会话图高度自适应'],
    source: ['graphLayout', 'graphCard'],
    need: [/GRAPH_CARD_MIN_ROWS = 3/, /GRAPH_CARD_MAX_ROWS = 12/, /GRAPH_CARD_MAX_HEIGHT = 360/, /graphCardHeight\(layout\.rows\)/, /height=\{height \?\? graphCardHeight\(layout\.rows\)\}/],
  },
  {
    id: 'RP-11',
    decision: '反馈16#05 外部会话注入的系统提示不算用户轮',
    design: ['外部会话注入的系统提示不算用户轮'],
    source: ['protocol', 'external', 'contextServer'],
    need: [
      /isSystemInjectionText/,
      /isSystemInjectionText\(block\.text\)[\s\S]*?continue/,
      /type: 'context', kind: '系统提示'/,
    ],
  },
  {
    id: 'RP-12',
    decision: '反馈16#04 上下文卡不再重复缓存命中率',
    design: ['上下文卡不再重复缓存命中率'],
    source: ['contextCard'],
    deny: [/缓存命中率/, /data-context-cache/],
  },
  {
    id: 'RP-13',
    decision: '反馈16#05「最占空间」行首不再显示轮次数字',
    design: ['「最占空间」行首不再显示轮次数字'],
    source: ['contextMeter'],
    need: [/data-turn-number=\{turn\.turn\}/],
    deny: [/<span className="w-4 shrink-0 text-right text-muted tabular-nums">/],
  },
  {
    id: 'RP-14',
    decision: '会话信息面板不再放「删除会话」',
    design: ['会话信息面板不再放「删除会话」'],
    source: ['rightPanel'],
    deny: [/删除会话/],
  },
]

let failed = 0
for (const item of DECISIONS) {
  const problems = []
  for (const phrase of item.design) {
    if (!design.includes(phrase)) problems.push(`design.md 缺少用户结论「${phrase}」`)
  }
  const texts = item.source.map((key) => sources[key]).join('\n')
  for (const re of item.need ?? []) {
    if (!re.test(texts)) problems.push(`代码未落实：${re}`)
  }
  for (const re of item.deny ?? []) {
    if (re.test(texts)) problems.push(`代码回退：仍存在 ${re}`)
  }
  if (problems.length > 0) {
    failed += 1
    console.log(`✗ ${item.id} ${item.decision}`)
    for (const problem of problems) console.log(`    ${problem}`)
  } else {
    console.log(`✓ ${item.id} ${item.decision}`)
  }
}

if (failed > 0) {
  console.log(`\ndecisions-check: ${failed} 条用户决定没有落实（先改代码，或更新 design.md 并同步本脚本）。`)
  process.exitCode = 1
} else {
  console.log('\ndecisions-check: 右侧面板相关用户决定均已落实。')
}
