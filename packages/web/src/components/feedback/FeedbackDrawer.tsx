import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  CircleAlert,
  Download,
  FileCheck2,
  GripVertical,
  ImagePlus,
  ListChecks,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  parseFeedbackReceipt,
  receiptStatusLabel,
  type FeedbackItem,
  type FeedbackReceipt,
  type FeedbackReceiptItem,
} from '../../lib/feedback'
import { Button, IconButton } from '../ui/Button'
import { Switch } from '../ui/Controls'

export interface SnapshotPrefs {
  includeMessages: boolean
  hidePaths: boolean
}

function thumbOf(item: FeedbackItem): string | undefined {
  return item.annotatedScreenshot ?? item.screenshot
}

function BeforeAfter({ before, after }: { before: string; after: string }) {
  const [percent, setPercent] = useState(50)
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef(false)

  const update = (clientX: number) => {
    const box = boxRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    setPercent(Math.min(100, Math.max(0, ((clientX - rect.left) / Math.max(1, rect.width)) * 100)))
  }

  return (
    <div className="mt-2">
      <div
        ref={boxRef}
        className="relative h-[150px] w-full touch-none overflow-hidden rounded-md border border-border bg-black/20 select-none"
        onPointerDown={(e) => {
          dragRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          update(e.clientX)
        }}
        onPointerMove={(e) => dragRef.current && update(e.clientX)}
        onPointerUp={() => {
          dragRef.current = false
        }}
        onPointerCancel={() => {
          dragRef.current = false
        }}
      >
        <img src={before} alt="修复前" className="absolute inset-0 size-full object-contain" draggable={false} />
        <div className="absolute inset-0 overflow-hidden" style={{ width: `${percent}%` }}>
          <img
            src={after}
            alt="修复后"
            className="absolute inset-0 h-full object-contain"
            style={{ width: boxRef.current?.clientWidth ?? '100%', maxWidth: 'none' }}
            draggable={false}
          />
        </div>
        <div
          className="absolute inset-y-0 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35)]"
          style={{ left: `${percent}%` }}
        >
          <span className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#F97316]" />
        </div>
        <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">前</span>
        <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">后</span>
      </div>
    </div>
  )
}

function ReceiptRow({
  receiptItem,
  item,
}: {
  receiptItem: FeedbackReceiptItem
  item: FeedbackItem
}) {
  const before = item.annotatedScreenshot ?? item.screenshot
  return (
    <div className="mt-1.5 rounded-md border border-border bg-surface-2/60 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[12px]">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 font-medium',
            receiptItem.status === 'fixed'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : receiptItem.status === 'wontfix'
                ? 'bg-zinc-500/15 text-muted'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
          )}
        >
          {receiptStatusLabel(receiptItem.status)}
        </span>
        {receiptItem.verification && (
          <span
            className={cn(
              'flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium',
              receiptItem.verification.result === 'pass'
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-red-500/15 text-red-600 dark:text-red-400',
            )}
          >
            {receiptItem.verification.result === 'pass' ? <Check size={10} /> : <CircleAlert size={10} />}
            {receiptItem.verification.result === 'pass' ? '复验通过' : '仍有问题'}
          </span>
        )}
      </div>
      {receiptItem.note && <p className="mt-1 whitespace-pre-wrap text-[12px] leading-4 text-text-soft">{receiptItem.note}</p>}
      {receiptItem.verification?.note && (
        <p className="mt-0.5 whitespace-pre-wrap text-[10.5px] leading-4 text-muted">复验备注：{receiptItem.verification.note}</p>
      )}
      {before && receiptItem.afterImage && <BeforeAfter before={before} after={receiptItem.afterImage} />}
    </div>
  )
}

export function FeedbackDrawer({
  open,
  items,
  receipt,
  prefs,
  onPrefsChange,
  onClose,
  onEdit,
  onDelete,
  onMove,
  onHighlight,
  onAnnotate,
  onImportReceipt,
  onClearReceipt,
  onVerify,
  onExportVerification,
}: {
  open: boolean
  items: FeedbackItem[]
  receipt: FeedbackReceipt | null
  prefs: SnapshotPrefs
  onPrefsChange: (next: SnapshotPrefs) => void
  onClose: () => void
  onEdit: (item: FeedbackItem) => void
  onDelete: (id: string) => void
  onMove: (from: number, to: number) => void
  onHighlight: (item: FeedbackItem) => void
  onAnnotate: (item: FeedbackItem) => void
  onImportReceipt: (receipt: FeedbackReceipt) => void
  onClearReceipt: () => void
  onVerify: () => void
  onExportVerification: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  if (!open) return null

  const receiptMap = new Map((receipt?.items ?? []).map((entry) => [entry.id, entry]))
  const matched = items.filter((item) => receiptMap.has(item.id)).length
  const verified = receipt?.items.filter((entry) => entry.verification).length ?? 0

  return createPortal(
    <aside
      data-feedback-ui=""
      className="pointer-events-auto fixed bottom-0 right-0 top-0 z-[135] flex w-[min(400px,100vw)] flex-col border-l border-border bg-surface shadow-2xl"
      aria-label="反馈条目"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <ListChecks size={15} className="text-[#F97316]" />
        <span className="text-[13px] font-semibold text-text">反馈条目 · {items.length}</span>
        <span className="ml-auto" />
        <IconButton label="导入回执" size="sm" onClick={() => inputRef.current?.click()}>
          <FileCheck2 size={14} />
        </IconButton>
        <IconButton label="关闭条目列表" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            const parsed = parseFeedbackReceipt(await file.text())
            if (!parsed) {
              setImportError('回执文件格式不正确')
              return
            }
            setImportError(null)
            onImportReceipt(parsed)
          }}
        />
      </div>

      {receipt && (
        <div className="border-b border-border bg-surface-2/50 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[12px] text-text-soft">
            <FileCheck2 size={12} className="text-[#F97316]" />
            <span className="min-w-0 flex-1 truncate" data-tip={receipt.sourceFile}>
              回执：{receipt.sourceFile || '未命名'}
            </span>
            <span className="text-muted">
              匹配 {matched}/{receipt.items.length}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button size="sm" variant="primary" icon={<Check size={12} />} onClick={onVerify} disabled={matched === 0}>
              开始复验
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Download size={12} />}
              onClick={onExportVerification}
              disabled={verified === 0}
            >
              导出复验结果{verified ? `（${verified}）` : ''}
            </Button>
            <Button size="sm" variant="danger-ghost" onClick={onClearReceipt} className="ml-auto">
              移除回执
            </Button>
          </div>
          {importError && <p className="mt-1 text-[10.5px] text-danger">{importError}</p>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {items.length === 0 && (
          <p className="px-2 py-8 text-center text-[12px] text-muted">
            还没有条目。回到页面点选元素或框选区域开始记录。
          </p>
        )}
        {items.map((item, index) => {
          const receiptItem = receiptMap.get(item.id)
          const thumb = thumbOf(item)
          return (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => {
                setDragIndex(index)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIndex !== null) onMove(dragIndex, index)
                setDragIndex(null)
              }}
              onDragEnd={() => setDragIndex(null)}
              className={cn(
                'group mb-1.5 rounded-lg border border-border bg-surface p-1.5 transition-colors hover:border-border-strong',
                dragIndex === index && 'opacity-60',
              )}
            >
              <div className="flex items-start gap-1.5">
                <span className="mt-0.5 flex w-4 shrink-0 items-center justify-center text-[10px] font-semibold text-muted">
                  {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() => onAnnotate(item)}
                  data-tip="标注截图"
                  className="relative size-14 shrink-0 overflow-hidden rounded border border-border bg-black/10"
                >
                  {thumb ? (
                    <img src={thumb} alt="" className="size-full object-cover" draggable={false} />
                  ) : (
                    <ImagePlus size={16} className="m-auto text-muted" />
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[9px] text-white">
                    标注
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="rounded bg-surface-2 px-1 py-0.5 text-[9.5px] text-text-soft">
                      {item.type === 'issue' ? '问题' : item.type === 'suggestion' ? '建议' : '好评'}
                    </span>
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[9.5px] font-semibold',
                        (item.priority ?? 'P1') === 'P0'
                          ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                          : (item.priority ?? 'P1') === 'P1'
                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                            : 'bg-surface-2 text-muted',
                      )}
                    >
                      {item.priority ?? 'P1'}
                    </span>
                    {item.mode === 'region' && (
                      <span className="rounded bg-surface-2 px-1 py-0.5 text-[9.5px] text-muted">框选</span>
                    )}
                    {item.featureName && (
                      <span
                        className="rounded bg-[#F97316]/12 px-1 py-0.5 text-[9.5px] text-[#F97316]"
                        data-tip={`功能：${item.featureName}`}
                      >
                        {item.featureName}
                      </span>
                    )}
                    {item.causeId && (
                      <span
                        className="rounded bg-surface-2 px-1 py-0.5 text-[9.5px] text-text-soft"
                        data-tip={item.causeTitle ?? '根因建议'}
                      >
                        {item.causeId}
                      </span>
                    )}
                    {item.trace?.length ? (
                      <span className="rounded bg-surface-2 px-1 py-0.5 text-[9.5px] text-muted">轨迹 {item.trace.length}</span>
                    ) : null}
                    {item.video && <span className="rounded bg-surface-2 px-1 py-0.5 text-[9.5px] text-muted">录屏</span>}
                    {item.references?.length ? (
                      <span className="rounded bg-surface-2 px-1 py-0.5 text-[9.5px] text-muted">参考 {item.references.length}</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => onHighlight(item)}
                    className="mt-0.5 line-clamp-2 w-full text-left text-[12px] leading-4 text-text hover:text-[#F97316]"
                    data-tip="在页面上定位"
                  >
                    {item.text}
                  </button>
                  <div className="mt-0.5 flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onHighlight(item)}
                      className="rounded px-1 py-0.5 text-[9.5px] text-muted hover:bg-surface-2 hover:text-text"
                    >
                      定位
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(item)}
                      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9.5px] text-muted hover:bg-surface-2 hover:text-text"
                    >
                      <Pencil size={9} /> 编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(item.id)}
                      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9.5px] text-muted hover:bg-surface-2 hover:text-danger"
                    >
                      <Trash2 size={9} /> 删除
                    </button>
                    <span className="ml-auto cursor-grab text-muted" data-tip="拖拽排序">
                      <GripVertical size={12} />
                    </span>
                  </div>
                </div>
              </div>
              {receiptItem && <ReceiptRow receiptItem={receiptItem} item={item} />}
              {item.references?.length ? (
                <div className="mt-1 flex gap-1 overflow-x-auto pl-5">
                  {item.references.map((reference) => (
                    <img
                      key={reference.id}
                      src={reference.dataURL}
                      alt={reference.name}
                      data-tip={`参考图：${reference.name}`}
                      className="h-10 w-14 shrink-0 rounded border border-border object-cover"
                      draggable={false}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="border-t border-border px-3 py-2.5">
        <p className="mb-1.5 text-[12px] font-medium text-text-soft">状态快照（每条反馈附带）</p>
        <label className="flex items-center justify-between gap-2 py-1 text-[12px] text-text">
          <span>隐藏本地路径</span>
          <Switch
            checked={prefs.hidePaths}
            onChange={(checked) => onPrefsChange({ ...prefs, hidePaths: checked })}
            label="隐藏本地路径"
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-1 text-[12px] text-text">
          <span>附带最近 5 条消息正文</span>
          <Switch
            checked={prefs.includeMessages}
            onChange={(checked) => onPrefsChange({ ...prefs, includeMessages: checked })}
            label="附带最近 5 条消息正文"
          />
        </label>
        <p className="mt-1 text-[9.5px] leading-4 text-muted">
          快照只含路由、会话摘要、UI 偏好、视口与主机版本，绝不包含密钥、token 或配置文件内容。
        </p>
      </div>
    </aside>,
    document.body,
  )
}
