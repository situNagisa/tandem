#!/usr/bin/env node
/**
 * 用户决定落实检查。
 *
 * design.md 只写原则；用户定过的单点行为登记在这里（来源写在每条 source 注释里），
 * 用源码断言确认没有回退。用户说「我之前说过……但你还没有改」时，说明只靠记忆不够，
 * 必须让决定在提交前被脚本拦一次。
 *
 * 用法：node scripts/decisions-check.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const UI_DIR = 'packages/web/src/components/ui'
const UI_FILES = readdirSync(path.join(ROOT, UI_DIR))
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => `${UI_DIR}/${name}`)
const read = (file) => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8')
  } catch {
    return ''
  }
}

const F = {
  shared: 'packages/web/src/components/right-panel/shared.tsx',
  rightPanel: 'packages/web/src/components/RightPanel.tsx',
  externalPanel: 'packages/web/src/components/ExternalSessionPanel.tsx',
  contextCard: 'packages/web/src/components/right-panel/ContextCard.tsx',
  contextMeter: 'packages/web/src/components/chat/ContextMeter.tsx',
  usageLine: 'packages/web/src/components/chat/UsageLine.tsx',
  userMessage: 'packages/web/src/components/chat/UserMessage.tsx',
  assistantMessage: 'packages/web/src/components/chat/AssistantMessage.tsx',
  turnActivity: 'packages/web/src/components/chat/TurnActivity.tsx',
  messageList: 'packages/web/src/components/MessageList.tsx',
  chatView: 'packages/web/src/components/ChatView.tsx',
  composer: 'packages/web/src/components/Composer.tsx',
  composerSend: 'packages/web/src/components/composer/useComposerSend.ts',
  composerFooter: 'packages/web/src/components/composer/ComposerFooter.tsx',
  composerEditor: 'packages/web/src/components/composer/ComposerEditor.tsx',
  modelMenu: 'packages/web/src/components/composer/ModelMenu.tsx',
  diffView: 'packages/web/src/components/DiffView.tsx',
  permissionCard: 'packages/web/src/components/PermissionCard.tsx',
  sessionList: 'packages/web/src/components/SessionList.tsx',
  sessionRow: 'packages/web/src/components/session/SessionRow.tsx',
  sessionGroups: 'packages/web/src/components/session/SessionGroups.tsx',
  sidebar: 'packages/web/src/components/Sidebar.tsx',
  app: 'packages/web/src/App.tsx',
  envBar: 'packages/web/src/components/EnvBar.tsx',
  topBar: 'packages/web/src/components/TopBar.tsx',
  panelMenu: 'packages/web/src/components/right-panel/PanelMenu.tsx',
  newSession: 'packages/web/src/components/NewSessionDialog.tsx',
  newSessionPick: 'packages/web/src/lib/newSessionPick.ts',
  settingsDialog: 'packages/web/src/components/settings/SettingsDialog.tsx',
  settingsRegistry: 'packages/web/src/lib/settingsRegistry.ts',
  menu: 'packages/web/src/components/ui/Menu.tsx',
  popover: 'packages/web/src/components/ui/Popover.tsx',
  modelCascade: 'packages/web/src/components/ui/ModelCascade.tsx',
  overlay: 'packages/web/src/components/ui/OverlayScrollbar.tsx',
  settingRow: 'packages/web/src/components/ui/SettingRow.tsx',
  button: 'packages/web/src/components/ui/Button.tsx',
  card: 'packages/web/src/components/ui/Card.tsx',
  emptyState: 'packages/web/src/components/ui/EmptyState.tsx',
  graphView: 'packages/web/src/components/sessionGraph/SessionGraphView.tsx',
  graphCard: 'packages/web/src/components/sessionGraph/SessionGraphCard.tsx',
  graphLayout: 'packages/web/src/components/sessionGraph/layout.ts',
  protocol: 'packages/protocol/src/index.ts',
  external: 'packages/server/src/external.ts',
  contextServer: 'packages/server/src/context.ts',
  modelSelection: 'packages/web/src/lib/modelSelection.ts',
  recentModels: 'packages/web/src/lib/recentModels.ts',
  routeLabels: 'packages/web/src/lib/routeLabels.ts',
  chatCss: 'packages/web/src/styles/chat.css',
  indexCss: 'packages/web/src/index.css',
  capabilities: 'packages/server/src/providers/capabilities.ts',
  serverConfig: 'packages/server/src/config.ts',
  serverMessages: 'packages/web/src/store/appStore/serverMessages.ts',
  messagesSlice: 'packages/web/src/store/appStore/messagesSlice.ts',
}

/** 每条决定：source = 用户原话/反馈编号；files = 需要检查的文件；need/deny 是源码断言。 */
const DECISIONS = [
  // 右侧面板（反馈16 / 12 / 11 / 6）
  {
    id: 'panel-resize',
    source: '反馈6#03，反馈16#06',
    decision: '会话信息面板可拖宽 280–600px、记住、双击复位',
    files: [F.rightPanel, F.shared, F.app],
    need: [/ResizeHandle/, /PANEL_WIDTH_MIN = 280/, /PANEL_WIDTH_MAX = 600/, /savePanelWidth/],
  },
  {
    id: 'panel-cards-collapse',
    source: '反馈12#07',
    decision: '会话信息分组都可收起，收起显示关键信息并跨会话记住',
    files: [F.shared, F.rightPanel],
    need: [/data-card-toggle/, /loadCollapsedGroups/, /saveCollapsedGroups/],
  },
  {
    id: 'panel-no-titlebar',
    source: '反馈12#06',
    decision: '会话信息面板没有标题框与关闭按钮',
    files: [F.rightPanel],
    deny: [/title="会话信息"/, /关闭信息面板/],
  },
  {
    id: 'panel-no-delete-session',
    source: '反馈11#02',
    decision: '会话信息面板不放「删除会话」，只留侧栏入口',
    files: [F.rightPanel],
    deny: [/删除会话/],
  },
  {
    id: 'panel-width-content-independent',
    source: '反馈16#06',
    decision: '面板/卡片宽度只由拖拽决定，展开折叠只改高度',
    files: [F.shared, F.rightPanel, F.externalPanel, F.popover, F.contextMeter],
    need: [/group\/card w-full min-w-0/, /scrollbarGutter: 'stable'/, /panelWidth/, /panelWidth="min\(92vw, 352px\)"/],
    deny: [/\bw-fit\b/, /\bw-max\b/, /\bmax-content\b/],
  },
  {
    id: 'card-toggle-right',
    source: '反馈16#07',
    decision: '折叠箭头在标题文字右边且常显，点标题行仍可折叠',
    files: [F.shared],
    need: [/data-card-toggle=\{id\}[\s\S]*?\{head\}[\s\S]*?<ChevronRight/],
  },
  {
    id: 'card-drag-handle-right',
    source: '反馈16#08',
    decision: '拖动手柄在标题行右边、操作按钮与箭头之后、常显',
    files: [F.shared],
    need: [/\{!collapsed && right \?[\s\S]*?aria-label=\{`拖动排序/],
  },
  {
    id: 'context-no-cache-duplicate',
    source: '反馈16#04',
    decision: '上下文卡不显示缓存命中率（用量卡已有）',
    files: [F.contextCard],
    deny: [/缓存命中率/],
  },
  {
    id: 'context-top-no-turn-number',
    source: '反馈16#05',
    decision: '「最占空间」行首不显示轮次数字，轮次只在 tooltip',
    files: [F.contextMeter],
    need: [/data-turn-number=\{turn\.turn\}/],
  },
  {
    id: 'context-top-collapsible',
    source: '反馈8#10',
    decision: '「最占空间」按轮次聚合、可折叠并记住状态',
    files: [F.contextMeter],
    need: [/data-context-top-toggle/, /tandem\.contextTopCollapsed\.v1/, /data-context-turn/],
  },
  {
    id: 'context-card-structure',
    source: '反馈13#05',
    decision: '上下文卡分类顺序、阈值刻度与最占空间',
    files: [F.contextCard],
    need: [/CONTEXT_PART_ORDER/, /data-context-threshold/, /ContextSpaceSection/],
  },
  {
    id: 'empty-groups-hidden',
    source: '反馈9#06，反馈10#03',
    decision: '空分组默认隐藏，⋯ 菜单逐个勾选并记住',
    files: [F.rightPanel, F.shared],
    need: [/PanelPrefs/, /shown/, /hidden/],
  },
  // 会话图（反馈16 / 会话图决定）
  {
    id: 'graph-height',
    source: '反馈16#09',
    decision: '会话图最小 3 行、最大 12 行 / 336px，超出内部滚动',
    files: [F.graphLayout, F.graphCard],
    need: [/GRAPH_CARD_MIN_ROWS = 3/, /GRAPH_CARD_MAX_ROWS = 12/, /GRAPH_CARD_MAX_HEIGHT = 360/, /graphCardHeight\(layout\.rows\)/],
  },
  {
    id: 'graph-uniform-node',
    source: '2026-11-09 用户决定：会话图配色与节点形状',
    decision: '所有节点统一 8px 实心圆',
    files: [F.graphView],
    need: [/data-marker="circle"/, /size-\[8px\]/, /rounded-full/],
  },
  {
    id: 'graph-lane-colors',
    source: '2026-11-09 用户决定：会话图配色',
    decision: '泳道色变量 --graph-lane-0..7，子代理合并线 data-merge，分叉不合并',
    files: [F.graphView, F.indexCss],
    need: [/--graph-lane-/, /data-merge/, /分叉/],
  },
  // 消息区（反馈16#01 / #02 / #10 / #11）
  {
    id: 'message-usage-hover',
    source: '反馈16#01（原话「这个文字的显示要移上去才显示」）',
    decision: '消息下方时间/用量行默认隐藏，悬停消息才显示；行高保留；触屏常显',
    files: [F.chatCss, F.usageLine],
    need: [
      /\.msg-meta \{\s*opacity: 0;/,
      /\.msg-group:hover \.msg-meta/,
      /@media \(hover: none\) \{\s*\.msg-meta \{\s*opacity: 1;/,
      /data-msg-meta-line/,
      /data-msg-time/,
    ],
  },
  {
    id: 'message-wide-reading-width',
    source: '反馈16#02（原话「我让你对齐的是其他文字的宽度，你直接铺满了整个页面」）',
    decision: '代码块/表格/长 diff 宽度 = 正文阅读列，超出块内滚动，禁止负外边距扩张',
    files: [F.chatCss, F.chatView],
    need: [
      /\.md\.chat-md \.md-table-wrap,[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;/,
      /\.md\.chat-md \.md-table-scroll \{\s*overflow-x: auto;/,
      /max-w-\[808px\]/,
    ],
  },
  {
    id: 'message-running-indicator',
    source: '反馈16#10',
    decision: '等首个 token / 等工具返回时显示进度与计时，工具行显示 spinner/已运行时长',
    files: [F.turnActivity, F.messageList, F.chatCss],
    need: [/data-turn-activity/, /正在思考/, /正在运行/, /runningSince/, /<Spinner\b/],
  },
  {
    id: 'message-queued-replace',
    source: '反馈16#11',
    decision: '排队气泡原位显示，被 agent 读取后按内容原位替换，不消失/不跑到末尾',
    files: [F.serverMessages, F.messagesSlice, F.userMessage],
    need: [/sameLocalContent/, /locals\.length === 1/, /queued: wasRunning/, /已排队，当前回合结束后发送/],
  },
  {
    id: 'message-actions-below',
    source: 'scorecard-v8 #02',
    decision: '消息操作条在消息下方，assistant 也有',
    files: [F.assistantMessage, F.chatCss],
    need: [/data-msg-meta/, /msg-actions/],
  },
  // 审批（反馈14#07，取代 12#09）
  {
    id: 'approval-inline',
    source: '反馈14#07',
    decision: '审批是对话流里的一条消息，不停靠输入框上方',
    files: [F.messageList, F.chatView],
    need: [/PermissionCard/, /permissionRows/, /toolUseId/],
  },
  {
    id: 'approval-claude-style',
    source: '反馈14#07',
    decision: '审批卡问句 + 灰色说明 + 拒绝/允许一次 + 更多，中性色无编号列表',
    files: [F.permissionCard],
    need: [/允许一次/, /拒绝/, /Ctrl/, /添加为规则/, /本会话总是允许/],
    deny: [/radiogroup/, /role="radio"/],
  },
  {
    id: 'approval-shortcuts',
    source: '反馈12#09，反馈14#07',
    decision: 'Ctrl/Cmd+Enter 允许一次、Esc 拒绝；发送消息 = 拒绝并说明',
    files: [F.permissionCard, F.composer, F.composerSend],
    need: [/Control|metaKey/, /Escape/, /decide\(request\.id, 'deny'/],
  },
  // 菜单 / 弹层（反馈5 / 7 / 10 / 12 / 14）
  {
    id: 'menu-single-line',
    source: '反馈5#15/#16',
    decision: '菜单项只显示单行标题，说明走 tooltip',
    files: [F.menu],
    need: [/h-\[26px\]/, /leading-\[1\.45\]/, /truncate/],
    deny: [/\bflex-col\b[\s\S]*?Menu\.Item/],
  },
  {
    id: 'menu-max-width',
    source: '反馈5#10',
    decision: '菜单宽度按内容自适应，上限 420px，超长才截断',
    files: [F.menu],
    need: [/max-w-\[min\(420px/, /overflow/],
  },
  {
    id: 'menu-footer-fixed',
    source: '反馈5#17',
    decision: '带底部操作的菜单主体独立滚动、footer 固定',
    files: [F.menu],
    need: [/data-menu-body/, /data-menu-footer/, /overflow-y-auto/],
  },
  {
    id: 'menu-cascade',
    source: '反馈5#19，反馈7#04',
    decision: '账号›分组›模型逐级飞出，不出现返回上一级',
    files: [F.modelCascade],
    need: [/SubContent|SubTrigger/],
    deny: [/\bconst\s+back\s*=/, /ChevronLeft/, /返回上一级/],
  },
  {
    id: 'menu-recent-models',
    source: '反馈7#04',
    decision: '模型菜单顶部最多 6 个最近使用模型',
    files: [F.modelMenu, F.recentModels],
    need: [/tandem\.recentModels\.v1/, /rankRecentModels\(profiles, 6\)/],
  },
  {
    id: 'popover-stable',
    source: '反馈12#10，反馈14#01/#02',
    decision: 'Radix Content 只定位，动画放内层；触发器不缩放；内容异步就绪再开',
    files: [F.popover, F.menu, F.indexCss],
    need: [/onCloseAutoFocus/, /popover-panel/, /pointerDownOutside/],
    deny: [/transform-origin/],
  },
  {
    id: 'popover-no-focus-steal',
    source: '反馈5#04/#11',
    decision: '从一个弹层点另一个触发器，旧弹层不抢焦点、新弹层保持打开',
    files: [F.popover],
    need: [/onCloseAutoFocus/, /pointerDownOutside/],
  },
  // 侧栏 / 入口 / 导航
  {
    id: 'sidebar-single-new',
    source: '侧栏信息层级',
    decision: '全应用唯一新会话入口 + Ctrl/Cmd+N',
    files: [F.sessionList, F.app],
    need: [/新会话/],
  },
  {
    id: 'sidebar-single-settings',
    source: '侧栏信息层级',
    decision: '全应用唯一设置入口',
    files: [F.sidebar, F.app],
    need: [/openSettings\(\)/, /<span className="min-w-0 flex-1 truncate">设置<\/span>/, /<Sidebar \/>/],
  },
  {
    id: 'sidebar-host-groups',
    source: '反馈6#02',
    decision: '侧栏一次显示所有主机，按主机分组，单主机不显示主机层',
    files: [F.sessionList, F.sessionGroups],
    need: [/hostId/, /离线/],
  },
  {
    id: 'sidebar-indent',
    source: '反馈12#08',
    decision: '项目行缩进 ≤8px，会话标题与项目文字左对齐',
    files: [F.sessionList, F.sessionRow],
    need: [/pl-\[18px\]/, /ml-5|pl-2/],
  },
  {
    id: 'sidebar-hover-actions',
    source: '第 10 轮用户体验反馈',
    decision: '会话行 hover 显示 ⋯，时间不被遮挡',
    files: [F.sessionList, F.sessionRow, F.sessionGroups, F.chatCss],
    need: [/group-hover/, /会话操作|⋯/],
  },
  {
    id: 'topbar-icon-limit',
    source: '信息架构收敛：入口规则',
    decision: '顶栏会话操作 ≤5 个图标，低频收进更多',
    files: [F.topBar],
    need: [/更多/, /IconButton/],
  },
  {
    id: 'topbar-panel-icon-distinct',
    source: '反馈2102#04',
    decision: '顶栏「更多操作」与信息面板分组菜单图标不同，不出现两个 ⋯',
    files: [F.panelMenu],
    need: [/SlidersHorizontal/],
    deny: [/MoreHorizontal/],
  },
  {
    id: 'settings-groups',
    source: '信息架构收敛：入口规则',
    decision: '设置按固定 7 组导航，高级默认折叠',
    files: [F.settingsRegistry],
    need: [/基础/, /模型与账号/, /权限与安全/, /Agent 与自动化/, /团队与共享/, /外观与辅助/, /高级/],
  },
  {
    id: 'settings-content-width',
    source: '反馈15#02',
    decision: '设置内容区统一最大 820px 居中、左右 ≥32px',
    files: [F.settingsDialog],
    need: [/data-settings-content/, /max-w-\[820px\]/],
  },
  {
    id: 'setting-row-icon',
    source: '反馈15#03',
    decision: '设置行图标 14px 槽位、与标题对齐，提示行用次要说明',
    files: [F.settingRow],
    need: [/SettingRow/, /SettingNote/],
  },
  {
    id: 'envbar-host-pending',
    source: '反馈13#02，反馈14#04',
    decision: '换主机先选文件夹：当前/待切换标签、输入框锁定、可取消',
    files: [F.envBar, F.composer],
    need: [/待切换/, /待选/, /取消切换|pendingHostId/],
  },
  {
    id: 'envbar-host-icon',
    source: '反馈2102#08',
    decision: '环境条主机触发器用显示器图标，与文件夹图标形状不同',
    files: [F.envBar],
    need: [/<Monitor size=\{12\}/, /<FolderOpen size=\{12\}/],
    deny: [/<Server size/],
  },
  // 输入框 / 账号 / 路由
  {
    id: 'composer-no-cache-banner',
    source: '反馈8#08，反馈10#02',
    decision: '菜单无常驻缓存提示，选中新模型/账号/分组时确认',
    files: [F.composer, F.menu],
    deny: [/不再提示/],
    need: [/ConfirmAction|切换后提示缓存将失效/],
  },
  {
    id: 'composer-token-estimate',
    source: '反馈8#05',
    decision: '输入框底栏显示 ~x tok 与发送后上下文占比',
    files: [F.composer, F.composerFooter],
    need: [/data-composer-tokens/, /~\{formatTokens\(inputTokens\)\} tok/, /发送后 ~\{/],
  },
  {
    id: 'composer-markdown',
    source: '反馈8#02',
    decision: '输入框轻量 Markdown：围栏、列表续号、着色，发送原始 Markdown',
    files: [F.composer, F.composerEditor],
    need: [/markdownInput|MarkdownHighlight/],
  },
  {
    id: 'chip-no-effort-dot',
    source: '反馈8#11，反馈14#03',
    decision: '模型芯片只显示模型名，不拼强度文字、不显示小点',
    files: [F.modelMenu],
    need: [
      /<span className="min-w-0 truncate">\{label\}<\/span>\s*\{!compact && <ChevronDown/,
      /data-effort=\{effort\}/,
    ],
  },
  {
    id: 'route-labels',
    source: '2026-11-10 用户原话（反馈2009#01）：「这个地方功能是不是要调整一下？上面的四个选项和委派倾向貌似有些许重复，应该是分为两个维度？一个看积不积极派子代理，一个看是质量优先还是成本优先。」替代 反馈8#03/#09 的旧菜单决定',
    decision: '输入框两个独立维度：分工（关闭/适度/积极）与取向（省钱/均衡/质量优先）',
    files: [F.routeLabels, F.composerFooter],
    need: [/分工/, /取向/, /关闭/, /适度/, /积极/, /省钱/, /均衡/, /质量优先/],
  },
  {
    id: 'model-latest-selection',
    source: '反馈10#04',
    decision: '拉取模型默认只勾选每系列最新一代，手动改过后保留选择',
    files: [F.modelSelection],
    need: [/selectLatestModels/, /mergeFetchedSelection/, /isNewerModel/],
  },
  {
    id: 'new-session-pick-memory',
    source: '反馈2102#05',
    decision: '新会话页账号/分组/模型/思考强度按主机记住；记住项已删除时回落默认',
    files: [F.newSession, F.newSessionPick],
    need: [/rememberNewSessionPick\(hostId/, /loadNewSessionPick\(hostId\)/, /resolveNewSessionPick\(profiles/],
  },
  {
    id: 'key-mask-preserve',
    source: '反馈10#05',
    decision: '编辑账号不回传明文/掩码，服务端缺省/空串/掩码保留原 Key',
    files: [F.serverConfig],
    need: [/looksMaskedKey/, /input\.apiKey && !looksMaskedKey\(input\.apiKey\)/],
  },
  {
    id: 'model-capabilities',
    source: '反馈7#05',
    decision: '思考强度档位由模型能力决定，不支持则隐藏',
    files: [F.capabilities],
    need: [/reasoning_effort|reasoningEffort/, /minimal/, /budget_tokens|budgetTokens/],
  },
  // 原生控件 / 滚动条 / 字号
  {
    id: 'native-controls',
    source: '反馈9，反馈10#06',
    decision: '原生 select/datalist/input list/title 一律走共享组件',
    files: [F.menu],
    need: [/MenuSelect|Combobox|Tooltip/],
    deny: [/<select\b/, /<datalist\b/, /\blist=/],
  },
  {
    id: 'overlay-scrollbar',
    source: '反馈9#04，反馈11#01',
    decision: '全应用唯一覆盖式滚动条，不占布局、不压内容',
    files: [F.overlay, F.indexCss],
    need: [/overlay-scrollbar/, /data-axis="y"/, /data-axis="x"/, /\*::-webkit-scrollbar/],
  },
  {
    id: 'focus-ring-neutral',
    source: '2026-11-07 无障碍补充',
    decision: '键盘焦点环 2px 中性灰、只随键盘导航出现',
    files: [F.indexCss],
    need: [/--t-focus-ring/, /data-input-modality="keyboard"/, /focus-visible/],
  },
  {
    id: 'font-size-floor',
    source: '字号下限（硬规则）',
    decision: '正文/列表/按钮 ≥13px，辅助 ≥12px，仅 kbd/徽标 11px',
    files: [F.menu, F.button, F.settingRow],
    need: [/text-\[13px\]|font-size: 13px/, /text-\[12px\]|font-size: 12px/],
    deny: [/text-\[(?:9|10)px\]/, /font-size:\s*(?:9|10)px/],
  },
  {
    id: 'ui-button-sizes',
    source: '打分卡 U1-A（2026-11-10 产品决定）',
    decision: '按钮收敛为控件 32 / 图标 32 / 行内 24，移动端起 44px 触控目标',
    files: [F.button],
    need: [/h-\[32px\]/, /size-\[32px\]/, /inline: 'h-6/, /max-md:min-h-11|max-md:size-11/, /active:bg-\[var\(--t-bg-active\)\]/],
  },
  {
    id: 'ui-card',
    source: '打分卡 U2-A（2026-11-10 产品决定）',
    decision: '卡片统一 12px 圆角、16/18 内边距、无阴影，宽度由容器决定',
    files: [F.card, F.settingRow],
    need: [/rounded-xl/, /px-\[18px\] py-4/, /w-full min-w-0/, /SettingSection/],
    deny: [/shadow-/],
  },
  {
    id: 'ui-empty-state',
    source: '打分卡 U4-A（2026-11-10 产品决定）',
    decision: '空状态虚线框、20px 内边距、30px 图标、13/12 两级文字',
    files: [F.emptyState],
    need: [/data-empty-state/, /rounded-\[10px\] border border-dashed/, /size-\[30px\]/, /text-\[13px\]/, /text-\[12px\]/],
  },
  {
    id: 'tool-row-height',
    source: '反馈11#04',
    decision: '工具行命中区 ≥32px',
    files: [F.chatCss],
    need: [/\.tool-row \{[\s\S]*?min-height: 32px/],
  },
  {
    id: 'diff-colors',
    source: '色板 v3 / scorecard-v8 #04',
    decision: 'diff 增删用低饱和底色+竖条+符号，不出现鲜绿鲜红',
    files: [F.diffView, F.indexCss],
    need: [/--t-git-plus/, /--t-git-minus/],
    deny: [/#00ff00|#ff0000/],
  },
  // 上下文 / 外部会话
  {
    id: 'injection-not-user-turn',
    source: '反馈16#05',
    decision: '外部会话注入系统提示不算用户轮',
    files: [F.protocol, F.external, F.contextServer],
    need: [/isSystemInjectionText/, /isSystemInjectionText\(block\.text\)[\s\S]*?continue/, /type: 'context', kind: '系统提示'/],
  },
  {
    id: 'external-readonly',
    source: '反馈9#01',
    decision: '外部会话只读，复用正常会话大纲与信息面板，缺数据不渲染',
    files: [F.externalPanel, F.messageList],
    need: [/ResizeHandle|TurnRail/, /只读|readOnly|在 Tandem 中继续/],
  },
  // 登录 / 工作站（只做静态存在性，运行时在 e2e）
  {
    id: 'login-gate',
    source: '2026-11-09 用户要求：进入先登录',
    decision: '未登录只显示登录页，登录后回到原路由',
    files: [F.app, 'packages/web/src/components/LoginGate.tsx'],
    need: [/LoginGate|login-gate/],
  },
  {
    id: 'no-host-empty-state',
    source: '2026-11-09 用户要求：没有主机不能开会话',
    decision: '无主机空状态，新会话入口禁用并说明',
    files: [F.app, F.sessionList],
    need: [/先添加一台主机|没有主机/],
  },
  {
    id: 'color-tokens',
    source: '色板 v3 / 反馈13#03',
    decision: '中性色、警告、上下文分类、会话图泳道都用 CSS 变量',
    files: [F.indexCss],
    need: [/--t-bg:/, /--t-warning:/, /--t-warning-soft:/, /--ctx-system:/, /--graph-lane-0:/],
  },
  {
    id: 'primary-white',
    source: 'scorecard-v7 #06',
    decision: '主按钮白底黑字（深色浅底深字），审批/确认不用橙色',
    files: [F.button, F.indexCss],
    need: [/--t-primary-bg:/, /--t-primary-fg:/, /bg-\[var\(--t-primary-bg\)\]/],
  },
  {
    id: 'danger-ghost',
    source: '色板 v3',
    decision: '危险按钮中性，hover 只文字转 danger，不做红底红框',
    files: [F.button],
    need: [/danger-ghost/, /hover:text-danger/],
  },
  {
    id: 'edit-width',
    source: '反馈11#07',
    decision: '编辑消息沿用原气泡宽度，高度自适应',
    files: [F.userMessage],
    need: [/editWidth/, /getBoundingClientRect\(\)\.width/],
  },
  {
    id: 'rewind-compact',
    source: '反馈11#08',
    decision: '回退对话框精简为单行引用/单选/一行警告',
    files: ['packages/web/src/components/RewindDialog.tsx'],
    need: [/role="radiogroup"/, /只恢复对话/, /回退到此处/],
  },
  {
    id: 'theme-preview-height',
    source: '反馈11#04',
    decision: '外观主题预览卡预览区 96px',
    files: ['packages/web/src/components/settings/AppearanceSection.tsx'],
    need: [/h-\[96px\]/],
  },
  {
    id: 'command-palette',
    source: '信息架构收敛：入口规则',
    decision: '所有菜单/设置入口可在 Ctrl/Cmd+K 命令面板检索',
    files: ['packages/web/src/components/SearchDialog.tsx', F.app],
    need: [/data-palette-index/, /metaKey \|\| e\.ctrlKey/, /命令面板|搜索/],
  },
  {
    id: 'code-wrap-grid',
    source: '反馈12#02',
    decision: '自动换行时行号与代码按源码行拆 grid，顶端对齐',
    files: [F.chatCss],
    need: [/file-code-wrap-grid/, /file-code-wrap-row/, /file-code-wrap-no/],
  },
  {
    id: 'table-scroll-hint',
    source: '反馈7#02 / 反馈16#02',
    decision: '表格/代码块超出时块内横向滚动并有可见提示',
    files: [F.chatCss],
    need: [/md-table-scroll/, /overflow-x: auto/, /x-scroll-more/],
  },
  {
    id: 'subagent-hierarchy',
    source: '反馈12#03',
    decision: '层级统一叫子代理，最多视觉缩进 6 层，再深显示 L8',
    files: ['packages/web/src/components/right-panel/AgentsCard.tsx', 'packages/web/src/components/chat/SessionHeaderTools.tsx'],
    need: [/depth > 6/, /L8|层号/, /子代理/],
  },
  {
    id: 'subagent-row-opens-session',
    source: '反馈2108#02（2026-11-10 用户原话：子代理直接跳转到子代理对应的会话即可，不需要展开一个卡片）',
    decision: '消息区子代理工具行点击直接打开子代理会话，不展开卡片',
    files: ['packages/web/src/components/ToolCard.tsx'],
    need: [/if \(onOpenAgent\) \{/, /aria-expanded=\{onOpenAgent \? undefined : open\}/],
  },
  {
    id: 'graph-subagent-opens-session',
    source: '反馈2108#03',
    decision: '会话图子代理节点点击进入子代理会话；主线节点在当前会话定位该轮',
    files: [F.graphCard],
    need: [/openAgentSession\(hostId, node\.subagentId\)/, /focusMessage\(node\.turnId\)/],
  },
  {
    id: 'route-follows-session',
    source: '反馈2108#04',
    decision: '打开会话时地址栏同步，「查看」等按路由跳转的入口不会被同址短路吞掉',
    files: ['packages/web/src/store/appStore/sessionsSlice.ts'],
    need: [/openSession: \(hostId, sessionId\) => \{[\s\S]*?navigate\(\{ kind: 'session', hostId, sessionId \}\)/],
  },
  {
    id: 'no-native-window-prompt',
    source: '反馈9 全局屏蔽',
    decision: '右键菜单/拼写/自动填充由应用接管，不出现浏览器自带控件',
    files: ['packages/web/src/components/AppContextMenu.tsx', 'packages/web/src/index.html', 'packages/web/src/index.css'],
    need: [/AppContextMenu|contextmenu/, /spellcheck/, /writingsuggestions/],
  },
]

let failed = 0
for (const item of DECISIONS) {
  const texts = item.files.map((file) => read(file)).join('\n')
  const problems = []
  if (!texts.trim()) problems.push(`读取不到源码：${item.files.join(', ')}`)
  for (const re of item.need ?? []) {
    if (!re.test(texts)) problems.push(`代码未落实：${re}`)
  }
  for (const re of item.deny ?? []) {
    if (re.test(texts)) problems.push(`代码回退：仍存在 ${re}`)
  }
  if (problems.length > 0) {
    failed += 1
    console.log(`✗ ${item.id} ${item.decision}  [${item.source}]`)
    for (const problem of problems) console.log(`    ${problem}`)
  }
}

if (failed > 0) {
  console.log(`\ndecisions-check: ${failed} / ${DECISIONS.length} 条用户决定没有落实（先改代码，或同步更新本脚本）。`)
  process.exitCode = 1
} else {
  console.log(`decisions-check: ${DECISIONS.length} 条用户决定均已落实。`)
}
