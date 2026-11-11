import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { SlashCommand } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useClickOutside } from '../../lib/hooks'
import { detectCompletion, type Completion, type CompletionEntry } from './completion'
import type { ComposerEditorHandle } from './ComposerEditor'
import { registerToken } from './richEditor'
import { SOURCE_LABEL } from './composerTypes'

interface Options {
  effectiveHostId: string | null | undefined
  cwd: string | undefined
  commands: SlashCommand[]
  commandsLoaded: boolean
  refreshCommands: (hostId: string) => unknown
  refreshProfiles: (hostId: string) => unknown
  profiles: import('@tandem/protocol').Profile[]
  profilesLoading: boolean
  text: string
  setText: (text: string) => void
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>
  menuRef: MutableRefObject<HTMLDivElement | null>
  editorRef: MutableRefObject<ComposerEditorHandle | null>
  elementRef: MutableRefObject<HTMLDivElement | null>
}

export function useComposerCompletion({
  effectiveHostId,
  cwd,
  commands,
  commandsLoaded,
  refreshCommands,
  refreshProfiles,
  profiles,
  profilesLoading,
  text,
  setText,
  setModelMenuOpen,
  menuRef,
  editorRef,
  elementRef,
}: Options) {
  const [completion, setCompletion] = useState<Completion | null>(null)
  const [index, setIndex] = useState(0)
  const [fileItems, setFileItems] = useState<string[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const fileSeq = useRef(0)

  useEffect(() => {
    if (completion?.kind === 'slash' && effectiveHostId) void refreshCommands(effectiveHostId)
  }, [completion?.kind, effectiveHostId, refreshCommands])

  useEffect(() => {
    if (!completion || completion.kind !== 'file') {
      fileSeq.current++
      setFileItems([])
      setFileLoading(false)
      return
    }
    const seq = ++fileSeq.current
    if (!cwd) {
      setFileItems([])
      setFileLoading(false)
      return
    }
    setFileLoading(true)
    const timer = window.setTimeout(() => {
      const host = useAppStore.getState().hosts.find((h) => h.id === effectiveHostId)
      if (!host) {
        setFileLoading(false)
        return
      }
      api
        .fsComplete(host, cwd, completion.query)
        .then((items) => {
          if (seq !== fileSeq.current) return
          setFileItems(items.slice(0, 60))
          setFileLoading(false)
        })
        .catch(() => {
          if (seq !== fileSeq.current) return
          setFileItems([])
          setFileLoading(false)
        })
    }, 140)
    return () => window.clearTimeout(timer)
  }, [completion?.kind, completion?.query, effectiveHostId, cwd])

  useEffect(() => {
    setIndex(0)
  }, [completion?.kind, completion?.query])

  useClickOutside([menuRef, elementRef], () => setCompletion(null), !!completion)

  const items = useMemo<CompletionEntry[]>(() => {
    if (!completion) return []
    if (completion.kind === 'file') {
      return fileItems.map((path) => {
        const dir = path.endsWith('/')
        const value = dir ? path.slice(0, -1) : path
        return { kind: 'file' as const, value, label: path, isDir: dir }
      })
    }
    const q = completion.query.toLowerCase()
    return commands
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      )
      .slice(0, 40)
      .map((c) => {
        const name = c.name.replace(/^\/+/, '')
        return {
          kind: 'slash' as const,
          value: name,
          label: `/${name}`,
          description: c.description,
          badge: SOURCE_LABEL[c.source],
        }
      })
  }, [completion, fileItems, commands])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, items.length - 1)))
  }, [items.length])

  const selectItem = (item: CompletionEntry, openFolder = false) => {
    if (!completion) return
    const before = text.slice(0, completion.start)
    const after = text.slice(completion.end)
    if (item.kind === 'slash' && item.value.toLowerCase() === 'model') {
      setText(before + after)
      setCompletion(null)
      if (effectiveHostId && profiles.length === 0 && !profilesLoading) {
        void refreshProfiles(effectiveHostId)
      }
      setModelMenuOpen(true)
      return
    }
    if (item.kind === 'file' && item.isDir && openFolder) {
      // 进入文件夹继续浏览：保留补全菜单，查询变成 `@dir/`。
      const insertion = `@${item.value}/`
      const next = before + insertion + after
      const caret = before.length + insertion.length
      setText(next)
      setCompletion(detectCompletion(next, caret))
      window.requestAnimationFrame(() => {
        const editor = editorRef.current
        if (!editor) return
        editor.focus()
        editor.setSelection(caret)
      })
      return
    }
    const insertion = `${item.value}${item.isDir ? '/' : ''} `
    registerToken(insertion.trim())
    const next = before + insertion + after
    setText(next)
    setCompletion(null)
    window.requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      editor.setSelection(before.length + insertion.length)
    })
  }

  return {
    completion,
    setCompletion,
    index,
    setIndex,
    fileItems,
    fileLoading,
    items,
    selectItem,
  }
}
