import type { DemoScenarioInfo } from '@tandem/protocol';

export type DemoScenarioId =
  | 'chat-tools'
  | 'permission'
  | 'plan'
  | 'subagents'
  | 'background'
  | 'delegation'
  | 'auto-compact'
  | 'handoff'
  | 'ai-review'
  | 'changes'
  | 'board'
  | 'evals'
  | 'wiki'
  | 'preview'
  | 'inbox'
  | 'resume'
  | 'hooks';

/** 场景清单：每个场景都可以直接打开，也可以重新播放。 */
export const DEMO_SCENARIOS: Array<Omit<DemoScenarioInfo, 'sessionIds' | 'boardId' | 'evalRunId' | 'project'>> = [
  {
    id: 'chat-tools',
    title: '基础对话与工具调用',
    summary: '用户提问 → 思考 → 只读工具 → 结果回填与中文总结；可以继续发消息，演示模型会按固定剧本回复。',
    kind: 'session',
    group: 'conversation',
    panel: undefined,
  },
  {
    id: 'permission',
    title: '权限审批',
    summary: '打开即出现 Bash 审批卡；允许后命令只会在演示仓库里执行 git status，可观察审批记录与收件箱同步。',
    kind: 'session',
    group: 'conversation',
  },
  {
    id: 'plan',
    title: '计划模式与计划卡',
    summary: '会话处于计划模式，右侧显示待批准计划；审批卡可批准、自动接受编辑或要求继续完善。',
    kind: 'session',
    group: 'conversation',
  },
  {
    id: 'subagents',
    title: '子代理与孙代理',
    summary: '主会话派发子代理，子代理再派发孙代理；右侧代理卡显示层级树与各自结论。',
    kind: 'session',
    group: 'conversation',
    panel: 'agents',
  },
  {
    id: 'background',
    title: '后台任务',
    summary: '演示仓库内启动一个本地心跳任务；打开后台任务面板可查看增量输出、结束后保留的任务记录。',
    kind: 'session',
    group: 'conversation',
    panel: 'background',
  },
  {
    id: 'delegation',
    title: '委派倾向仅规划',
    summary: '主会话委派倾向为「仅规划」，消息流展示 Task 派发与汇总；可在输入框的执行方式菜单里切换。',
    kind: 'session',
    group: 'conversation',
  },
  {
    id: 'auto-compact',
    title: '上下文自动压缩',
    summary: '长会话已触发自动压缩：消息流出现压缩提示，上下文卡显示接近上限与按当前速度可跑轮数。',
    kind: 'session',
    group: 'conversation',
  },
  {
    id: 'handoff',
    title: '配额交接卡（模拟 429）',
    summary: '模拟主分组限流：消息尾部出现交接卡，可切换到演示备用模型或等待额度重置。',
    kind: 'session',
    group: 'conversation',
  },
  {
    id: 'resume',
    title: '断点续跑恢复提示',
    summary: 'Host 重启后暂停的会话：顶部提示可继续或只恢复对话；运行意图与排队消息已保留。',
    kind: 'session',
    group: 'conversation',
  },
  {
    id: 'hooks',
    title: 'Hooks 出错提示',
    summary: '打开后广播一条失败的 PreToolUse Hook；消息流以内联灰字显示 stderr，不会常驻底部。',
    kind: 'session',
    group: 'conversation',
    playable: true,
  },
  {
    id: 'ai-review',
    title: 'AI 评审意见挂到 diff 行',
    summary: '演示仓库有未提交改动；改动审阅里已有一份 AI 评审，意见按文件与行号展示，可采纳或标记误报。',
    kind: 'session',
    group: 'review',
    panel: 'changes',
  },
  {
    id: 'changes',
    title: '改动审阅与行评论',
    summary: '演示仓库的未提交 diff：选中行即可写行评论，文件状态字母与 +/− 数字带低饱和色。',
    kind: 'session',
    group: 'review',
    panel: 'changes',
  },
  {
    id: 'board',
    title: '任务看板',
    summary: '三张有依赖的卡 + 待审批 + 待评审 + 失败 + 一张 AI 拆分草稿；不自动运行，所有卡片都可手动操作。',
    kind: 'board',
    group: 'review',
  },
  {
    id: 'evals',
    title: '评测集对比结果',
    summary: '同一组用例在演示模型与演示备用模型下的通过率、耗时与花费对比，可打开轨迹查看。',
    kind: 'eval',
    group: 'workspace',
    settingsTab: 'evals',
  },
  {
    id: 'wiki',
    title: 'Wiki 页面',
    summary: '演示项目的概览、模块与术语表三页 Wiki，含全文搜索与手写段落。',
    kind: 'wiki',
    group: 'workspace',
  },
  {
    id: 'preview',
    title: '应用预览',
    summary: '演示仓库自带静态页面，Host 用本机回环静态服务托管；打开预览可切换设备尺寸并点选元素。',
    kind: 'preview',
    group: 'workspace',
    panel: 'preview',
  },
  {
    id: 'inbox',
    title: '收件箱里的各种事件',
    summary: '审批、回合结束、预算告警、CI、评测、看板与交接事件各一条，全部标注为演示数据。',
    kind: 'inbox',
    group: 'workspace',
  },
];

export function demoScenario(id: string): (typeof DEMO_SCENARIOS)[number] | undefined {
  return DEMO_SCENARIOS.find((scenario) => scenario.id === id);
}
