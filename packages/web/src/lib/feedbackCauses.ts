/** 根因台账的匹配规则（台账格式见 docs/feedback-ledger.md，不在本文件修改台账）。 */
export interface feedbackCauseRule {
  id: string
  title: string
  /** 命中反馈文字/可见文本的关键词；中文按包含匹配。 */
  keywords: string[]
  /** React 组件名（精确或前缀匹配）。 */
  components?: string[]
  /** 选择器包含的片段。 */
  selectors?: string[]
  /** 只在该元素确实像浮层（弹层/下拉/菜单/对话框）时才命中，避免把正文截断误判为 R03。 */
  overlayOnly?: boolean
  /** 权重加成；同类规则冲突时取分数高者。 */
  weight?: number
}

export const FEEDBACK_CAUSE_RULES: feedbackCauseRule[] = [
  {
    id: 'R01',
    title: '列表/菜单/下拉各处手写，样式不一致',
    keywords: ['不紧凑', '太大', '太小', '样式不一致', '没法复用', '下拉', '列表', '菜单'],
    components: ['Menu', 'MenuItem', 'Dropdown', 'Select', 'ListRow', 'SegmentedControl'],
    weight: 1,
  },
  {
    id: 'R02',
    title: '文字偏灰、字号过小、对比度不足',
    keywords: ['灰', '看不清', '字太小', '字号', '对比度', '太淡', '偏淡', '昏暗', '颜色浅'],
    weight: 4,
  },
  {
    id: 'R03',
    title: '弹层被裁切或越界',
    // 不再用「截断/看不到」这类宽泛词：正文省略号属于 R15，面板空白属于 R14。
    keywords: ['被遮', '遮挡', '越界', '出界', '裁切', '挡住', '溢出', 'tip 被截'],
    components: ['Tooltip', 'Popover', 'Menu', 'Modal'],
    selectors: ['radix-', 'role="menu"', 'role="dialog"', 'popover-panel', 'modal-panel', 'data-portal-layer'], // ui-audit-ignore：根因匹配数据，不是 UI 实现
    overlayOnly: true,
    weight: 3,
  },
  {
    id: 'R04',
    title: '彩色过多、强调色越界',
    keywords: ['花花绿绿', '太橙', '橙色太多', '颜色太多', '红绿', '廉价', '太鲜艳', '饱和'],
    weight: 4,
  },
  {
    id: 'R05',
    title: '重复入口',
    keywords: ['重复入口', '好几个', '入口重复', '顶栏太挤', '找不到入口', '两个按钮'],
    weight: 3,
  },
  {
    id: 'R06',
    title: 'Windows 路径与编码',
    keywords: ['路径', '盘符', '反斜杠', '乱码', '编码', 'gbk', 'diff 没', '没有差异', '文件链接'],
    weight: 4,
  },
  {
    id: 'R07',
    title: '外部会话注入内容外露',
    keywords: ['agents.md', 'skills_instructions', '注入', 'instructions', '外部会话标题'],
    weight: 4,
  },
  {
    id: 'R08',
    title: '点了没反应 / 状态未就绪',
    keywords: ['没反应', '点了没', '点击无效', '无响应', '加载中', '未知', '显示关', '白屏'],
    weight: 5,
  },
  {
    id: 'R09',
    title: '反馈模式与浮层交互冲突',
    keywords: ['反馈模式', '选中就消失', '点一下 ui 就', '浮层消失', '标注时'],
    components: ['FeedbackMode', 'FeedbackEditor', 'FeedbackAnnotator', 'FeedbackDrawer'],
    weight: 5,
  },
  {
    id: 'R10',
    title: '提示/动效不符合习惯',
    keywords: ['tooltip', 'tip 不', '动画', '跳动', '晃眼', '过渡', '提示不', '闪'],
    weight: 3,
  },
  {
    id: 'R14',
    title: '面板与对话区争抢空间/焦点',
    keywords: [
      '面板',
      '空白',
      '改动审阅',
      '预览遮',
      '遮住输入框',
      '布局',
      '空间',
      '贴顶',
      'diff 从',
      '横向滚动',
    ],
    components: ['ChangeReviewPanel', 'PreviewPanel', 'FilePreviewPanel', 'RightPanel', 'BrowserPanel', 'WikiDialog'],
    weight: 4,
  },
  {
    id: 'R15',
    title: '关键文本截断且无全文入口',
    keywords: ['截断', 'tooltip', '全文', '省略号', '读屏', '大纲', '任务描述', '显示不全', '悬停看'],
    components: ['TurnRail', 'TurnOutlineSheet', 'PermissionCard', 'InboxView', 'BoardCardItem'],
    selectors: ['turn-item', 'turn-rail', 'line-clamp', 'truncate'],
    weight: 5,
  },
]

export interface CauseMatchInput {
  text?: string
  textSnippet?: string
  component?: string
  selector?: string
}

/** 按数据文件里的规则打分，返回最可能的根因；没有命中返回 undefined。 */
export function suggestCause(input: CauseMatchInput): feedbackCauseRule | undefined {
  const text = `${input.text ?? ''}\n${input.textSnippet ?? ''}`.toLowerCase()
  const component = input.component ?? ''
  const selector = input.selector ?? ''
  let best: { rule: feedbackCauseRule; score: number } | undefined
  for (const rule of FEEDBACK_CAUSE_RULES) {
    if (rule.overlayOnly) {
      // 必须同时有「裁切/越界」文字证据，避免只因为元素在 Radix 菜单里就给 R03。
      if (!rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) continue
      const overlayText = /(弹层|浮层|下拉|菜单|弹窗|对话框|提示框|tooltip|\btip\b)/i.test(text)
      const overlaySelector = /radix-|role="(?:menu|dialog|listbox|tooltip)"|popover-panel|modal-panel|data-portal-layer/i.test(selector) // ui-audit-ignore：根因匹配规则
      const overlayComponent = (rule.components ?? []).some(
        (name) => component === name || component.startsWith(name),
      )
      // 只有元素/文字确实指向浮层时才建议 R03，正文截断与面板布局交给 R15/R14。
      if (!overlayText && !overlaySelector && !overlayComponent) continue
    }
    let score = 0
    for (const keyword of rule.keywords) {
      if (keyword && text.includes(keyword.toLowerCase())) score += 2
    }
    const components = rule.components ?? []
    if (components.some((name) => component === name || component.startsWith(name))) score += 2
    const selectors = rule.selectors ?? []
    if (selectors.some((part) => part && selector.includes(part))) score += 2
    if (score === 0) continue
    score += rule.weight ?? 0
    if (!best || score > best.score) best = { rule, score }
  }
  return best?.rule
}
