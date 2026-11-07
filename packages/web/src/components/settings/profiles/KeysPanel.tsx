import { useState } from 'react'
import type { KeyStrategy, Profile, ProfileGroup, ProfileKey, ProfileKeyInput } from '@tandem/protocol'
import {
  Check,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  Power,
  PowerOff,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Wifi,
} from 'lucide-react'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store/useAppStore'
import { useUiStore } from '../../../store/useUiStore'
import type { HostConfig } from '../../../lib/types'
import { useNow } from '../../../lib/hooks'
import { cn } from '../../../lib/cn'
import { Button, IconButton } from '../../ui/Button'
import { SegmentedControl } from '../../ui/Controls'
import { Tooltip } from '../../ui/Tooltip'
import { groupInputOf, keyInputOf, keyStatus, profileInputOf } from './shared'

export function KeysPanel({
  host,
  profile,
  group,
}: {
  host: HostConfig
  profile: Profile
  group: ProfileGroup
}) {
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const toast = useUiStore((s) => s.toast)
  const now = useNow(true)
  const [busy, setBusy] = useState(false)
  const [tests, setTests] = useState<Record<string, { ok: boolean; error?: string }>>({})
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const save = async (keys: ProfileKeyInput[], strategy?: KeyStrategy) => {
    if (busy) return
    setBusy(true)
    try {
      const groups = (profile.groups ?? []).map((g) =>
        g.id === group.id
          ? {
              ...groupInputOf(g),
              apiKeys: keys,
              ...(strategy ? { keyStrategy: strategy } : {}),
            }
          : groupInputOf(g),
      )
      await api.updateProfile(host, profile.id, profileInputOf(profile, groups))
      await refreshProfiles(host.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新 Key 失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const addKey = async () => {
    const secret = value.trim()
    if (!secret) return
    await save([
      ...group.keys.map(keyInputOf),
      { apiKey: secret, ...(label.trim() ? { label: label.trim() } : {}) },
    ])
    setLabel('')
    setValue('')
    setShowValue(false)
    setAdding(false)
  }

  const toggleKey = (key: ProfileKey) =>
    void save(
      group.keys.map((k) =>
        k.id === key.id ? { id: k.id, ...(k.label ? { label: k.label } : {}), disabled: !k.disabled } : keyInputOf(k),
      ),
    )

  const removeKey = (key: ProfileKey) =>
    void save(group.keys.filter((k) => k.id !== key.id).map(keyInputOf))

  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = group.keys.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    void save(next.map(keyInputOf))
  }

  const testKey = async (key: ProfileKey) => {
    try {
      const res = await api.testProfile(host, profile.id, group.id, key.id)
      setTests((prev) => ({ ...prev, [key.id]: res }))
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [key.id]: { ok: false, error: err instanceof Error ? err.message : '测试失败' },
      }))
    }
  }

  return (
    <div className="mt-1 rounded-lg border border-border/70 bg-bg/30 p-1.5">
      <div className="flex flex-wrap items-center gap-1.5 px-0.5">
        <KeyRound size={11} className="shrink-0 text-text-tertiary" />
        <span className="shrink-0 text-[12px] text-muted">{group.keys.length} 个 Key</span>
        <SegmentedControl
          aria-label={`${group.name} 的 Key 调度策略`}
          size="sm"
          value={group.keyStrategy ?? 'failover'}
          onChange={(strategy) => void save(group.keys.map(keyInputOf), strategy)}
          options={[
            { value: 'failover', label: '故障切换', title: '按顺序故障切换' },
            { value: 'round_robin', label: '轮询' },
          ]}
        />
        <span className="flex-1" />
        <Button
          size="sm"
          onClick={() => setAdding((v) => !v)}
          disabled={busy}
          className="h-6 px-1.5 text-[12px]"
        >
          <Plus size={11} /> 添加 Key
        </Button>
      </div>

      <div className="mt-1 space-y-0.5">
        {group.keys.map((key, index) => {
          const status = keyStatus(key, now)
          const test = tests[key.id]
          const statusTip = key.lastError?.trim() || status.text
          return (
            <div
              key={key.id}
              draggable={!busy}
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) reorder(dragIndex, index)
                setDragIndex(null)
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-md bg-surface/70 px-1.5 py-1',
                dragIndex === index && 'opacity-50',
                busy && 'pointer-events-none opacity-60',
              )}
            >
              <GripVertical size={11} className="shrink-0 cursor-grab text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                {key.label?.trim() || 'Key'}
                <span className="ml-1.5 font-mono text-[12px] text-muted">{key.apiKeyMasked}</span>
              </span>
              {test && (
                <span
                  title={test.ok ? '测试通过' : test.error || '测试失败'}
                  className={cn('shrink-0', test.ok ? 'text-text-tertiary' : 'text-danger')}
                >
                  {test.ok ? <Check size={11} /> : <TriangleAlert size={11} />}
                </span>
              )}
              <Tooltip label={statusTip} className="shrink-0 text-[12px] leading-none">
                <span className={cn(status.tone, 'cursor-default')}>{status.text}</span>
              </Tooltip>
              <span className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  size="sm"
                  onClick={() => void testKey(key)}
                  label={`测试 Key ${key.label ?? key.apiKeyMasked}`}
                  tooltip="测试"
                  className="size-6 [&_svg]:size-3"
                >
                  <Wifi size={11} />
                </IconButton>
                <IconButton
                  size="sm"
                  onClick={() => void toggleKey(key)}
                  label={key.disabled ? '启用这个 Key' : '停用这个 Key'}
                  tooltip={key.disabled ? '启用' : '停用'}
                  className="size-6 [&_svg]:size-3"
                >
                  {key.disabled ? <Power size={11} /> : <PowerOff size={11} />}
                </IconButton>
                <IconButton
                  size="sm"
                  variant="danger-ghost"
                  onClick={() => void removeKey(key)}
                  label={`删除 Key ${key.label ?? key.apiKeyMasked}`}
                  tooltip="删除"
                  className="size-6 [&_svg]:size-3"
                >
                  <Trash2 size={11} />
                </IconButton>
              </span>
            </div>
          )
        })}
        {group.keys.length === 0 && (
          <p className="px-1 py-1 text-[12px] text-muted">还没有 Key，这个分组暂时不可用。</p>
        )}
      </div>

      {adding && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md bg-surface/70 p-1.5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="标签（如 主 / 备用）"
            className="h-7 w-28 rounded-md border border-border bg-bg px-1.5 text-[13px] outline-none focus:border-border-strong"
          />
          <div className="relative min-w-0 flex-1">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type={showValue ? 'text' : 'password'}
              placeholder="粘贴新 Key"
              spellCheck={false}
              autoComplete="off"
              className="h-7 w-full rounded-md border border-border bg-bg pl-1.5 pr-7 font-mono text-[13px] outline-none focus:border-border-strong"
            />
            <span className="absolute right-0.5 top-1/2 -translate-y-1/2">
              <IconButton
                size="sm"
                onClick={() => setShowValue((v) => !v)}
                label={showValue ? '隐藏 Key' : '显示 Key'}
                className="size-6 [&_svg]:size-3"
              >
                {showValue ? <EyeOff size={11} /> : <Eye size={11} />}
              </IconButton>
            </span>
          </div>
          <Button size="sm" variant="primary" onClick={() => void addKey()} disabled={!value.trim()}>
            保存
          </Button>
          <Button size="sm" onClick={() => setAdding(false)}>
            取消
          </Button>
          <span className="w-full px-0.5 text-[12px] text-muted">
            新 Key 只保存到 Host，界面只显示掩码。
          </span>
        </div>
      )}

      <p className="mt-1 px-0.5 text-[12px] text-muted">
        拖动 Key 调整顺序；故障切换按顺序优先使用，轮询在可用 Key 间轮流。
      </p>
    </div>
  )
}
