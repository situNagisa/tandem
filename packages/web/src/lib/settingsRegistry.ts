import type { SettingsTab } from './types'

/** 设置页签的中文名：设置导航与命令面板共用，避免两处不一致。 */
export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: '通用',
  voice: '语音',
  browser: '浏览器',
  profiles: '账号与模型',
  routing: '自动路由',
  hosts: '主机',
  accounts: '工作站',
  gateway: '网关',
  permissions: '权限',
  hooks: 'Hooks',
  mcp: 'MCP',
  secrets: 'Secrets',
  skills: 'Skills',
  memory: '记忆',
  subagents: '子代理',
  prompts: '提示词',
  evals: '评测',
  schedules: '定时任务',
  budgets: '预算',
  usage: '用量',
  notifications: '通知',
  shares: '分享',
  sync: '同步与备份',
  appearance: '外观',
}

export interface SettingItem {
  /** 稳定 id，同时用作 DOM 上的 data-setting-id。 */
  id: string
  tab: SettingsTab
  title: string
  keywords: string[]
}

/**
 * 设置项注册表：命令面板与设置页搜索都从这里取。
 * 页面里的对应容器必须带 data-setting-id，选中后才能滚动并高亮。
 */
export const SETTINGS_ITEMS: SettingItem[] = [
  { id: 'general.resume-on-restart', tab: 'general', title: '主机重启后的会话恢复', keywords: ['恢复', '重启', '续跑', 'resume'] },
  { id: 'general.ai-review', tab: 'general', title: '提交前 AI 评审', keywords: ['AI', '评审', 'review', '提交', 'PR', 'blocker', '模型'] },
  { id: 'general.handoff', tab: 'general', title: '额度交接', keywords: ['额度', '限流', '交接', '备用分组', 'quota', '429', '自动切换', '等待重置'] },
  { id: 'general.updates', tab: 'general', title: '桌面更新源', keywords: ['更新', '升级', 'update', '最新版', 'latest.yml', '更新源'] },
  { id: 'general.update-share', tab: 'general', title: 'Host 托管更新文件', keywords: ['更新', '托管', 'updates', '静态目录', '安装包'] },

  { id: 'voice.engine', tab: 'voice', title: '语音识别方式', keywords: ['语音', '识别', '引擎', 'engine'] },
  { id: 'voice.whisper', tab: 'voice', title: 'Host 本地 Whisper', keywords: ['whisper', '后端', '可执行文件', '模型', '语言'] },
  { id: 'voice.device', tab: 'voice', title: '设备内置识别', keywords: ['浏览器', '安卓', '语音包', '离线'] },
  { id: 'voice.privacy', tab: 'voice', title: '语音数据流向', keywords: ['隐私', '数据', '录音'] },

  { id: 'browser.enabled', tab: 'browser', title: '启用浏览器操作', keywords: ['浏览器', '开关', 'browser'] },
  { id: 'browser.display', tab: 'browser', title: '浏览器显示模式', keywords: ['显示', '侧栏', '面板'] },
  { id: 'browser.allowlist', tab: 'browser', title: '域名允许列表', keywords: ['域名', '白名单', '允许'] },
  { id: 'browser.tools', tab: 'browser', title: '浏览器组件', keywords: ['工具', '截图', '组件'] },

  { id: 'secrets.list', tab: 'secrets', title: '项目 Secrets', keywords: ['secret', '密钥', '环境变量', '密码', '令牌', '注入'] },
  { id: 'secrets.generic-mask', tab: 'secrets', title: '通用 Key 打码', keywords: ['打码', '脱敏', 'sk-', 'ghp_', 'AKIA', '私钥'] },

  { id: 'profiles.accounts', tab: 'profiles', title: '账号列表', keywords: ['账号', '服务商', 'Key'] },
  { id: 'profiles.groups', tab: 'profiles', title: '账号分组', keywords: ['分组', '渠道', '协议'] },
  { id: 'profiles.models', tab: 'profiles', title: '模型列表', keywords: ['模型', '默认模型'] },
  { id: 'profiles.group-key', tab: 'profiles', title: '分组 Key', keywords: ['Key', '分组', '替换', '删除', '冷却'] },
  { id: 'profiles.prices', tab: 'profiles', title: '模型价格覆盖', keywords: ['价格', '计费', '费用'] },

  { id: 'routing.candidates', tab: 'routing', title: '自动路由候选池', keywords: ['自动', '路由', '候选', '模型', '档位', '快速', '强力'] },
  { id: 'routing.preference', tab: 'routing', title: '取向默认', keywords: ['取向', '分工', '省钱', '均衡', '质量优先', '偏好'] },
  { id: 'routing.judge', tab: 'routing', title: '用小模型判断难度', keywords: ['判断', '难度', '小模型', '自动路由'] },
  { id: 'routing.division', tab: 'routing', title: '多代理协作', keywords: ['分工', '多代理协作', '规划', '执行', '专长', 'Task', '子代理', '省钱', '整单交执行者', '确认'] },

  { id: 'hosts.list', tab: 'hosts', title: '主机列表', keywords: ['主机', '服务器', '连接', '授权', '改名'] },
  { id: 'hosts.detail', tab: 'hosts', title: '主机详情', keywords: ['主机', '改名', '设备', '诊断', '授权', '移除'] },
  { id: 'hosts.doctor', tab: 'hosts', title: '主机诊断', keywords: ['诊断', 'doctor', '检查', '环境', '报告'] },

  { id: 'accounts.workspace', tab: 'accounts', title: '工作站与账号', keywords: ['工作站', '账号', '登录', '注册', '绑定码', 'workstation'] },
  { id: 'accounts.name', tab: 'accounts', title: '工作站名称', keywords: ['工作站', '名称', '改名'] },
  { id: 'accounts.registration', tab: 'accounts', title: '注册方式', keywords: ['注册', '邀请', '邀请码', '开放'] },
  { id: 'accounts.members', tab: 'accounts', title: '成员账号', keywords: ['账号', '成员', '角色', '禁用'] },

  { id: 'gateway.mode', tab: 'gateway', title: '网关模式', keywords: ['网关', 'gateway'] },
  { id: 'gateway.routing', tab: 'gateway', title: '模型转发', keywords: ['路由', '模型', '账号'] },
  { id: 'gateway.tokens', tab: 'gateway', title: '网关令牌', keywords: ['令牌', 'token', '网关'] },
  { id: 'gateway.stats', tab: 'gateway', title: '今日统计', keywords: ['统计', '用量'] },
  { id: 'gateway.logs', tab: 'gateway', title: '日志与调试', keywords: ['日志', '调试'] },

  { id: 'permissions.sandbox', tab: 'permissions', title: '命令沙箱', keywords: ['沙箱', 'bwrap', '隔离', '写保护'] },
  { id: 'permissions.network', tab: 'permissions', title: '网络白名单', keywords: ['网络', '白名单', '域名', '断网', '联网'] },
  { id: 'permissions.rules', tab: 'permissions', title: '权限规则', keywords: ['权限', '规则', '允许', '拒绝', '审批'] },
  { id: 'permissions.add', tab: 'permissions', title: '添加权限规则', keywords: ['新增', '规则'] },

  { id: 'hooks.list', tab: 'hooks', title: 'Hooks 列表', keywords: ['hooks', '脚本', '事件'] },
  { id: 'hooks.new', tab: 'hooks', title: '新建 Hook', keywords: ['新增', 'hook'] },

  { id: 'mcp.servers', tab: 'mcp', title: 'MCP 服务器', keywords: ['mcp', '服务器', '工具'] },
  { id: 'mcp.host', tab: 'mcp', title: 'MCP 主机选择', keywords: ['mcp', '主机'] },

  { id: 'skills.list', tab: 'skills', title: 'Skills 列表', keywords: ['技能', 'skills'] },
  { id: 'skills.enabled', tab: 'skills', title: '启用 Skills', keywords: ['技能', '开关'] },

  { id: 'memory.host', tab: 'memory', title: '记忆主机选择', keywords: ['记忆', '主机'] },
  { id: 'memory.content', tab: 'memory', title: '项目记忆', keywords: ['记忆', '内容', 'markdown'] },

  { id: 'subagents.default-delegation', tab: 'subagents', title: '新会话默认分工', keywords: ['分工', '子代理', '默认'] },
  { id: 'subagents.presets', tab: 'subagents', title: '子代理预设', keywords: ['预设', '子代理', '模型'] },
  { id: 'subagents.create', tab: 'subagents', title: '新建子代理预设', keywords: ['新增', '子代理'] },

  { id: 'prompts.templates', tab: 'prompts', title: '提示词模板', keywords: ['提示词', '模板', 'prompt'] },
  { id: 'prompts.editor', tab: 'prompts', title: '提示词正文', keywords: ['提示词', '内容'] },

  { id: 'evals.cases', tab: 'evals', title: '评测用例', keywords: ['评测', '用例'] },
  { id: 'evals.config', tab: 'evals', title: '评测配置', keywords: ['配置', '思考强度', '默认'] },
  { id: 'evals.reviewer', tab: 'evals', title: '评审模型', keywords: ['评审', '模型'] },
  { id: 'evals.concurrency', tab: 'evals', title: '评测并发数', keywords: ['并发', '数量'] },
  { id: 'evals.results', tab: 'evals', title: '评测结果', keywords: ['结果', '对比'] },

  { id: 'schedules.list', tab: 'schedules', title: '定时任务', keywords: ['定时', 'schedule', 'cron'] },
  { id: 'schedules.new', tab: 'schedules', title: '新建定时任务', keywords: ['新建', '定时'] },
  { id: 'schedules.effort', tab: 'schedules', title: '定时任务思考强度', keywords: ['思考', '强度', 'effort'] },
  { id: 'schedules.permission', tab: 'schedules', title: '定时任务权限模式', keywords: ['权限', '模式'] },

  { id: 'budgets.enabled', tab: 'budgets', title: '启用预算规则', keywords: ['预算', '开关'] },
  { id: 'budgets.rules', tab: 'budgets', title: '预算规则', keywords: ['预算', '上限', '金额'] },
  { id: 'budgets.edit', tab: 'budgets', title: '编辑预算规则', keywords: ['预算', '编辑'] },

  { id: 'usage.range', tab: 'usage', title: '统计范围', keywords: ['用量', '范围', '时间'] },
  { id: 'usage.chart', tab: 'usage', title: '花费图表', keywords: ['花费', '图表', '用量'] },
  { id: 'usage.models', tab: 'usage', title: '按模型用量', keywords: ['模型', '用量', '费用'] },

  { id: 'notifications.desktop', tab: 'notifications', title: '桌面通知', keywords: ['通知', '系统通知', '浏览器'] },
  { id: 'notifications.app', tab: 'notifications', title: 'App 通知（本地）', keywords: ['安卓', '通知', '本地'] },
  { id: 'notifications.background', tab: 'notifications', title: '后台保持连接', keywords: ['安卓', '后台', '保活'] },
  { id: 'notifications.events', tab: 'notifications', title: '提醒哪些事件', keywords: ['审批', '回合', '预算', '提醒'] },

  { id: 'shares.list', tab: 'shares', title: '分享列表', keywords: ['分享', '链接'] },

  { id: 'sync.export', tab: 'sync', title: '导出配置', keywords: ['备份', '导出'] },
  { id: 'sync.import', tab: 'sync', title: '导入配置', keywords: ['恢复', '导入'] },

  { id: 'appearance.theme', tab: 'appearance', title: '主题', keywords: ['外观', '深色', '浅色', '跟随系统'] },
  { id: 'appearance.shortcuts', tab: 'appearance', title: '键盘快捷键', keywords: ['快捷键', '命令', '按键'] },
  { id: 'appearance.notifications', tab: 'appearance', title: '桌面通知', keywords: ['通知', '开关'] },
  { id: 'appearance.install', tab: 'appearance', title: '安装到手机主屏', keywords: ['手机', 'pwa', '主屏'] },
  // 调试专用设置项：发布版不注册，设置搜索与命令面板都找不到。
  ...(__TANDEM_DEBUG__
    ? [
        { id: 'appearance.gallery', tab: 'appearance' as const, title: '组件画廊', keywords: ['ui', '组件', '画廊'] },
        { id: 'appearance.feedback', tab: 'appearance' as const, title: '反馈模式', keywords: ['反馈', '标注', '问题'] },
        { id: 'appearance.debug-account', tab: 'appearance' as const, title: '调试账号自动登录', keywords: ['调试', '账号', '自动登录'] },
      ]
    : []),
]

export const SETTING_MAP = new Map(SETTINGS_ITEMS.map((item) => [item.id, item]))

export function findSettingItem(id: string): SettingItem | undefined {
  return SETTING_MAP.get(id)
}


/* ------------------------------------------------------------------ */
/* 设置导航分组：页面数较多，导航只展示 19 个入口；低频专家页收进「高级」。 */
/* ------------------------------------------------------------------ */

export type SettingsPageId =
  | 'general'
  | 'hosts'
  | 'workstation'
  | 'shares'
  | 'profiles'
  | 'routing'
  | 'usage-budgets'
  | 'permissions'
  | 'secrets'
  | 'agent'
  | 'schedules'
  | 'memory'
  | 'appearance'
  | 'notifications'
  | 'voice'
  | 'browser'
  | 'extensions'
  | 'evals'
  | 'gateway'
  | 'sync'

export interface SettingsPage {
  id: SettingsPageId
  label: string
  /** 合并页包含的原子页签，顺序即子页签顺序。 */
  tabs: SettingsTab[]
}

export interface SettingsGroup {
  id: string
  label: string
  pages: SettingsPageId[]
  /** 默认收起（低频、偏专家的页面）。 */
  collapsed?: boolean
}

export const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'general', label: '通用', tabs: ['general'] },
  { id: 'hosts', label: '主机', tabs: ['hosts'] },
  { id: 'profiles', label: '账号与模型', tabs: ['profiles'] },
  { id: 'routing', label: '自动路由', tabs: ['routing'] },
  { id: 'usage-budgets', label: '用量与预算', tabs: ['usage', 'budgets'] },
  { id: 'permissions', label: '权限', tabs: ['permissions'] },
  { id: 'secrets', label: 'Secrets', tabs: ['secrets'] },
  { id: 'agent', label: 'Agent 能力', tabs: ['subagents', 'skills', 'prompts'] },
  { id: 'schedules', label: '定时任务', tabs: ['schedules'] },
  { id: 'memory', label: '记忆', tabs: ['memory'] },
  { id: 'workstation', label: '工作站', tabs: ['accounts'] },
  { id: 'shares', label: '分享', tabs: ['shares'] },
  { id: 'appearance', label: '外观', tabs: ['appearance'] },
  { id: 'notifications', label: '通知', tabs: ['notifications'] },
  { id: 'voice', label: '语音', tabs: ['voice'] },
  { id: 'browser', label: '浏览器', tabs: ['browser'] },
  { id: 'extensions', label: '扩展', tabs: ['mcp', 'hooks'] },
  { id: 'evals', label: '评测', tabs: ['evals'] },
  { id: 'gateway', label: '网关', tabs: ['gateway'] },
  { id: 'sync', label: '同步与备份', tabs: ['sync'] },
]

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: 'common', label: '基础', pages: ['general', 'hosts', 'workstation', 'shares'] },
  { id: 'models', label: '模型与账号', pages: ['profiles', 'routing', 'usage-budgets'] },
  { id: 'safety', label: '权限与安全', pages: ['permissions', 'secrets'] },
  { id: 'automation', label: 'Agent 与自动化', pages: ['agent', 'schedules', 'memory'] },
  { id: 'appearance', label: '外观与辅助', pages: ['appearance', 'notifications', 'voice', 'browser'] },
  { id: 'advanced', label: '高级', pages: ['extensions', 'evals', 'gateway', 'sync'], collapsed: true },
]

export const SETTINGS_PAGE_MAP = new Map(SETTINGS_PAGES.map((page) => [page.id, page]))

export function settingsPageForTab(tab: SettingsTab): SettingsPage | undefined {
  return SETTINGS_PAGES.find((page) => page.tabs.includes(tab))
}

export function settingsGroupForTab(tab: SettingsTab): SettingsGroup | undefined {
  const page = settingsPageForTab(tab)
  if (!page) return undefined
  return SETTINGS_GROUPS.find((group) => group.pages.includes(page.id))
}
