import { useState } from 'react'
import {
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  LayoutList,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sun,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { applyTheme, useUiStore } from '../../store/useUiStore'
import { Button, IconButton } from './Button'
import { Input, SegmentedControl, Switch } from './Controls'
import { ListRow } from './ListRow'
import { Menu, MenuSelect } from './Menu'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'

function Block({
  name,
  note,
  children,
  className,
}: {
  name: string
  note?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-surface p-4', className)}>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[13px] font-semibold">{name}</h2>
        {note && <span className="text-[12px] text-muted">{note}</span>}
        <code className="ml-auto rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 font-mono text-[12px] text-muted">
          {name}
        </code>
      </div>
      {children}
    </section>
  )
}

export function UiGallery() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const [checked, setChecked] = useState(true)
  const [value, setValue] = useState('b')
  const [sw, setSw] = useState(true)
  const [sel, setSel] = useState('medium')
  const [text, setText] = useState('')
  const [rows, setRows] = useState(['inbox'])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-[1180px] px-6 py-6 pb-16">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div>
            <h1 className="font-serif text-[24px] leading-tight">组件画廊</h1>
            <p className="mt-1 text-[13px] text-muted">
              所有列表、菜单、按钮、控件的唯一来源。用 Ctrl+Shift+F 圈选任意一处提意见，改一处全局生效。
            </p>
          </div>
          <span className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '切到浅色' : '切到深色'}
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Block name="Button" note="sm / md / lg，五种变体" className="md:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">主要操作</Button>
              <Button variant="secondary">次要操作</Button>
              <Button variant="ghost">幽灵按钮</Button>
              <Button variant="danger-ghost">危险操作</Button>
              <Button variant="accent">发送</Button>
              <Button size="sm" variant="secondary">小号 sm</Button>
              <Button size="lg" variant="primary">大号 lg</Button>
              <Button disabled>禁用</Button>
              <IconButton label="搜索"><Search size={16} /></IconButton>
              <IconButton label="更多" tooltip="更多操作"><MoreHorizontal size={16} /></IconButton>
              <IconButton label="新增" variant="secondary"><Plus size={16} /></IconButton>
              <IconButton label="设置" disabled><Settings size={16} /></IconButton>
            </div>
          </Block>

          <Block name="Input / Select" note="28 / 32 / 36 三档">
            <div className="space-y-2">
              <Input placeholder="默认输入框" value={text} onChange={(e) => setText(e.target.value)} />
              <Input size="sm" placeholder="小号 28px" />
              <Input size="lg" placeholder="大号 36px" />
              <Input placeholder="禁用" disabled />
              <MenuSelect
                value={sel}
                onChange={setSel}
                options={[
                  { value: 'off', label: '关' },
                  { value: 'low', label: '低' },
                  { value: 'medium', label: '中' },
                  { value: 'high', label: '高', hint: '推荐' },
                  { value: 'max', label: '最高', disabled: true, disabledReason: '当前模型不支持' },
                ]}
              />
            </div>
          </Block>

          <Block name="SegmentedControl / Switch" note="选中一律中性色">
            <div className="space-y-4">
              <SegmentedControl
                value={value}
                onChange={setValue}
                options={[
                  { value: 'a', label: '浅色' },
                  { value: 'b', label: '深色' },
                  { value: 'c', label: '跟随系统' },
                  { value: 'd', label: '禁用', disabled: true },
                ]}
              />
              <SegmentedControl
                size="sm"
                value="x"
                onChange={() => {}}
                options={[
                  { value: 'x', label: '列表' },
                  { value: 'y', label: '看板' },
                ]}
              />
              <div className="flex items-center gap-4">
                <Switch checked={sw} onChange={setSw} label="示例开关" />
                <Switch checked={false} onChange={() => {}} label="关闭状态" />
                <Switch checked disabled onChange={() => {}} label="禁用开关" />
              </div>
            </div>
          </Block>

          <Block name="Tooltip" note="悬停 500ms，Portal + 碰撞避让">
            <div className="flex flex-wrap gap-2">
              <Tooltip label="这是一条标准 tooltip，全局只此一种样式" side="top">
                <Button variant="secondary" size="sm">悬停看提示</Button>
              </Tooltip>
              <Button variant="secondary" size="sm" tooltip="按钮自带的 tooltip">带提示按钮</Button>
            </div>
          </Block>

          <Block name="ListRow" note="侧栏 / 设置列表行">
            <div className="space-y-0.5">
              <ListRow
                icon={<LayoutList size={16} />}
                title="默认行"
                trailing="12:40"
                onClick={() => {}}
              />
              <ListRow
                icon={<Folder size={16} />}
                title="选中行"
                detail="第二行说明文字"
                selected
                onClick={() => {}}
              />
              <ListRow
                icon={<GitBranch size={16} />}
                title="很长的列表标题会在行尾自动截断，不会挤掉右侧信息"
                trailing="99+"
                onClick={() => {}}
              />
              <ListRow icon={<Settings size={16} />} title="禁用行" disabled onClick={() => {}} />
            </div>
          </Block>

          <Block name="Menu" note="26px 行 / 子菜单 / 禁用原因" className="md:col-span-2">
            <div className="flex flex-wrap items-start gap-3">
              <Menu
                trigger={<Button variant="secondary">普通菜单 <ChevronDown size={14} /></Button>}
                className="w-[240px]"
              >
                <Menu.Item icon={<Folder size={14} />}>打开文件夹</Menu.Item>
                <Menu.Item icon={<Search size={14} />} hint="在全部会话中搜索">搜索</Menu.Item>
                <Menu.Item icon={<Check size={14} />} selected>已选中的行</Menu.Item>
                <Menu.Item icon={<Folder size={14} />}>
                  这是一个非常长的菜单项，用来确认文字会在行尾截断而不会把菜单撑破
                </Menu.Item>
                <Menu.Label>分组标签</Menu.Label>
                <Menu.Item icon={<GitBranch size={14} />} disabled disabledReason="当前不是 git 仓库">
                  切换分支
                </Menu.Item>
                <Menu.Item danger>删除</Menu.Item>
                <Menu.Separator />
                <Menu.Sub>
                  <Menu.SubTrigger trailing="高">思考强度</Menu.SubTrigger>
                  <Menu.SubContent className="w-[240px]">
                    <p className="px-2 pb-1.5 pt-1 text-[12px] leading-4 text-muted">
                      投入程度越高，回复越详尽，但耗时越长、用量越多。
                    </p>
                    <Menu.RadioGroup value="high" onValueChange={() => {}}>
                      {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
                        <Menu.RadioItem key={e} value={e} trailing={e === 'high' ? '推荐' : undefined}>
                          {{ off: '关', low: '低', medium: '中', high: '高', max: '最高' }[e]}
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  </Menu.SubContent>
                </Menu.Sub>
                <Menu.Sub>
                  <Menu.SubTrigger>切换账号</Menu.SubTrigger>
                  <Menu.SubContent className="w-[200px]">
                    <Menu.Item keepOpen>muze</Menu.Item>
                    <Menu.Sub>
                      <Menu.SubTrigger>codex</Menu.SubTrigger>
                      <Menu.SubContent className="w-[180px]">
                        <Menu.Item selected>A 分组</Menu.Item>
                        <Menu.Item>B 分组</Menu.Item>
                      </Menu.SubContent>
                    </Menu.Sub>
                  </Menu.SubContent>
                </Menu.Sub>
              </Menu>

              <Menu
                trigger={<Button variant="secondary">多选菜单 <ChevronDown size={14} /></Button>}
                className="w-[220px]"
              >
                {[
                  ['inbox', '收件箱'],
                  ['pinned', '置顶'],
                  ['archived', '已归档'],
                ].map(([id, label]) => (
                  <Menu.CheckItem
                    key={id}
                    checked={rows.includes(id)}
                    onCheckedChange={() =>
                      setRows((prev) =>
                        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                      )
                    }
                  >
                    {label}
                  </Menu.CheckItem>
                ))}
              </Menu>

              <Popover
                trigger={({ open, toggle }) => (
                  <Button variant="secondary" onClick={toggle} aria-expanded={open}>
                    普通 Popover
                  </Button>
                )}
              >
                {() => (
                  <div className="w-[220px] p-1 text-[13px] text-text-soft">
                    适合放搜索框、表单、评论列表等非菜单内容；碰撞避让与 Portal 与菜单相同。
                  </div>
                )}
              </Popover>
            </div>
          </Block>
        </div>

        <p className="mt-5 text-[12px] leading-5 text-muted">
          `scripts/ui-audit.mjs` 会扫描 ui/ 目录以外的手写菜单与列表行，防止回退到各写一套。
        </p>
      </div>
    </div>
  )
}
