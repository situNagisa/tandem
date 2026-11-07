import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import type { PromptTemplate, PromptTemplateKey } from '@tandem/protocol'
import { Button, IconButton } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { MenuSelect } from '../ui/Menu'
import { Textarea } from '../ui/Controls'

/** 提示词临时覆盖：只写入本次评测配置，不修改全局提示词。 */
export function EvalPromptOverridesDialog({
  open,
  onClose,
  templates,
  value,
  onChange,
}: {
  open: boolean
  onClose: () => void
  templates: PromptTemplate[]
  value: Partial<Record<PromptTemplateKey, string>>
  onChange: (next: Partial<Record<PromptTemplateKey, string>>) => void
}) {
  const editable = useMemo(() => templates.filter((template) => template.editable), [templates])
  const [key, setKey] = useState<PromptTemplateKey | ''>('')
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!open) return
    const first = editable[0]?.key ?? ''
    const next = (Object.keys(value)[0] as PromptTemplateKey | undefined) ?? first
    setKey(next || '')
    const template = editable.find((item) => item.key === next)
    setDraft(value[next as PromptTemplateKey] ?? template?.text ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const template = editable.find((item) => item.key === key)
  const overridden = key ? value[key as PromptTemplateKey] : undefined
  const options = editable.map((item) => ({
    value: item.key,
    label: item.label,
    hint: value[item.key] ? '已覆盖' : undefined,
  }))

  const pick = (next: PromptTemplateKey) => {
    setKey(next)
    const found = editable.find((item) => item.key === next)
    setDraft(value[next] ?? found?.text ?? '')
  }

  const apply = () => {
    if (!key) return
    const next = { ...value }
    if (!draft.trim() || draft === template?.text) delete next[key as PromptTemplateKey]
    else next[key as PromptTemplateKey] = draft
    onChange(next)
  }

  const remove = (removeKey: PromptTemplateKey) => {
    const next = { ...value }
    delete next[removeKey]
    onChange(next)
    if (key === removeKey) {
      const found = editable.find((item) => item.key === removeKey)
      setDraft(found?.text ?? '')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="提示词覆盖"
      layer={70}
      title="提示词覆盖（仅本评测配置）"
      description="从提示词注册表挑选并临时修改；不会写入全局提示词设置。"
      className="h-[min(84dvh,800px)] w-[min(94vw,860px)] max-w-none"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      footer={
        <>
          <Button size="lg" onClick={onClose}>
            完成
          </Button>
          <Button size="lg" variant="primary" onClick={apply} disabled={!key}>
            应用覆盖
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[12px] text-muted">提示词</span>
          <MenuSelect
            value={(key || '') as PromptTemplateKey}
            onChange={(next) => pick(next as PromptTemplateKey)}
            options={options}
            size="sm"
            placeholder="选择提示词"
            wrapperClassName="min-w-0 flex-1"
            aria-label="选择提示词"
          />
        </div>
        {template && (
          <>
            <p className="text-[12px] leading-5 text-muted">{template.description}</p>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[240px] flex-1 font-mono text-[12px] leading-5"
              aria-label="覆盖文本"
            />
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <span>来源：{template.source === 'builtin' ? '内置默认' : template.source === 'project' ? '项目覆盖' : '用户自定义'}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={<RotateCcw size={12} />}
                onClick={() => setDraft(template.text)}
              >
                恢复当前生效文本
              </Button>
              {overridden && (
                <Button
                  size="sm"
                  variant="danger-ghost"
                  icon={<Trash2 size={12} />}
                  onClick={() => remove(template.key)}
                >
                  移除覆盖
                </Button>
              )}
            </div>
          </>
        )}
        <div className="mt-auto border-t border-border pt-3">
          <div className="mb-1.5 text-[12px] font-medium text-text-secondary">
            已覆盖 {Object.keys(value).length} 项
          </div>
          {Object.keys(value).length === 0 ? (
            <p className="text-[12px] text-muted">还没有覆盖项。</p>
          ) : (
            <div className="space-y-1">
              {(Object.keys(value) as PromptTemplateKey[]).map((itemKey) => {
                const found = editable.find((item) => item.key === itemKey)
                return (
                  <div
                    key={itemKey}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px]"
                  >
                    <span className="min-w-0 flex-1 truncate text-text">{found?.label ?? itemKey}</span>
                    <span className="shrink-0 text-muted">{value[itemKey]?.length ?? 0} 字</span>
                    <IconButton
                      size="sm"
                      label="移除覆盖"
                      onClick={() => remove(itemKey)}
                      className="size-6!"
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
