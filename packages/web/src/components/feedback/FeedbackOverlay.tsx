import type { RefObject } from 'react'
import { Download, ListChecks, Video, X } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Button, IconButton } from '../ui/Button'
import { Input, SegmentedControl } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { feedbackTypeLabel, type FeedbackItem, type FeedbackRect, type FeedbackSelectMode, type FeedbackVideo } from '../../lib/feedback'
import type { FeedbackTag } from '../../lib/feedbackFeatures'
import { SELECT_MODE_OPTIONS, UI_ATTR, type EditorState, type VerifyState } from './feedbackModeHelpers'

interface FeedbackOverlayProps {
  layerRef: RefObject<HTMLDivElement | null>
  items: FeedbackItem[]
  pendingFeature: FeedbackTag | null
  selectMode: FeedbackSelectMode
  onSelectModeChange: (mode: FeedbackSelectMode) => void
  editor: EditorState | null
  selected: FeedbackRect | null
  hover: { rect: FeedbackRect; label: string } | null
  regionBox: FeedbackRect | null
  focusRect: FeedbackRect | null
  verifyLive: { rect: FeedbackRect; found: boolean; region: boolean } | null
  badges: Array<{ item: FeedbackItem; index: number; left: number; top: number }>
  verify: VerifyState | null
  verifyEntry: VerifyState['queue'][number] | null
  onVerifyNote: (note: string) => void
  onAdvanceVerify: (result: 'pass' | 'fail' | 'skip') => void
  onCancelVerify: () => void
  onOpenItem: (item: FeedbackItem) => void
  onClearFeature: () => void
  canRecord: boolean
  recording: boolean
  recordSeconds: number
  onToggleRecord: () => void
  pendingVideo: FeedbackVideo | null
  onDiscardVideo: () => void
  regionBusy: boolean
  captureBusy: boolean
  onToggleDrawer: () => void
  onExport: () => void
  onExit: () => void
}

export function FeedbackOverlay({
  layerRef,
  items,
  pendingFeature,
  selectMode,
  onSelectModeChange,
  editor,
  selected,
  hover,
  regionBox,
  focusRect,
  verifyLive,
  badges,
  verify,
  verifyEntry,
  onVerifyNote,
  onAdvanceVerify,
  onCancelVerify,
  onOpenItem,
  onClearFeature,
  canRecord,
  recording,
  recordSeconds,
  onToggleRecord,
  pendingVideo,
  onDiscardVideo,
  regionBusy,
  captureBusy,
  onToggleDrawer,
  onExport,
  onExit,
}: FeedbackOverlayProps) {
  return (
    <>
          {/* 全屏透明捕获层：拦截应用的一切交互，反馈自身 UI 位于其上方 */}
          <div
            ref={layerRef}
            {...{ [UI_ATTR]: '', 'data-feedback-capture': '' }}
            className="pointer-events-auto fixed inset-0 z-[105] touch-none select-none"
            aria-hidden
          />

          {/* 高亮框与徽标层：pointer-events:none，不改变页面元素自身样式 */}
          <div
            {...{ [UI_ATTR]: '' }}
            className="pointer-events-none fixed inset-0 z-[110]"
            aria-hidden
          >
            {hover && !editor && !regionBox && (
              <div
                className="absolute rounded-[2px]"
                style={{
                  left: hover.rect.x,
                  top: hover.rect.y,
                  width: hover.rect.width,
                  height: hover.rect.height,
                  boxShadow: '0 0 0 2px #F97316',
                }}
              >
                <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-[#F97316] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                  {hover.label}
                </span>
              </div>
            )}
            {regionBox && (regionBox.width > 0 || regionBox.height > 0) && (
              <div
                className="absolute rounded-[2px] border-2 border-dashed border-[#F97316] bg-[#F97316]/10"
                style={{
                  left: regionBox.x,
                  top: regionBox.y,
                  width: regionBox.width,
                  height: regionBox.height,
                }}
              >
                <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-[#F97316] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                  框选 {Math.round(regionBox.width)}×{Math.round(regionBox.height)}
                </span>
              </div>
            )}
            {selected && editor && (
              <div
                className="absolute rounded-[2px]"
                style={{
                  left: selected.x,
                  top: selected.y,
                  width: selected.width,
                  height: selected.height,
                  boxShadow: '0 0 0 2px #F97316',
                }}
              />
            )}
            {focusRect && (
              <div
                className="absolute animate-pulse rounded-[2px] bg-[#F97316]/10"
                style={{
                  left: focusRect.x,
                  top: focusRect.y,
                  width: focusRect.width,
                  height: focusRect.height,
                  boxShadow: '0 0 0 3px #F97316, 0 0 0 8px rgba(249,115,22,.25)',
                }}
              />
            )}
            {verifyLive && (
              <div
                className="absolute rounded-[2px] bg-[#F97316]/10"
                style={{
                  left: verifyLive.rect.x,
                  top: verifyLive.rect.y,
                  width: verifyLive.rect.width,
                  height: verifyLive.rect.height,
                  boxShadow: verifyLive.found || verifyLive.region
                    ? '0 0 0 2px #F97316, 0 0 0 8px rgba(249,115,22,.22)'
                    : '0 0 0 2px #EF4444, 0 0 0 8px rgba(239,68,68,.18)',
                }}
              >
                <span
                  className={cn(
                    'absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-white',
                    verifyLive.found || verifyLive.region ? 'bg-[#F97316]' : 'bg-red-500',
                  )}
                >
                  {verifyLive.region
                    ? '框选区域（按记录位置定位）'
                    : verifyLive.found
                      ? '复验目标'
                      : '未找到元素（按记录位置定位）'}
                </span>
              </div>
            )}
            {!verify && badges.map(({ item, index, left, top }) => (
              <button data-raw-button
                key={item.id}
                {...{ [UI_ATTR]: '' }}
                type="button"
                onClick={() => onOpenItem(item)}
                className={cn(
                  'pointer-events-auto absolute flex size-5 items-center justify-center rounded-full border border-white/70 bg-[#F97316] text-[10px] font-semibold leading-none text-white shadow-sm',
                  'transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#F97316]',
                )}
                style={{ left, top }}
                data-tip={`${index + 1}. ${feedbackTypeLabel(item.type)}：${item.text}`}
                aria-label={`编辑第 ${index + 1} 条反馈`}
              >
                {index + 1}
              </button>
            ))}
          </div>

          {/* 顶部浮条 */}
          <div
            {...{ [UI_ATTR]: '' }}
            role="region"
            aria-label="反馈模式工具栏"
            className="pointer-events-auto fixed left-1/2 top-3 z-[130] w-max max-w-[calc(100vw-16px)] -translate-x-1/2 max-sm:top-[max(0.75rem,env(safe-area-inset-top))]"
          >
            <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-surface py-1 pl-3 pr-1.5 shadow-md">
              <span className="size-1.5 rounded-full bg-[#F97316]" />
              <span className="whitespace-nowrap text-[12.5px] font-medium text-text">
                反馈模式 · 已记录 {items.length} 条
              </span>
              {pendingFeature && (
                <span className="flex items-center gap-1 rounded-full bg-[#F97316]/12 px-2 py-0.5 text-[11px] text-[#F97316]">
                  标记：{pendingFeature.featureName}
                  <button data-raw-button
                    type="button"
                    aria-label="取消功能标记"
                    onClick={onClearFeature}
                    className="rounded-full hover:bg-[#F97316]/20"
                  >
                    <X size={10} />
                  </button>
                </span>
              )}
              <span className="h-4 w-px bg-border" />
              <SegmentedControl
                size="sm"
                options={SELECT_MODE_OPTIONS}
                value={selectMode}
                onChange={onSelectModeChange}
                aria-label="选择方式"
              />
              <Button
                size="sm"
                variant="secondary"
                icon={<ListChecks size={13} />}
                onClick={onToggleDrawer}
              >
                条目 {items.length}
              </Button>
              {canRecord && (
                <Button
                  size="sm"
                  variant={recording ? 'danger-ghost' : 'ghost'}
                  icon={<Video size={13} />}
                  onClick={onToggleRecord}
                  tooltip={recording ? '停止录制并附加到下一条反馈' : '录制复现（仅本地，最长 60 秒）'}
                >
                  {recording ? `停止 ${recordSeconds}s` : '录制'}
                </Button>
              )}
              {pendingVideo && (
                <span className="flex items-center gap-1 rounded-full bg-[#F97316]/12 px-2 py-0.5 text-[10.5px] text-[#F97316]">
                  录屏待附加
                  <button data-raw-button
                    type="button"
                    aria-label="丢弃录屏"
                    onClick={onDiscardVideo}
                    className="rounded-full hover:bg-[#F97316]/20"
                  >
                    <X size={10} />
                  </button>
                </span>
              )}
              {(regionBusy || captureBusy) && (
                <span className="flex items-center gap-1 text-[10.5px] text-muted" role="status" aria-live="polite">
                  <Spinner size={11} /> {regionBusy ? '截取区域' : '截图'}
                </span>
              )}
              <span className="h-4 w-px bg-border" />
              <Button
                size="sm"
                variant="secondary"
                icon={<Download size={13} />}
                onClick={onExport}
                tooltip="导出 .tfb 包（zip 容器，改扩展名即可解压查看）"
              >
                导出
              </Button>
              <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onExit}>
                退出
              </Button>
            </div>
          </div>

          {/* 复验操作条 */}
          {verify && verifyEntry && (
            <div
              {...{ [UI_ATTR]: '' }}
              className="pointer-events-auto fixed bottom-4 left-1/2 z-[130] w-[min(560px,calc(100vw-16px))] -translate-x-1/2 rounded-xl border border-border bg-surface p-2.5 shadow-lg"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-[#F97316]/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-[#F97316]">
                  复验 {verify.index + 1}/{verify.queue.length}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text" data-tip={verifyEntry.item.text}>
                  {verifyEntry.item.text}
                </span>
                <IconButton label="退出复验" size="sm" onClick={onCancelVerify}>
                  <X size={13} />
                </IconButton>
              </div>
              {verifyLive && !verifyLive.found && !verifyLive.region && (
                <p className="mt-1 text-[10px] text-red-500">
                  当前页面没有找到对应元素，已按记录的位置高亮；可能已被修复或移走。
                </p>
              )}
              <div className="mt-1.5 flex items-center gap-1.5">
                <Input
                  size="sm"
                  value={verify.note}
                  onChange={(e) => onVerifyNote(e.target.value)}
                  placeholder="复验备注（可选，例如仍复现的细节）"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) onAdvanceVerify('pass')
                  }}
                />
                <Button size="sm" variant="primary" onClick={() => onAdvanceVerify('pass')}>
                  通过
                </Button>
                <Button size="sm" variant="danger-ghost" onClick={() => onAdvanceVerify('fail')}>
                  仍有问题
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onAdvanceVerify('skip')}>
                  跳过
                </Button>
              </div>
            </div>
          )}
    </>
  )
}
