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
  markdown: 'packages/web/src/components/Markdown.tsx',
  assistantMessage: 'packages/web/src/components/chat/AssistantMessage.tsx',
  turnActivity: 'packages/web/src/components/chat/TurnActivity.tsx',
  messageList: 'packages/web/src/components/MessageList.tsx',
  chatView: 'packages/web/src/components/ChatView.tsx',
  composer: 'packages/web/src/components/Composer.tsx',
  composerSend: 'packages/web/src/components/composer/useComposerSend.ts',
  composerFooter: 'packages/web/src/components/composer/ComposerFooter.tsx',
  composerEditor: 'packages/web/src/components/composer/ComposerEditor.tsx',
  composerLive: 'packages/web/src/components/composer/markdownLive.ts',
  modelMenu: 'packages/web/src/components/composer/ModelMenu.tsx',
  diffView: 'packages/web/src/components/DiffView.tsx',
  permissionCard: 'packages/web/src/components/PermissionCard.tsx',
  sessionList: 'packages/web/src/components/SessionList.tsx',
  sessionRow: 'packages/web/src/components/session/SessionRow.tsx',
  sessionGroups: 'packages/web/src/components/session/SessionGroups.tsx',
  sidebar: 'packages/web/src/components/Sidebar.tsx',
  featureTour: 'packages/web/src/components/tour/FeatureTour.tsx',
  routePlanLine: 'packages/web/src/components/chat/RoutePlanLine.tsx',
  profileKeysPanel: 'packages/web/src/components/settings/profiles/KeysPanel.tsx',
  modelRoutingServer: 'packages/server/src/model-routing.ts',
  app: 'packages/web/src/App.tsx',
  envBar: 'packages/web/src/components/EnvBar.tsx',
  topBar: 'packages/web/src/components/TopBar.tsx',
  panelMenu: 'packages/web/src/components/right-panel/PanelMenu.tsx',
  newSession: 'packages/web/src/components/NewSessionDialog.tsx',
  newSessionPick: 'packages/web/src/lib/newSessionPick.ts',
  settingsDialog: 'packages/web/src/components/settings/SettingsDialog.tsx',
  settingsRegistry: 'packages/web/src/lib/settingsRegistry.ts',
  hostsSection: 'packages/web/src/components/settings/HostsSection.tsx',
  hostDetail: 'packages/web/src/components/settings/HostDetailDrawer.tsx',
  addHostDialog: 'packages/web/src/components/workstation/AddHostDialog.tsx',
  noHosts: 'packages/web/src/components/workstation/NoHostsView.tsx',
  workstationSection: 'packages/web/src/components/workstation/WorkstationSection.tsx',
  workstationDialog: 'packages/web/src/components/workstation/WorkstationDialog.tsx',
  commands: 'packages/web/src/lib/commands.ts',
  menu: 'packages/web/src/components/ui/Menu.tsx',
  popover: 'packages/web/src/components/ui/Popover.tsx',
  modelCascade: 'packages/web/src/components/ui/ModelCascade.tsx',
  overlay: 'packages/web/src/components/ui/OverlayScrollbar.tsx',
  settingRow: 'packages/web/src/components/ui/SettingRow.tsx',
  button: 'packages/web/src/components/ui/Button.tsx',
  card: 'packages/web/src/components/ui/Card.tsx',
  emptyState: 'packages/web/src/components/ui/EmptyState.tsx',
  badge: 'packages/web/src/components/ui/Badge.tsx',
  badgeChecklist: 'packages/web/src/components/demo/ChecklistDialog.tsx',
  badgeFeedbackOverlay: 'packages/web/src/components/feedback/FeedbackOverlay.tsx',
  graphView: 'packages/web/src/components/sessionGraph/SessionGraphView.tsx',
  graphCard: 'packages/web/src/components/sessionGraph/SessionGraphCard.tsx',
  graphLayout: 'packages/web/src/components/sessionGraph/layout.ts',
  graphData: 'packages/web/src/components/sessionGraph/data.ts',
  graphTree: 'packages/web/src/components/sessionGraph/useGraphTree.ts',
  graphServer: 'packages/server/src/host/graph.ts',
  jump: 'packages/web/src/lib/jump.ts',
  hoverCard: 'packages/web/src/components/ui/HoverCard.tsx',
  topology: 'packages/web/src/components/session/SessionTopology.tsx',
  sessionTree: 'packages/web/src/lib/sessionTree.ts',
  sessionListUtils: 'packages/web/src/components/session/sessionListUtils.ts',
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
  handoffCard: 'packages/web/src/components/chat/HandoffCard.tsx',
  generalSettings: 'packages/web/src/components/settings/GeneralSettings.tsx',
  serverHandoff: 'packages/server/src/handoff.ts',
  serverHandoffHost: 'packages/server/src/host/handoff.ts',
  serverLoop: 'packages/server/src/agent/loop.ts',
  fileLinks: 'packages/web/src/lib/fileLinks.ts',
  fileRefExists: 'packages/web/src/lib/fileRefExists.ts',
  fsRoutes: 'packages/server/src/routes/fs.ts',
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
    id: 'context-card-structure',
    source: '反馈13#05',
    decision: '上下文卡分类顺序与阈值刻度',
    files: [F.contextCard],
    need: [/CONTEXT_PART_ORDER/, /data-context-threshold/],
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
    source: '2026-11-09 用户决定：会话图配色与节点形状（2026-11-12 反馈1110：悬停的节点放大一档）',
    decision: '所有节点统一 8px 实心圆，只有指针悬停的那一个放大到 10px',
    files: [F.graphView],
    need: [/data-marker="circle"/, /isHoveredNode \? 10 : 8/, /rounded-full/],
  },
  {
    id: 'graph-lane-colors',
    source: '2026-11-09 用户决定：会话图配色',
    decision: '泳道色变量 --graph-lane-0..7，子代理合并线 data-merge，分叉不合并',
    files: [F.graphView, F.indexCss],
    need: [/--graph-lane-/, /data-merge/, /分叉/],
  },
  {
    id: 'graph-no-meta',
    source:
      '反馈1926#01#02#04#05#08#09（2026-11-11 用户原话：不需要这段描述文字 / 不需要这个按钮，子代理直接展开 / 不要这个按钮，直接展开 / 不需要显示轮次 / 不需要写一个结果已返回，直接合并到它的父会话节点上 / 一律不需要显示token消耗）',
    decision: '会话图不显示汇总行、轮次序号、token/耗时等用量与「结果已返回」行，也没有展开/收起按钮；子代理始终展开',
    files: [F.graphView, F.graphCard, F.graphLayout],
    need: [/data-edge-hit/, /graphCardHeight\(layout\.rows\)/],
    deny: [/graphSummaryLabel/, /结果已返回/, /data-expand-subagent/, /formatTokens/, /formatDurationMs/, /collapsed/],
  },
  {
    id: 'graph-reversed',
    source: '反馈1926#06（2026-11-11 用户原话：方向反一下，让最后的会话在上面，越早的会话在下面）',
    decision: '会话图时间倒序：最新一轮在最上，行号在布局末尾统一翻转',
    files: [F.graphLayout],
    need: [/flipRow/, /flipRow\(/],
  },
  {
    id: 'graph-edge-hover',
    source: '反馈1926#10（2026-11-11 用户原话：鼠标悬停在某条线上时，要高亮这条线，并tip出这是哪个会话）',
    decision:
      '悬停任一泳道线（或名称行）按归属会话高亮整条轨道与节点、其余线降亮，tooltip 显示会话名；线有两侧各 6px 的透明命中描边，点线/点节点跳转会话',
    files: [F.graphView],
    need: [/data-edge-hit/, /data-tip=\{edge\.label\}/, /EDGE_HIT_WIDTH = 13/, /ownerId/],
  },
  {
    id: 'graph-hover-node',
    source: '反馈1110（2026-11-12 用户原话：悬停的会话没有更加高亮，不知道自己悬停在哪了，缺少交互）',
    decision:
      '悬停某节点时同一会话整条线保持高亮，被悬停的那个轮节点再突出：圆点 8px→10px 并加同色外圈（data-hovered），同线其他节点不变；悬停浮层紧凑模式同样适用',
    files: [F.graphView],
    need: [/data-hovered=\{isHoveredNode/, /isHoveredNode \? 10 : 8/, /hoveredNode/],
  },
  {
    id: 'graph-running-all-sessions',
    source:
      '反馈1110（2026-11-12 用户原话：最新的正在思考输出的轮次没有对应的标识…子代理、分叉、主会话都要有，哪条线在思考运行可以一眼看出来）',
    decision:
      '会话图里任何运行中的会话（主会话/分叉/子代理）都在自己最新一轮节点显示与侧栏一致的 running-dot 呼吸动画；graph 接口按会话下发 running，会话运行状态变化时重新拉取拓扑',
    files: [F.protocol, F.graphServer, F.graphData, F.graphTree, F.graphView],
    need: [/running\?: boolean/, /rec\.status === 'running'/, /running: true/, /latestTurnOf/, /session\.status/],
  },
  {
    id: 'graph-main-click-from-subagent',
    source: '反馈1926#03（2026-11-11 用户原话：在子代理页面中，点击会话图的主会话，无法跳转）',
    decision: '子代理只读视图里点会话图主线节点，先退出子代理视图再定位该轮',
    files: [F.graphCard],
    need: [/if \(agentSession\) closeAgentSession\(\)/],
  },
  {
    id: 'jump-single-spring',
    source:
      '反馈1110（2026-11-12 用户原话：跳转用之前的轮次大纲的跳转代码，不需要滑轮中断跳转，只是统一跳转逻辑，并且不要一直轮询锁视图，现在的跳转没有跳转动画了）',
    decision:
      '所有入口（轮次大纲、会话图、搜索、收件箱、子代理返回）只有一个跳转实现 lib/jump.ts：focusMessage/focusTool 用轮次大纲原来的弹簧跟随动画滚动（长距离先瞬移到目标前约 1 屏），到达后最多复核一次落点就停；不轮询、不按定时器反复写 scrollTop，滚轮不中断动画，结束后视口归用户',
    files: [F.jump, F.messageList, 'packages/web/src/components/chat/TurnRail.tsx'],
    need: [/createJumpScroller/, /startJumpScroll/, /FOLLOW_K = 240/, /focusMessage\(/],
    deny: [/CANCEL_EVENTS/, /armCancel/, /pollJump/],
  },
  {
    id: 'sidebar-fork-same-row',
    source:
      '2026-11-11 22:09 用户原话（以后分叉就不要新增一个会话选项卡了，跟原来的会话共用一个选项卡）',
    decision:
      '侧栏分叉与原会话共用一行：按会话树归并，行标题是根会话标题，点击打开树内最近活动的会话，未读/运行中/待审批按树汇总，打开分叉时行内小字标出分叉名',
    files: [F.sessionList, F.sessionRow, F.sessionListUtils, F.sessionTree],
    need: [/sessionTreeRootId/, /openedId/, /branchTitle/, /data-session-branch/, /treeIds/],
    deny: [/data-fork-row/],
  },
  {
    id: 'sidebar-hover-topology',
    source:
      '2026-11-11 22:09 用户原话（悬停会话选项卡时右侧弹出会话图，UI、交互方式都跟会话图保持一致）+ 2026-11-12 02:47 用户原话（拓扑图应该包含分叉节点：从哪一轮分叉出去、派出子代理的那个节点必须包含，否则只是一个点伸出几条爪子，看不出拓扑关系）',
    decision:
      '悬停浮层与右栏会话图共用 layoutSessionGraph 与同一套渲染组件：紧凑模式不显示轮次标题，只在每个会话起点显示会话名；保留每个会话的起点/最新轮、分叉点/派出点与子代理汇回点，其余轮次省略；悬停名称行高亮该会话的线与节点，点节点或线跳转会话',
    files: [F.hoverCard, F.topology, F.graphLayout, F.graphView, F.graphData],
    need: [
      /HOVER_CARD_OPEN_DELAY = TIP_SHOW_DELAY/,
      /compact: true/,
      /data-session-topology/,
      /data-attach-point/,
      /EDGE_HIT_WIDTH/,
    ],
    deny: [/layoutSessionTopology/],
  },
  {
    id: 'graph-trunk-current',
    source:
      '2026-11-12 用户原话（在一个分叉里面，要用主线，并且仿照 Git 的图……从一个绘画里面分叉出来的所有绘画，以及它所有的子代理，它们的绘画图的拓扑结构完全一样，只是主线不同，在不同的绘画中就用不同的主线）',
    decision:
      '一棵会话树（根 + 递归分叉 + 所有子代理）只有一张拓扑：节点是轮次，边是下一轮/分叉自某轮/子代理派出与汇回；树内任何会话打开时节点与边完全相同，只有主线（当前会话的祖先链）不同。主线 = 当前会话轮次 + 来源会话在分叉点之前的轮次，一条直线在第 0 列；其余会话的独有轮次是从分叉点分出的分支泳道',
    files: [F.protocol, F.graphData, F.graphLayout, F.graphCard],
    need: [/SessionGraphTree/, /graphFromTree/, /attachTurnId/, /chainPrefix/, /trunkSet/],
    deny: [/relation: 'source'/],
  },
  {
    id: 'graph-one-topology-per-tree',
    source:
      '2026-11-12 用户原话（分叉的会话图没有做对……分叉作为主线，一条线上去，不应该再在这里引出一个蓝色的条，并且也可以看到主会话上分出的子代理节点。分叉的会话图里所有节点和主会话应该都是一样的，只是主线不同）',
    decision:
      '主会话视图与分叉视图的节点集合、连线关系相同（同一棵树的轮次各出现一次）；来源会话在分叉点之后的轮次画成完整分支泳道，不再画成单节点「原会话」支线；主会话上派出的子代理在分叉视图里照常可见',
    files: [F.graphData, F.graphLayout, F.graphCard],
    need: [/GraphTreeInput/, /trunkSet/, /ownersOfAttach/],
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
  {
    id: 'message-meta-last-only',
    source:
      '2026-11-11 用户原话（在一轮会话中，只有最后一段需要留空白…中间这些不需要留空白来显示）',
    decision: '一轮内只有最后一条 assistant 回复渲染时间/用量/操作行，中间段落不留空白',
    files: [F.messageList, F.assistantMessage],
    need: [/lastAssistantOfTurn/, /showMeta/, /data-msg-meta/],
  },
  {
    id: 'file-ref-explicit-only',
    source:
      '2026-11-11 用户原话（应该明确指明文件，才生成对应链接。不能靠字符串识别，只要长得像文件，就当成一个文件链接）',
    decision:
      '只有 Markdown 链接与「行内代码 + 文件确实存在」生成链接；纯文本不识别；工具卡路径保持可点',
    files: [F.markdown, F.fileLinks, F.fileRefExists, F.fsRoutes],
    need: [/extractInlineRefs/, /parseFileHref/, /\/api\/fs\/exist/, /exists\[ref\.path\]/],
    deny: [/remarkFileLinks/, /splitFileRefs/],
  },
  {
    id: 'handoff-continue-first',
    source:
      '2026-11-11 用户原话（额度预算它就没有继续功能…我没办法继续，现在就用不掉这个额度）',
    decision:
      '额度交接卡第一位是「继续使用当前分组」：服务端记住到会话，同类提醒不再拦截，直到上游报额度错误',
    files: [F.handoffCard, F.serverHandoffHost, F.protocol],
    need: [/继续使用当前分组/, /handoffBypass/, /'continue'/, /HandoffAction/],
  },
  {
    id: 'handoff-can-disable',
    source: '2026-11-11 用户原话（我也没办法把预算功能关掉）',
    decision: '额度交接可整体关闭；关闭后服务端不建卡、不等待；预测性提醒只提示不拦截',
    files: [F.generalSettings, F.serverHandoff, F.serverHandoffHost],
    need: [/value="off"/, /'off'/, /settings\.policy === 'off'/, /reason === 'forecast'/],
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
    source: '侧栏信息层级；反馈1323#04（2026-11-11 原话「这里的ui参考claude code，收成一个选项，显示账号，右边一个齿轮，表示设置，账号点开后可以看到一些其他的项」）',
    decision: '全应用唯一设置入口：侧栏底部一行，左侧账号、右侧齿轮；账号菜单只放账号与工作站设置，设备入口不在这里',
    files: [F.sidebar, F.app],
    need: [/openSettings\(\)/, /label="设置"/, /data-sidebar-footer/, /aria-label="账号菜单"/, /<Sidebar \/>/, /工作站设置/],
    deny: [/<span className="min-w-0 flex-1 truncate">设置<\/span>/, /setWorkstationOpen/, /所有主机的 ADB \/ 串口设备/, /工作站管理/],
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
    id: 'sidebar-old-sessions-collapsed',
    source: '2026-11-12 用户原话「超过一定时间的会话可以隐藏掉，点击按钮才加载出来」',
    decision:
      '项目分组里最近活动超过 7 天的会话默认收起，组末一行「更早的 N 个会话」点开才渲染；固定、运行中、待审批、未读始终显示，展开状态按项目记住',
    files: [
      F.sessionGroups,
      F.sessionList,
      'packages/web/src/components/session/sessionListUtils.ts',
      'packages/web/src/store/useUiStore.ts',
    ],
    need: [
      /OLDER_SESSION_MS = 7 \* 24 \* 60 \* 60 \* 1000/,
      /staysVisibleWhenOlder/,
      /更早的 \{olderHidden.length\} 个会话/,
      /expandedOlderProjects/,
    ],
  },
  {
    id: 'tour-pill-auto-hide',
    source: '反馈1323#01（2026-11-11 原话「这个如果说没点开来看，过一段时间就自动退掉」）',
    decision: '新功能提示条出现后 30 秒内没点开就自动收起并记为本版本已读；点开过按原有导览逻辑',
    files: [F.featureTour],
    need: [/TOUR_PILL_AUTO_HIDE_MS = 30_000/, /autoMode !== 'tour'/, /markChangelogSeen\(\)/],
  },
  {
    id: 'profile-group-single-key',
    source: '反馈1323#02（2026-11-11 原话「每个分组只会有一个key，不需要拖动」）',
    decision: '分组只显示一个 Key（掩码 + 状态，可测试/更换/删除），无拖动、故障切换、轮询、添加 Key 与 Key/模型数量；旧多 Key 保留不显示',
    files: [F.profileKeysPanel],
    need: [/group\.keys\.find\(\(key\) => !key\.disabled\)/, /data-key-replace/, /data-key-delete/, /keys\.filter\(\(key\) => key\.id !== shown\?\.id\)/],
    deny: [/拖动 Key/, /故障切换/, /轮询/, /添加 Key/, /GripVertical/, /keyStrategy/],
  },
  {
    id: 'route-plan-injected-visible',
    source: '反馈1323#03（2026-11-11 原话「这里是否有上下文注入？如果有的话，需要显示出来，我们的原则是透明，东西要让用户看到」）',
    decision: '提示行展开显示本轮实际注入的文本；无注入时悬停说明未注入',
    files: [F.routePlanLine, F.modelRoutingServer],
    need: [/plan\.injected/, /未向模型注入内容/, /data-route-injection/, /routePlanInjection/, /多代理协作 · 本轮/],
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
    decision: '设置按固定分组导航（主机与工作站都在「基础」组），高级默认折叠',
    files: [F.settingsRegistry],
    need: [/基础/, /模型与账号/, /权限与安全/, /Agent 与自动化/, /外观与辅助/, /高级/],
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
  {
    id: 'envbar-git-only',
    source: '反馈1323#07 #08（2026-11-11 原话：「这个在非git仓库的时候应该是不可选的？可以考虑非git仓库的时候直接不显示」「这个可以优化一下，非git仓库时直接不显示」）',
    decision: '非 Git 仓库时环境条不显示分支触发器与 Worktree 开关，git 仓库保持原样',
    files: [F.envBar],
    need: [/knownNonGit = !envLoading && !env\?\.repoRoot/, /\{!knownNonGit && \(/],
    deny: [/label=\{branch \?\? \(env \? '分支' : '非 Git 仓库'\)\}/],
  },
  {
    id: 'envbar-folder-recent',
    source: '反馈1323#09（2026-11-11 原话：「只保留最近，然后添加一个打开文件夹，直接用系统的查找文件夹的方式去选文件夹」）',
    decision: '文件夹弹层只列最近目录 + 「打开文件夹…」；桌面版且主机就是本机用系统对话框，其余用应用内目录浏览对话框',
    files: [
      F.envBar,
      'packages/web/src/lib/desktopFolder.ts',
      'packages/desktop/preload.js',
      'packages/desktop/main.js',
    ],
    need: [/loadRecentDirs\(hostId\)/, /打开文件夹…/, /isDesktopLocalHost/, /folder:pick/],
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
    source:
      '反馈8#02；2026-11-11 用户原话：「我想要的是类似 obisidian 或者说 VSCode 的 Markdown，它们平时正常显示，选中哪一行，哪一行就变为可编辑的」',
    decision:
      '输入框用 CodeMirror 承载的 Markdown 实时预览：光标行显示源码，其余行隐藏标记；代码块/表格整块切换；Enter 续号、围栏与 @ 路径行为不变，发送原始 Markdown',
    files: [F.composer, F.composerEditor, F.composerLive, F.composerSend],
    need: [/markdownLive/, /markdownInput/, /atomicRanges/, /md-code-widget/],
  },
  {
    id: 'user-bubble-markdown',
    source: '2026-11-11 用户原话：「然后用户的气泡也要完整渲染」',
    decision: '用户气泡用与助手正文相同的 Markdown 组件渲染（标题降级、列表/代码块/表格/引用），编辑与复制仍是源码',
    files: [F.userMessage, F.markdown],
    need: [/<Markdown text=\{text\} variant="user" \/>/, /is-user/],
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
    source: '2026-11-10 用户原话（反馈2009#01）：「这个地方功能是不是要调整一下？上面的四个选项和委派倾向貌似有些许重复，应该是分为两个维度？一个看积不积极派子代理，一个看是质量优先还是成本优先。」；2026-11-11 用户原话（反馈1601#04）：「这个可以移入旁边选择模型的列表里，然后我觉得没必要有记住为会话偏好，选择了后当前会话之后都用选择的策略。」',
    decision: '分工与取向并入模型菜单（原生开关 + 分工/取向两组），选择即写入当前会话、无「记住」；模型芯片只显示模型名',
    files: [F.routeLabels, F.modelMenu, F.composerFooter],
    need: [/分工/, /取向/, /关闭/, /适度/, /积极/, /省钱/, /均衡/, /质量优先/, /Menu\.CheckItem/, /onRouteNativeChange/],
    deny: [/记住为会话偏好/, /aria-label="分工与取向"/],
  },
  {
    id: 'route-native',
    source: '2026-11-11 16:11 用户原话（反馈1601#04 更正）：「\'关闭这个功能\' 指的是再增加一个关闭的选项，选了这个并不意味着就不派子代理，不怎么样了，而是说不注入提示词，用原生模型自己去跑」',
    decision: '原生开关：不注入任何分工/取向/路由提示词、不做路由规则分类改写；工具不减（含 Task），提示行「原生（未注入）」；分工原「关闭」仍是主会话不派子代理',
    files: [
      F.modelRoutingServer,
      'packages/server/src/host/subagents.ts',
      F.modelMenu,
      F.composerFooter,
      F.protocol,
    ],
    need: [/mode: 'native'/, /routeNativeFor/, /原生（未注入）/, /routeNative\?: boolean/, /原生模式下不生效/],
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
    source: '反馈9#04，反馈11#01，反馈1926#07',
    decision: '全应用唯一覆盖式滚动条，不占布局、不压内容；嵌套滚动容器让位到最近的祖先留白（卡片外/面板内边距）',
    files: [F.overlay, F.indexCss],
    need: [/overlay-scrollbar/, /data-axis="y"/, /data-axis="x"/, /\*::-webkit-scrollbar/, /npad >= 12/],
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
    id: 'ui-badge',
    source: '2026-11-11 用户决定（原话「徽標用方案B」）',
    decision: '徽标/标签统一描边：透明底 + 1px 边、4px 圆角、20px 高、11px 字；状态/演示用中性描边，反馈标注用 --t-annotation',
    files: [F.badge, F.indexCss, F.badgeChecklist, F.badgeFeedbackOverlay],
    need: [
      /h-5/,
      /rounded-\[4px\]/,
      /text-\[11px\]/,
      /border-annotation\/45/,
      /--t-annotation:/,
      /<Badge tone="neutral">/,
      /<Badge tone="annotation">/,
    ],
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
    id: 'hosts-single-entry',
    source: '2026-11-11 用户原话：工作站主机就有三四个入口，功能都非常类似；没有任何必要出现一个仅本机使用；设备也不仅仅只有 ADB 和串口',
    decision: '工作站=服务、主机=机器、设备=开放概念；主机只有设置→主机一个列表，点行进详情；设备面板叫「设备」',
    files: [F.settingsRegistry, F.hostsSection, F.hostDetail, F.workstationDialog, F.workstationSection, F.envBar],
    need: [
      /id: 'workstation', label: '工作站'/,
      /id: 'shares', label: '分享'/,
      /data-host-row=/,
      /HostDetailDrawer/,
      /HostGrantDialog/,
      /'我的' : '获授权'/,
      /title="设备"/,
      /管理主机…/,
      /添加主机…/,
    ],
    deny: [/team-shares/, /accounts\.hosts/, /hosts\.pair/, /title="工作站"/, /所有主机的 ADB \/ 串口设备|加密隧道/],
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
    id: 'graph-running-animation',
    source: '反馈2156#03（2026-11-11 用户原话：正在输出的轮次加上一个动画，比如闪烁，或者转圈之类的动画）',
    decision: '运行中会话的最新一轮节点外圈复用侧栏运行中的 running-dot 呼吸动画',
    files: [F.graphView, F.graphCard],
    need: [/running-dot/, /running=/],
  },
  {
    id: 'graph-external-nodes-clickable',
    source: '反馈0220#01（2026-11-12 用户原话：外部绘画，绘画图没办法点击跳转）',
    decision: '外部会话等只读会话图的节点点击也走同一个 focusMessage 定位该轮，不再整张图禁用点击',
    files: [F.graphCard, F.externalPanel],
    need: [/focusMessage\(node\.turnId\)/],
  },
  {
    id: 'hover-card-single-session-hidden',
    source:
      '反馈0220#06（2026-11-12 用户原话：当一个会话没有分叉或者子代理时，右侧就不要弹出这个卡片，这个卡片没有什么用）',
    decision: '树里只有当前会话（没有分叉、没有子代理）时不弹悬停拓扑卡片；有分支才弹',
    files: [F.sessionRow, F.hoverCard],
    need: [/hasTreeBranches/, /ids\.size > 1/],
  },
  {
    id: 'hover-card-feedback-freeze',
    source:
      '反馈0220#06（2026-11-12 用户原话：进入反馈模式的时候，右侧卡片还是会消失，估计是绕过了原有代码）',
    decision:
      'HoverCard 与菜单/Popover 同一套反馈模式规则：反馈模式（Ctrl+Shift+F）下指针离开触发器不收起，浮层停住供圈选',
    files: [F.hoverCard],
    need: [/useFeedbackStore/, /getState\(\)\.active/],
  },
  {
    id: 'hover-topology-hit-area',
    source:
      '反馈0220#07（2026-11-12 用户原话：鼠标悬浮在这些选项卡上时，左边的拓扑图也要进行高亮。并且点击左边的拓扑图的时候，也要进行会话的跳转）+ 原话（拓扑图特别细，鼠标悬停很难选中）',
    decision:
      '拓扑图命中区：连线透明描边两侧各 6px（列距 14px 保证相邻泳道命中带不重叠），节点圆点命中区 20px，名称行整行可点；悬停名称行/节点高亮该会话的线与节点',
    files: [F.graphView, F.graphLayout],
    need: [/EDGE_HIT_WIDTH = 13/, /NODE_HIT_SIZE = 20/, /GRAPH_COLUMN_GAP = 14/],
  },
  {
    id: 'graph-subagent-opens-session',
    source: '反馈2108#03',
    decision: '会话图子代理节点点击进入子代理会话；主线节点在当前会话定位该轮',
    files: [F.graphCard],
    need: [/openAgentSession\(hostId, targetId\)/, /focusMessage\(node\.turnId\)/],
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

// 添加主机唯一化：只有一个 AddHostDialog 实现，所有「添加主机」入口都打开它。
{
  const problems = []
  const imports = []
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = read(rel)
        if (/import \{[^}]*\bAddHostDialog\b/.test(text)) imports.push(rel)
      }
    }
  }
  walk('packages/web/src')
  if (imports.length !== 1 || imports[0] !== F.app) {
    problems.push(`AddHostDialog 应只在 App 渲染一次，实际：${imports.join(', ') || '无'}`)
  }
  for (const file of [F.hostsSection, F.noHosts, F.envBar, F.featureTour, F.commands]) {
    if (!/setAddHostOpen/.test(read(file))) problems.push(`${file} 的「添加主机」入口没有打开唯一对话框`)
  }
  if (!/title="添加主机"/.test(read(F.addHostDialog))) problems.push('AddHostDialog 标题不统一')
  if (/workstationApi\.(join|enableLocal)|localStatus\(/.test(read(F.addHostDialog))) {
    problems.push('AddHostDialog 仍依赖 Host 侧本机路由（join/enable/localStatus）')
  }
  if (problems.length > 0) {
    failed += 1
    console.log('✗ add-host-single-dialog 添加主机只有一个对话框，入口全部指向它')
    for (const problem of problems) console.log(`    ${problem}`)
  }
}

if (failed > 0) {
  console.log(`\ndecisions-check: ${failed} / ${DECISIONS.length} 条用户决定没有落实（先改代码，或同步更新本脚本）。`)
  process.exitCode = 1
} else {
  console.log(`decisions-check: ${DECISIONS.length} 条用户决定均已落实。`)
}
