import type { ReactNode } from 'react'
import { FileText, Loader2, Terminal } from 'lucide-react'
import { cn } from '../../lib/cn'
import { MenuItem, MenuList } from '../ui/Menu'
import { popoverSurfaceClass } from '../ui/Popover'
import type { Completion, CompletionEntry } from './completion'

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="chat-match">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}


export function CompletionMenu({
  completion,
  items,
  index,
  loading,
  onIndex,
  onSelect,
}: {
  completion: Completion
  items: CompletionEntry[]
  index: number
  loading: boolean
  onIndex: (i: number) => void
  onSelect: (item: CompletionEntry) => void
}) {
  let emptyText: ReactNode = '没有匹配项'
  if (completion.kind === 'slash' && loading) emptyText = '加载命令…'
  else if (completion.kind === 'file' && loading) emptyText = '搜索文件…'
  else if (completion.kind === 'slash') emptyText = '没有匹配的命令'
  else if (completion.kind === 'file') emptyText = completion.query ? '没有匹配的文件' : '输入文件名或目录以搜索'

  return (
    <div className="absolute inset-x-0 bottom-full z-40 mb-2">
      <div
        className={cn(popoverSurfaceClass, 'completion-panel relative w-[600px] max-w-full')}
        data-side="top"
        data-align="left"
      >
        <MenuList
          aria-label="补全"
          activeIndex={items.length ? index : undefined}
          onActiveIndexChange={onIndex}
          keyboard={false}
          className="max-h-[232px] overflow-y-auto"
        >
          {loading && items.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> {emptyText}
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="px-2 py-2 text-[12px] text-muted">{emptyText}</div>
          )}
          {items.map((item) => {
            const isDir = item.kind === 'file' && item.label.endsWith('/')
            const clean = isDir ? item.label.slice(0, -1) : item.label
            const cut = item.kind === 'file' ? clean.lastIndexOf('/') : -1
            const name = cut < 0 ? item.label : clean.slice(cut + 1) + (isDir ? '/' : '')
            const dir = cut < 0 ? '' : clean.slice(0, cut + 1)
            return (
              <MenuItem
                key={`${item.kind}:${item.value}`}
                icon={
                  item.kind === 'slash' ? (
                    <Terminal size={12} className="text-muted" />
                  ) : (
                    <FileText size={12} className="text-muted" />
                  )
                }
                hint={item.kind === 'slash' ? item.description || '无说明' : item.label}
                trailing={item.badge && item.badge !== '内置' ? item.badge : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onSelect={() => onSelect(item)}
              >
                <span className="font-mono text-[13px]">
                  {item.kind === 'file' ? (
                    <>
                      <Highlight text={name} query={completion.query} />
                      {dir && (
                        <span className="ml-1.5 text-[11.5px] text-muted">
                          <Highlight text={dir} query={completion.query} />
                        </span>
                      )}
                    </>
                  ) : (
                    <Highlight text={item.label} query={completion.query} />
                  )}
                </span>
              </MenuItem>
            )
          })}
        </MenuList>
      </div>
    </div>
  )
}

