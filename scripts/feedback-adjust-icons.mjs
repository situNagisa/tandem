#!/usr/bin/env node
/**
 * 生成反馈「调整」工具的图标集：扫描 packages/web/src 里 `from 'lucide-react'`
 * 实际导入的图标，只把这些图标放进选择器（不引入第二套图标库）。
 *
 * 图标名取 lucide 渲染出的第一个 `lucide-…` class（官方名，兼容别名导入）。
 * 用法：
 *   node scripts/feedback-adjust-icons.mjs          重新生成
 *   node scripts/feedback-adjust-icons.mjs --check  只检查是否过期（check-debug 用）
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'packages', 'web', 'src')
const TARGET = path.join(SRC, 'components', 'feedback', 'adjustIcons.generated.ts')
const require = createRequire(import.meta.url)
const lucide = require('lucide-react')

/** 常用图标的中文搜索词；没列到的只按英文名搜。 */
const KEYWORDS = {
  'circle-exclamation-point': '警告 错误 注意',
  'triangle-exclamation-point': '警告 注意',
  'activity': '活动 动态 用量',
  'archive': '归档 存档',
  'archive-restore': '取消归档 恢复',
  'arrow-down': '下 向下',
  'arrow-left': '左 返回',
  'arrow-left-right': '切换 交换',
  'arrow-right': '右 前进',
  'arrow-right-left': '切换 交换',
  'arrow-up': '上 向上',
  'arrow-up-right': '打开 外链 新窗口',
  'chart-column': '统计 图表 用量',
  'bell': '通知 提醒',
  'bell-ring': '通知 提醒 响铃',
  'book-open': '文档 wiki 手册',
  'bot': '智能体 agent',
  'brain': '思考 推理 模型',
  'bug': '问题 调试',
  'calendar-clock': '日历 计划 时间',
  'camera': '截图 相机',
  'check': '勾 对 完成 ok',
  'chevron-down': '下 展开',
  'chevron-left': '左 上一级',
  'chevron-right': '右 下一级',
  'chevron-up': '上 收起',
  'chevrons-up-down': '展开 排序',
  'circle': '圆 状态点',
  'circle-exclamation-point': '错误 问题 注意',
  'circle-check': '成功 完成',
  'circle-dashed': '进行中 等待',
  'circle-dot': '记录 当前',
  'circle-slash': '禁止 停用',
  'clipboard-paste': '粘贴 剪贴板',
  'clock': '时间 等待 历史',
  'code-xml': '代码 xml',
  'columns-2': '分屏 两栏',
  'command': '命令 快捷键',
  'copy': '复制',
  'download': '下载 导出',
  'ellipsis': '更多 省略',
  'external-link': '外链 新窗口',
  'eye': '显示 查看',
  'eye-off': '隐藏 不显示',
  'file-text': '文件 文档',
  'file-json': 'JSON 数据',
  'folder': '文件夹 项目',
  'folder-open': '打开文件夹',
  'gauge': '用量 速度 额度',
  'git-branch': '分支 git',
  'git-fork': '分叉 git',
  'git-merge': '合并 git',
  'git-pull-request': '合并请求 PR',
  'globe': '网页 浏览器 公网',
  'grid-3x3': '网格 九宫格',
  'grip-vertical': '拖动 排序',
  'hard-drive': '磁盘 存储',
  'history': '历史 记录',
  'image': '图片',
  'image-plus': '图片 参考图 添加',
  'inbox': '收件箱',
  'info': '说明 信息',
  'kanban': '看板',
  'key-round': '密钥 钥匙',
  'keyboard': '键盘 快捷键',
  'layers': '层级 图层',
  'layout-list': '列表 布局',
  'link-2': '链接',
  'list-checks': '清单 待办',
  'list-tree': '树 目录',
  'loader-circle': '加载 等待',
  'lock': '锁 权限',
  'log-in': '登录 进入',
  'log-out': '退出 登出',
  'map': '地图 映射',
  'maximize-2': '放大 全屏',
  'menu': '菜单',
  'message-square': '消息 对话',
  'messages-square': '会话 消息',
  'mic': '语音 麦克风',
  'monitor': '桌面 屏幕',
  'moon': '深色 夜晚',
  'ellipsis': '更多 省略',
  'mouse-pointer-click': '点选 选择',
  'network': '网络 拓扑',
  'palette': '主题 颜色 外观',
  'panel-left': '侧栏 左栏',
  'panel-right': '右栏 侧栏',
  'paperclip': '附件 回形针',
  'pause': '暂停',
  'pencil': '编辑 修改',
  'pin': '固定 图钉',
  'pin-off': '取消固定',
  'play': '播放 运行',
  'plug': '连接 插件',
  'plus': '新增 添加',
  'power': '开关 电源',
  'redo-2': '重做',
  'refresh-cw': '刷新 重试',
  'rotate-ccw': '重置 撤销',
  'save': '保存',
  'search': '搜索 查找',
  'send': '发送',
  'server': '服务器 主机',
  'settings': '设置 齿轮',
  'share-2': '分享 协作',
  'shield': '安全 保护',
  'shield-check': '安全 已授权',
  'sliders-horizontal': '设置 调节',
  'smartphone': '手机 移动端',
  'sparkles': '智能 新功能',
  'square': '停止 方块',
  'square-terminal': '终端 命令行',
  'sun': '浅色 白天',
  'tablet': '平板 移动端',
  'terminal': '终端 命令行',
  'trash': '删除 垃圾桶',
  'undo-2': '撤销 回退',
  'unplug': '断开 离线',
  'upload': '上传',
  'usb': 'USB 串口',
  'user-round': '用户 账号',
  'users': '成员 团队',
  'video': '录屏 视频',
  'wallet': '余额 费用',
  'wand-sparkles': '自动 优化',
  'webhook': '回调 钩子',
  'wifi': '网络 在线',
  'text-wrap': '换行',
  'wrench': '工具 配置',
  'x': '关闭 取消',
  'circle-x': '失败 错误',
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [full] : []
  })
}

function importNames() {
  const names = new Set()
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8')
    let match
    while ((match = re.exec(text))) {
      for (const part of match[1].split(',')) {
        const raw = part.trim()
        if (!raw || /^type\s/.test(raw)) continue
        const name = raw.split(/\s+as\s+/)[0].trim()
        if (/^[A-Z]/.test(name) && name !== 'LucideIcon') names.add(name)
      }
    }
  }
  return [...names].sort()
}

function canonicalName(componentName) {
  const Component = lucide[componentName]
  if (!Component) return null
  const markup = renderToStaticMarkup(createElement(Component))
  const classes = markup.match(/class="([^"]*)"/)?.[1] ?? ''
  return classes.match(/\blucide-([a-z0-9-]+)/)?.[1] ?? null
}

function generate() {
  const entries = []
  const seen = new Set()
  // 加载态统一用 ui/Spinner；Loader2 不作为可替换的界面图标。
  const SKIP_COMPONENTS = new Set(['Loader2'])
  for (const componentName of importNames()) {
    if (SKIP_COMPONENTS.has(componentName)) continue
    const name = canonicalName(componentName)
    if (!name || seen.has(name)) continue
    seen.add(name)
    entries.push({ name, componentName, keywords: KEYWORDS[name] ?? '' })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const used = [...new Set(entries.map((entry) => entry.componentName))].sort()
  const lines = [
    '// 由 node scripts/feedback-adjust-icons.mjs 生成；勿手改。',
    '// 只含项目实际使用（`from \'lucide-react\'` 导入）的图标，按 lucide 官方名索引。',
    "import type { LucideIcon } from 'lucide-react'",
    `import { ${used.join(', ')} } from 'lucide-react'`,
    '',
    'export interface AdjustIconEntry {',
    '  /** lucide 官方名（kebab-case，也是 `lucide-<name>` class 的后缀）。 */',
    '  name: string',
    '  /** 中文搜索词。 */',
    '  keywords: string',
    '  Icon: LucideIcon',
    '}',
    '',
    'export const ADJUST_ICONS: ReadonlyArray<AdjustIconEntry> = [',
    ...entries.map(
      (entry) =>
        `  { name: '${entry.name}', keywords: '${entry.keywords}', Icon: ${entry.componentName} },`,
    ),
    ']',
    '',
  ]
  return { text: lines.join('\n'), count: entries.length }
}

const { text, count } = generate()
if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8')
  if (current !== text) {
    console.error('[adjust-icons] adjustIcons.generated.ts 已过期，请运行 node scripts/feedback-adjust-icons.mjs')
    process.exit(1)
  }
  console.log(`[adjust-icons] 通过（${count} 个图标，与源码导入一致）`)
} else {
  writeFileSync(TARGET, text, 'utf8')
  console.log(`[adjust-icons] 已生成 ${count} 个图标 → ${path.relative(ROOT, TARGET)}`)
}
