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
    keywords: ['裁切', '被遮', '遮住', '越界', '挡', '出界', '看不到', '截断', '溢出'],
    components: ['Tooltip', 'Popover', 'Menu', 'Modal'],
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
