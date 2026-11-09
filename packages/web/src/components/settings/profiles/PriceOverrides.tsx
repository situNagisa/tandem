import { useState } from 'react'
import { X } from 'lucide-react'
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
              <button
                onClick={() => {
                  const next = { ...price }
                  delete next[id]
                  onChange(next)
                }}
                aria-label={`删除 ${id} 单价`}
                className="flex size-5 items-center justify-center rounded text-muted hover:text-danger"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          list="tandem-price-models"
          placeholder={candidates[0] ?? '模型 ID'}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded border border-border bg-surface px-1.5 font-mono text-[13px] text-text outline-none focus:border-border-strong"
        />
        <datalist id="tandem-price-models">
          {candidates.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button
          onClick={add}
          disabled={!model.trim()}
          className="h-6 shrink-0 rounded border border-border px-1.5 text-[13px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-40"
        >
          添加
        </button>
      </div>
    </div>
  )
}

