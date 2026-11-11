import { useState } from 'react'
import type { Profile, ProfileGroup, ProfileInput, ProfileKey, ProfileKeyInput } from '@tandem/protocol'
import { Check, Eye, EyeOff, KeyRound, Trash2, TriangleAlert, Wifi } from 'lucide-react'
import { useUiStore } from '../../../store/useUiStore'
import { useNow } from '../../../lib/hooks'
import { cn } from '../../../lib/cn'
import { Button, IconButton } from '../../ui/Button'
import { Tooltip } from '../../ui/Tooltip'
import { groupInputOf, keyInputOf, keyStatus, profileInputOf } from './shared'

/**
 * 分组 Key：每个分组只显示一个 Key（反馈1323#02）。
 * 旧数据里一个分组有多个 Key 时只显示第一个可用的那个；保存只改这一个，
 * 其余 Key 原样回传（服务端按 id 保留），不显示也不删除。
 */
export function KeysPanel({
  profile,
  group,
  saveProfile,
  testProfile,
}: {
  profile: Profile
  group: ProfileGroup
  /** 工作站模式走账号级 API，本地模式走主机 API（由设置页决定）。 */
  saveProfile: (input: ProfileInput) => Promise<unknown>
  testProfile: (groupId: string, keyId?: string) => Promise<{ ok: boolean; error?: string }>
}) {
  const toast = useUiStore((s) => s.toast)
  const now = useNow(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; error?: string } | null>(null)

  const shown: ProfileKey | undefined = group.keys.find((key) => !key.disabled) ?? group.keys[0]
  const status = shown ? keyStatus(shown, now) : null

  /** 只替换/删除当前显示的 Key；其余（旧数据的隐藏 Key）原样保留。 */
  const save = async (next: ProfileKeyInput | null) => {
    if (busy) return
    setBusy(true)
    try {
      const rest = group.keys.filter((key) => key.id !== shown?.id).map(keyInputOf)
      const apiKeys = next ? [next, ...rest] : rest
      const groups = (profile.groups ?? []).map((item) =>
        item.id === group.id ? { ...groupInputOf(item), apiKeys } : groupInputOf(item),
      )
      await saveProfile(profileInputOf(profile, groups))
      setEditing(false)
      setValue('')
      setShowValue(false)
      setTest(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新 Key 失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const replace = () => {
    const secret = value.trim()
    if (!secret) return
    void save({
      ...(shown?.id ? { id: shown.id } : {}),
      ...(shown?.label ? { label: shown.label } : {}),
      apiKey: secret,
    })
  }

  const runTest = async (key: ProfileKey) => {
    try {
      setTest(await testProfile(group.id, key.id))
    } catch (err) {
      setTest({ ok: false, error: err instanceof Error ? err.message : '测试失败' })
    }
  }

  if (editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5" data-group-key={group.id}>
        <KeyRound size={12} className="shrink-0 text-text-tertiary" />
        <div className="relative min-w-0 flex-1">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                replace()
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            type={showValue ? 'text' : 'password'}
            placeholder={shown ? '粘贴新的 Key' : '粘贴 Key'}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            data-key-input=""
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
        <Button size="inline" variant="primary" onClick={replace} disabled={!value.trim() || busy}>
          保存
        </Button>
        <Button
          size="inline"
          onClick={() => {
            setEditing(false)
            setValue('')
          }}
        >
          取消
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5" data-group-key={group.id}>
      <KeyRound size={12} className="shrink-0 text-text-tertiary" />
      {shown ? (
        <>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-soft"
            data-key-masked={shown.apiKeyMasked}
            data-tip={shown.label?.trim() || undefined}
          >
            {shown.apiKeyMasked || '已保存'}
          </span>
          {test && (
            <span
              data-tip={test.ok ? '测试通过' : test.error || '测试失败'}
              className={cn('shrink-0', test.ok ? 'text-text-tertiary' : 'text-danger')}
            >
              {test.ok ? <Check size={11} /> : <TriangleAlert size={11} />}
            </span>
          )}
          <Tooltip
            label={shown.lastError?.trim() || status?.text || ''}
            className={cn('shrink-0 text-[12px] leading-none', status?.tone)}
          >
            <span className="cursor-default" data-key-status="">
              {status?.text}
            </span>
          </Tooltip>
          <span className="flex shrink-0 items-center gap-0.5">
            <IconButton
              size="sm"
              onClick={() => void runTest(shown)}
              label="测试 Key"
              tooltip="测试"
              className="size-6 [&_svg]:size-3"
            >
              <Wifi size={11} />
            </IconButton>
            <Button
              size="inline"
              variant="ghost"
              onClick={() => {
                setEditing(true)
                setValue('')
                setShowValue(false)
              }}
              disabled={busy}
              data-key-replace=""
              className="h-6 px-1.5 text-[12px]"
            >
              更换
            </Button>
            <IconButton
              size="sm"
              variant="danger-ghost"
              onClick={() => void save(null)}
              label="删除 Key"
              tooltip="删除"
              disabled={busy}
              data-key-delete=""
              className="size-6 [&_svg]:size-3"
            >
              <Trash2 size={11} />
            </IconButton>
          </span>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">还没有 Key，分组不可用</span>
          <Button
            size="inline"
            onClick={() => {
              setEditing(true)
              setValue('')
            }}
            data-key-replace=""
            className="h-6 px-1.5 text-[12px]"
          >
            设置 Key
          </Button>
        </>
      )}
    </div>
  )
}
