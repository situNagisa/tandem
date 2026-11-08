import type { SettingsTab } from './types'

export type ChangelogTarget =
  | { kind: 'settings'; tab: SettingsTab; settingId?: string }
  | { kind: 'search' }
  | { kind: 'board' }
  | { kind: 'split' }
  | { kind: 'inbox' }
  | { kind: 'home' }
  /** 打开演示工作区；带 scenario 时直接打开对应演示场景。 */
  | { kind: 'demo'; scenario?: string }
  | { kind: 'checklist' }
  | { kind: 'about' }
  | { kind: 'feedback' }

export interface ChangelogEntry {
  id: string
  title: string
  /** 一句话说明，导览列表里只显示这一句。 */
  summary: string
  target: ChangelogTarget
}

export interface ChangelogRelease {
  version: string
  date: string
  items: ChangelogEntry[]
}

/** 版本升级后首次打开时展示；按版本从新到旧排列。 */
export const CHANGELOG: ChangelogRelease[] = [
  {
    version: '0.2.1',
    date: '2026-11-08',
    items: [
      {
        id: 'demo-workspace',
        title: '演示工作区',
        summary: '一键创建带演示数据的会话、看板与设置页，随时清除，不影响真实数据。',
        target: { kind: 'demo' },
      },
      {
        id: 'checklist',
        title: '体验清单',
        summary: '按功能逐项体验并标记通过/有问题；进度与报告都保存在本机。',
        target: { kind: 'checklist' },
      },
      {
        id: 'feedback-grouping',
        title: '反馈按功能与根因归类',
        summary: '反馈自动归到功能并建议根因，导出后按功能、按根因分别整理。',
        target: { kind: 'feedback' },
      },
    ],
  },

  {
    version: '0.2.0',
    date: '2026-11-08',
    items: [
      {
        id: 'desktop-update',
        title: '桌面端自动更新',
        summary: '桌面端可从内网更新源发现并下载新版本，安装完成后提示重启。',
        target: { kind: 'settings', tab: 'general', settingId: 'general.updates' },
      },
      {
        id: 'release-signing',
        title: '安卓正式签名包',
        summary: '安卓端提供签名 APK 与上架用 AAB，版本与桌面端保持一致。',
        target: { kind: 'about' },
      },
      {
        id: 'preview-canvas',
        title: '应用预览画布',
        summary: '在会话侧栏预览本机前端应用，可切换设备尺寸、点选元素并回填到对话。',
        target: { kind: 'demo', scenario: 'preview' },
      },
      {
        id: 'project-wiki',
        title: '项目 Wiki',
        summary: '为仓库生成模块页与术语页，agent 可检索；增量更新保留手写内容。',
        target: { kind: 'demo', scenario: 'wiki' },
      },
      {
        id: 'session-paging',
        title: '大会话分页与轮次大纲',
        summary: '超大会话首屏只加载最近内容，滚到顶部自动补更早内容，轮次大纲可直接跳转。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'ssh-remote',
        title: '远程主机一键部署',
        summary: '用 SSH 添加远程主机并部署 Host，手机可经隧道连接使用。',
        target: { kind: 'settings', tab: 'hosts', settingId: 'hosts.ssh.add' },
      },
      {
        id: 'settings-tour',
        title: '设置分组与新功能导览',
        summary: '设置项按用途分组，顶栏入口更少；升级后首次打开会提示本版新增功能。',
        target: { kind: 'about' },
      },
      {
        id: 'board-v2',
        title: '看板与 AI 评审增强',
        summary: '看板支持运行时提议、卡片 AI 评审与 PR 聚合，分屏里也能处理冲突。',
        target: { kind: 'board' },
      },
    ],
  },



  {
    version: '0.1.0',
    date: '2026-11-08',
    items: [
      {
        id: 'command-palette',
        title: '命令面板统一搜索',
        summary: 'Ctrl/Cmd+K 能搜会话、命令、设置项与主机，支持拼音首字母。',
        target: { kind: 'search' },
      },
      {
        id: 'auto-compact',
        title: '上下文自动压缩',
        summary: '接近上下文上限时先摘要旧对话，长会话不再因超长中断。',
        target: { kind: 'settings', tab: 'general', settingId: 'general.auto-compact' },
      },
      {
        id: 'approval-learning',
        title: '审批策略学习',
        summary: '同类请求批准 3 次后建议项目级自动允许，危险命令永不建议。',
        target: { kind: 'settings', tab: 'permissions', settingId: 'permissions.learning' },
      },
      {
        id: 'doctor',
        title: '主机诊断',
        summary: '逐项检查 Node、磁盘、账号连通、git 与 MCP，报告自动脱敏。',
        target: { kind: 'settings', tab: 'hosts', settingId: 'hosts.doctor' },
      },
      {
        id: 'secrets',
        title: '项目 Secrets',
        summary: '项目密钥只注入命令环境，消息与日志中自动打码。',
        target: { kind: 'settings', tab: 'secrets', settingId: 'secrets.list' },
      },
      {
        id: 'full-text-search',
        title: '全文搜索与筛选',
        summary: '会话正文、外部会话和工具路径都能搜；侧栏可按状态、主机、项目筛选。',
        target: { kind: 'search' },
      },
      {
        id: 'sandbox',
        title: '命令沙箱与网络白名单',
        summary: '限制越界写入与非白名单联网，危险操作转审批。',
        target: { kind: 'settings', tab: 'permissions', settingId: 'permissions.sandbox' },
      },
      {
        id: 'split',
        title: '多会话分屏',
        summary: '2 列、3 列或 2×2 同时看多个会话，布局刷新后保留。',
        target: { kind: 'split' },
      },
      {
        id: 'board',
        title: '任务看板',
        summary: '把目标拆成卡片并行执行，支持依赖、审批、AI 评审与 PR 聚合。',
        target: { kind: 'board' },
      },
      {
        id: 'handoff',
        title: '额度交接',
        summary: 'Key 限流或预算将尽时切换到备用分组，或等待额度重置。',
        target: { kind: 'settings', tab: 'general', settingId: 'general.handoff' },
      },
      {
        id: 'auto-route',
        title: '自动模型路由',
        summary: '按难度与偏好自动选模型，简单任务用快模型，失败自动升级。',
        target: { kind: 'settings', tab: 'routing', settingId: 'routing.preference' },
      },
      {
        id: 'team',
        title: '内网团队与共享',
        summary: '邀请成员、审批转交、审计日志，以及会话分享链接。',
        target: { kind: 'settings', tab: 'team', settingId: 'team.members' },
      },
    ],
  },
]

export const CHANGELOG_VERSION = CHANGELOG[0]?.version ?? '0.0.0'
export const LATEST_CHANGELOG_ITEMS = CHANGELOG.flatMap((release) => release.items)
export const APP_VERSION = __APP_VERSION__

const SEEN_KEY = 'tandem.changelogSeen.v1'
const ONBOARDING_KEY = 'tandem.onboarding.v1'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等 localStorage 不可用时，导览只在本次会话有效 */
  }
}

export function changelogSeenVersion(): string | null {
  return read(SEEN_KEY)
}

export function markChangelogSeen(): void {
  write(SEEN_KEY, CHANGELOG_VERSION)
}

export function onboardingDone(): boolean {
  return read(ONBOARDING_KEY) === 'done'
}

export function markOnboardingDone(): void {
  write(ONBOARDING_KEY, 'done')
}

/** 跳转后在目标元素上加一圈短暂高亮，不改变布局。 */
export function pulseTourTarget(selector: string, delay = 220): void {
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('tour-pulse')
    void el.getBoundingClientRect()
    el.classList.add('tour-pulse')
    window.setTimeout(() => el.classList.remove('tour-pulse'), 1900)
  }, delay)
}
