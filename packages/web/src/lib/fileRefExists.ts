// 行内代码里的路径只有在该会话工作目录下确实是文件时才生成链接（反馈0220#04 / R06）。
// 同一轮渲染里的多条消息合并成一次批量查询，结果按「主机 + 目录 + 路径」缓存 60 秒。
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { extractInlineRefs } from './fileLinks'
import { useAppStore } from '../store/useAppStore'
import type { HostConfig } from './types'

const TTL = 60_000

interface Cached {
  exists: boolean
  at: number
}

const cache = new Map<string, Cached>()

interface Batch {
  host: HostConfig
  cwd: string
  paths: Set<string>
  waiters: Array<() => void>
}

const batches = new Map<string, Batch>()
let flushTimer: number | null = null

function cacheKey(hostId: string, cwd: string, path: string): string {
  return `${hostId}\u0000${cwd}\u0000${path}`
}

/** 已查过的结果；未查过或已过期返回 undefined。 */
export function knownFileRefExists(hostId: string | null, cwd: string, path: string): boolean | undefined {
  if (!hostId) return undefined
  const hit = cache.get(cacheKey(hostId, cwd, path))
  if (!hit || Date.now() - hit.at >= TTL) return undefined
  return hit.exists
}

async function flush(): Promise<void> {
  flushTimer = null
  const entries = [...batches.values()]
  batches.clear()
  for (const entry of entries) {
    const paths = [...entry.paths].slice(0, 200)
    try {
      const result = await api.fsExist(entry.host, entry.cwd || undefined, paths)
      const at = Date.now()
      for (const path of paths) {
        cache.set(cacheKey(entry.host.id, entry.cwd, path), {
          exists: result.exists[path] === true,
          at,
        })
      }
    } catch {
      // 查询失败按「不存在」渲染（保持普通行内代码），下次渲染再查
    }
    for (const done of entry.waiters) done()
  }
}

function requestExists(host: HostConfig, cwd: string, paths: string[]): Promise<void> {
  const key = `${host.id}\u0000${cwd}`
  let entry = batches.get(key)
  if (!entry) {
    entry = { host, cwd, paths: new Set(), waiters: [] }
    batches.set(key, entry)
  }
  for (const path of paths) entry.paths.add(path)
  const promise = new Promise<void>((resolve) => entry!.waiters.push(resolve))
  if (flushTimer === null) flushTimer = window.setTimeout(() => void flush(), 16)
  return promise
}

/**
 * 给一组正文的渲染层提供「行内代码路径 → 是否真实存在」。
 * 没有主机/目录（分享页等只读场景）时全部按不存在处理，只保留显式 Markdown 链接。
 */
export function useFileRefExists(text: string, cwd?: string): Record<string, boolean> {
  const host = useAppStore((s) => {
    const id = s.active?.hostId ?? s.activeHostId
    return id ? s.hosts.find((h) => h.id === id) ?? null : null
  })
  const activeCwd = useAppStore((s) => s.active?.summary?.cwd ?? '')
  const baseCwd = cwd || activeCwd
  const refs = useMemo(() => extractInlineRefs(text), [text])
  const pathsKey = refs.map((ref) => ref.path).join('\u0000')
  const [version, setVersion] = useState(0)

  const exists = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const ref of refs) {
      const known = knownFileRefExists(host?.id ?? null, baseCwd, ref.path)
      if (known !== undefined) out[ref.path] = known
    }
    return out
    // version：新结果写入缓存后重算
  }, [refs, host?.id, baseCwd, version])

  useEffect(() => {
    if (!host || !baseCwd) return
    const missing = refs
      .map((ref) => ref.path)
      .filter((path, index, list) => list.indexOf(path) === index)
      .filter((path) => knownFileRefExists(host.id, baseCwd, path) === undefined)
    if (!missing.length) return
    let cancelled = false
    void requestExists(host, baseCwd, missing).then(() => {
      if (!cancelled) setVersion((value) => value + 1)
    })
    return () => {
      cancelled = true
    }
    // pathsKey 覆盖 refs 的内容变化；host/baseCwd 变化也要重查
  }, [host, baseCwd, pathsKey])

  return exists
}
