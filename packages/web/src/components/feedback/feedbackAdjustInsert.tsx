/**
 * 调整模式里插入的示意控件：只用 ui/* 现有组件与变体渲染。
 * 这些 DOM 位于副本之上，导出时临时克隆进冻结 stage 供「调整后截图」使用；
 * 改动清单明确标注「示意草稿，实现时按 ui/* 复刻」，不会被当成最终实现。
 */
import { Layers, Plus } from 'lucide-react'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Button, IconButton, type ButtonVariant } from '../ui/Button'
import { Card } from '../ui/Card'
import { Input } from '../ui/Controls'
import { ListRow } from '../ui/ListRow'
import type { AdjustInsertedItem } from './feedbackAdjust'

function RowView({
  component,
  title,
  detail,
  index,
  size,
}: {
  component: 'ListRow' | 'Button' | 'Badge'
  title: string
  detail?: string
  index: number
  size: 'sm' | 'md'
}) {
  if (component === 'Button') {
    return (
      <Button size={size === 'sm' ? 'inline' : 'md'} variant="secondary" className="w-full">
        {title || '按钮'}
      </Button>
    )
  }
  if (component === 'Badge') {
    return (
      <div className="px-1.5 py-1">
        <Badge>{title || '徽标'}</Badge>
      </div>
    )
  }
  return (
    <ListRow
      as="div"
      size={size}
      title={title || `列表项 ${index + 1}`}
      detail={detail || undefined}
      trailing={index + 1}
    />
  )
}

function ContainerHeader({ icon, title, count }: { icon?: boolean; title: string; count?: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1.5 pb-1">
      {icon ? <Layers size={12} className="text-annotation" /> : null}
      <span className="text-[12.5px] font-medium text-text">{title}</span>
      {count ? (
        <span className="ml-auto">
          <Badge tone="neutral">{count}</Badge>
        </span>
      ) : null}
    </div>
  )
}

/** 容器展开后的示意行；空时提示「展开编辑」添行。 */
function ContainerRows({ item, size }: { item: AdjustInsertedItem; size: 'sm' | 'md' }) {
  if (item.rows.length === 0) {
    return (
      <p className="px-1.5 py-3 text-center text-[12px] text-muted">
        空状态：在右侧「展开编辑」添加示意行
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      {item.rows.map((row, index) => (
        <RowView
          key={row.id}
          component={row.component}
          title={row.title}
          detail={row.note}
          index={index}
          size={size}
        />
      ))}
    </div>
  )
}

export function renderInserted(item: AdjustInsertedItem) {
  if (item.kind === 'button') {
    return (
      <Button size="md" variant={item.variant as ButtonVariant}>
        {item.label}
      </Button>
    )
  }
  if (item.kind === 'icon-button') {
    return (
      <IconButton label={item.label} variant={item.variant as ButtonVariant}>
        <Plus size={16} />
      </IconButton>
    )
  }
  if (item.kind === 'badge') {
    return <Badge tone={item.variant as BadgeTone}>{item.label}</Badge>
  }
  if (item.kind === 'list-row') {
    return (
      <ListRow
        as="div"
        title={item.label}
        detail={item.behavior || undefined}
        className="w-[260px] border border-border"
      />
    )
  }
  if (item.kind === 'input') {
    return <Input size="md" readOnly placeholder="输入框" className="w-[220px]" />
  }
  if (item.kind === 'card') {
    return (
      <Card className="w-[280px]">
        <p className="text-[13px] font-medium text-text">卡片标题</p>
        <p className="mt-1 text-[12px] text-muted">用于承载一组内容；行为在备注里说明。</p>
        {item.rows.length > 0 && (
          <div className="mt-2">
            <ContainerRows item={item} size="sm" />
          </div>
        )}
      </Card>
    )
  }
  if (item.kind === 'menu') {
    return (
      <Card data-adjust-menu="" className="w-[240px] p-2">
        <ContainerHeader icon title="菜单（示意）" count={`${item.rows.length} 行`} />
        <ContainerRows item={item} size="sm" />
        <p className="px-1.5 pt-1 text-[11px] text-muted">实现时用 ui/Menu 的 Item，不用手写菜单行。</p>
      </Card>
    )
  }
  // 组合控件：Card + ListRow（清单里写清组合关系，不伪装成不存在的组件）。
  return (
    <Card className="w-[300px] p-2">
      <ContainerHeader icon title="列表" count={`${item.rows.length} 行`} />
      <ContainerRows item={item} size="md" />
    </Card>
  )
}
