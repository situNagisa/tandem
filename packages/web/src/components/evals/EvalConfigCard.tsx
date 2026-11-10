import { SlidersHorizontal, Trash2 } from 'lucide-react'
import type { EvalConfig, Profile, ReasoningEffort } from '@tandem/protocol'
import { Button, IconButton } from '../ui/Button'
import { Input, Select } from '../ui/Controls'
import { DELEGATION_META, DELEGATION_ORDER } from '../../lib/routeLabels'

const EFFORTS: Array<{ value: string; label: string }> = [
  { value: '', label: '默认思考强度' },
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最大' },
]

export function EvalConfigCard({
  config,
  profiles,
  canRemove,
  onChange,
  onRemove,
  onEditPrompts,
}: {
  config: EvalConfig
  profiles: Profile[]
  canRemove: boolean
  onChange: (next: EvalConfig) => void
  onRemove: () => void
  onEditPrompts: () => void
}) {
  const profile = profiles.find((item) => item.id === config.profileId)
  const groups = profile?.groups ?? []
  const group = groups.find((item) => item.id === config.groupId)
  const models = group?.models.length ? group.models : profile?.models ?? []
  const modelOptions = models.includes(config.model) ? models : [config.model, ...models]
  const overrideCount = Object.keys(config.promptOverrides ?? {}).length

  const switchProfile = (profileId: string) => {
    const next = profiles.find((item) => item.id === profileId)
    if (!next) return
    const firstGroup = next.groups?.[0]
    onChange({
      ...config,
      profileId,
      ...(firstGroup ? { groupId: firstGroup.id } : { groupId: undefined }),
      model: firstGroup?.defaultModel || next.defaultModel || firstGroup?.models[0] || next.models[0] || '',
    })
  }

  return (
    <div className="rounded-xl border border-border bg-bg/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Input
          value={config.name}
          onChange={(event) => onChange({ ...config, name: event.target.value })}
          placeholder="配置名称"
          aria-label="配置名称"
          className="h-7 border-transparent bg-transparent px-1 font-medium"
        />
        <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] text-muted">
          {config.model || '未选模型'}
        </span>
        {canRemove && (
          <IconButton size="sm" label="删除配置" onClick={onRemove} className="size-7!">
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
          账号
          <Select
            value={config.profileId}
            onChange={(event) => switchProfile(event.target.value)}
            aria-label="评测账号"
            size="sm"
          >
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </label>
        {groups.length > 0 && (
          <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
            分组
            <Select
              value={config.groupId ?? groups[0]?.id ?? ''}
              onChange={(event) => {
                const next = groups.find((item) => item.id === event.target.value)
                onChange({
                  ...config,
                  groupId: next?.id,
                  model: next?.defaultModel || next?.models[0] || config.model,
                })
              }}
              aria-label="评测分组"
              size="sm"
            >
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
          模型
          <Select
            value={config.model}
            onChange={(event) => onChange({ ...config, model: event.target.value })}
            aria-label="评测模型"
            size="sm"
          >
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
          思考强度
          <Select
            value={config.effort ?? ''}
            onChange={(event) =>
              onChange({
                ...config,
                effort: (event.target.value || undefined) as ReasoningEffort | undefined,
              })
            }
            aria-label="思考强度"
            size="sm"
          >
            {EFFORTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted">
          分工
          <Select
            value={config.delegation ?? ''}
            onChange={(event) =>
              onChange({
                ...config,
                delegation: (event.target.value || undefined) as EvalConfig['delegation'],
              })
            }
            aria-label="分工"
            size="sm"
          >
            <option value="">默认分工</option>
            {DELEGATION_ORDER.map((value) => (
              <option key={value} value={value}>
                {DELEGATION_META[value].longLabel}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon={<SlidersHorizontal size={12} />}
          onClick={onEditPrompts}
          className="h-7 px-1.5 text-[12px]"
        >
          提示词覆盖{overrideCount > 0 ? `（${overrideCount}）` : ''}
        </Button>
        {group && <span className="truncate text-[12px] text-muted">分组：{group.name}</span>}
      </div>
    </div>
  )
}
