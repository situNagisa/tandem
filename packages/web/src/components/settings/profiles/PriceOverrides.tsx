import { useState } from 'react'
import { X } from 'lucide-react'
import { Combobox } from '../../ui/Combobox'
import { Button, IconButton } from '../../ui/Button'
import type { PriceMap } from './shared'

export function PriceOverrides({
  models,
  price,
  onChange,
}: {
  models: string[]
  price: PriceMap
  onChange: (next: PriceMap) => void
}) {
  const [model, setModel] = useState('')
  const candidates = models.filter((id) => !price[id])
  const add = () => {
    const id = model.trim()
    if (!id) return
    onChange({ ...price, [id]: { input: 3, output: 15 } })
    setModel('')
  }
  const update = (id: string, key: 'input' | 'output', value: string) => {
    const n = Number(value)
    onChange({ ...price, [id]: { ...price[id], [key]: Number.isFinite(n) && n >= 0 ? n : 0 } })
  }
  return (
    <div className="mt-3 rounded-lg border border-border bg-bg/40 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-medium text-text-soft">自定义单价</span>
        <span className="text-[13px] text-muted">每百万 token 美元，覆盖内置参考价</span>
      </div>
      {Object.keys(price).length > 0 && (
        <div className="mt-1.5 space-y-1">
          {Object.entries(price).map(([id, value]) => (
            <div key={id} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-soft" data-tip={id}>
                {id}
              </span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={value.input}
                onChange={(e) => update(id, 'input', e.target.value)}
                aria-label={`${id} 输入单价`}
                className="h-6 w-14 rounded border border-border bg-surface px-1 text-right font-mono text-[13px] outline-none focus:border-border-strong"
              />
              <span className="text-[13px] text-muted">in</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={value.output}
                onChange={(e) => update(id, 'output', e.target.value)}
                aria-label={`${id} 输出单价`}
                className="h-6 w-14 rounded border border-border bg-surface px-1 text-right font-mono text-[13px] outline-none focus:border-border-strong"
              />
              <span className="text-[13px] text-muted">out</span>
              <IconButton
                size="inline"
                variant="danger-ghost"
                label={`删除 ${id} 单价`}
                className="size-5 [&_svg]:size-[10px]"
                onClick={() => {
                  const next = { ...price }
                  delete next[id]
                  onChange(next)
                }}
              >
                <X size={10} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <Combobox
          value={model}
          onChange={setModel}
          options={candidates}
          placeholder={candidates[0] ?? '模型 ID'}
          aria-label="自定义单价模型"
          size="sm"
          onSubmit={add}
          className="h-6 flex-1 font-mono text-[13px]"
        />
        <Button size="inline" variant="secondary" onClick={add} disabled={!model.trim()}>
          添加
        </Button>
      </div>
    </div>
  )
}

