import type { SettingsTab } from './types'

/** 设置页签的中文名：设置导航与命令面板共用，避免两处不一致。 */
export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: '通用',
  voice: '语音',
  browser: '浏览器',
  profiles: '账号与模型',
  hosts: 'Host 管理',
  team: '成员',
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
  { id: 'general.resume-on-restart', tab: 'general', title: 'Host 重启后的会话恢复', keywords: ['恢复', '重启', '续跑', 'resume'] },

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
  { id: 'profiles.key-strategy', tab: 'profiles', title: 'Key 调度策略', keywords: ['Key', '故障切换', '轮询', '冷却', '调度'] },
  { id: 'profiles.prices', tab: 'profiles', title: '模型价格覆盖', keywords: ['价格', '计费', '费用'] },

  { id: 'hosts.list', tab: 'hosts', title: 'Host 列表', keywords: ['主机', '服务器', '连接'] },
  { id: 'hosts.add', tab: 'hosts', title: '添加 Host', keywords: ['新增', '服务器', '扫码'] },
  { id: 'hosts.mode', tab: 'hosts', title: '连接方式', keywords: ['直连', '中继', 'relay'] },
  { id: 'hosts.pair', tab: 'hosts', title: '连接手机', keywords: ['手机', '配对', '扫码'] },
  { id: 'hosts.doctor', tab: 'hosts', title: 'Host 诊断', keywords: ['诊断', 'doctor', '检查', '环境', '报告'] },

  { id: 'team.invite-role', tab: 'team', title: '邀请角色', keywords: ['成员', '邀请', '权限'] },
  { id: 'team.members', tab: 'team', title: '成员列表', keywords: ['成员', '角色'] },
  { id: 'team.invites', tab: 'team', title: '邀请记录', keywords: ['邀请', '链接'] },
  { id: 'team.audit', tab: 'team', title: '审计日志', keywords: ['审计', '日志'] },

  { id: 'gateway.mode', tab: 'gateway', title: '网关模式', keywords: ['网关', 'gateway'] },
  { id: 'gateway.routing', tab: 'gateway', title: '模型路由', keywords: ['路由', '模型', '账号'] },
  { id: 'gateway.tokens', tab: 'gateway', title: '成员令牌', keywords: ['令牌', 'token', '成员'] },
  { id: 'gateway.stats', tab: 'gateway', title: '今日统计', keywords: ['统计', '用量'] },
  { id: 'gateway.logs', tab: 'gateway', title: '日志与调试', keywords: ['日志', '调试'] },

  { id: 'permissions.rules', tab: 'permissions', title: '权限规则', keywords: ['权限', '规则', '允许', '拒绝', '审批'] },
  { id: 'permissions.add', tab: 'permissions', title: '添加权限规则', keywords: ['新增', '规则'] },

  { id: 'hooks.list', tab: 'hooks', title: 'Hooks 列表', keywords: ['hooks', '脚本', '事件'] },
  { id: 'hooks.new', tab: 'hooks', title: '新建 Hook', keywords: ['新增', 'hook'] },

  { id: 'mcp.servers', tab: 'mcp', title: 'MCP 服务器', keywords: ['mcp', '服务器', '工具'] },
  { id: 'mcp.host', tab: 'mcp', title: 'MCP Host 选择', keywords: ['mcp', '主机'] },

  { id: 'skills.list', tab: 'skills', title: 'Skills 列表', keywords: ['技能', 'skills'] },
  { id: 'skills.enabled', tab: 'skills', title: '启用 Skills', keywords: ['技能', '开关'] },

  { id: 'memory.host', tab: 'memory', title: '记忆 Host 选择', keywords: ['记忆', '主机'] },
  { id: 'memory.content', tab: 'memory', title: '项目记忆', keywords: ['记忆', '内容', 'markdown'] },

  { id: 'subagents.default-delegation', tab: 'subagents', title: '新会话默认委派策略', keywords: ['委派', '子代理', '默认'] },
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
  { id: 'appearance.gallery', tab: 'appearance', title: '组件画廊', keywords: ['ui', '组件', '画廊'] },
  { id: 'appearance.feedback', tab: 'appearance', title: '反馈模式', keywords: ['反馈', '标注', '问题'] },
]

export const SETTING_MAP = new Map(SETTINGS_ITEMS.map((item) => [item.id, item]))

export function findSettingItem(id: string): SettingItem | undefined {
  return SETTING_MAP.get(id)
}
