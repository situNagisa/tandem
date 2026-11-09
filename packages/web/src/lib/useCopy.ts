import { useCallback, useEffect, useRef, useState } from 'react'
import { copyText } from './clipboard'

export interface CopyOptions {
  /** 复制成功后多少毫秒恢复为未复制；0 表示保持已复制状态。默认 1500。 */
  resetAfter?: number
  onSuccess?: () => void
  onError?: () => void
}

/**
 * 复制按钮的共享状态：先走 `copyText`（含局域网 HTTP 回退），成功后 `copied` 为真，
 * 默认 1.5 秒后恢复。超时与提示文案由调用方通过参数保留各自原值。
 */
export function useCopy(defaults: CopyOptions = {}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  const reset = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setCopied(false)
  }, [])

  const copy = useCallback(async (text: string, options: CopyOptions = {}) => {
    const settings = { ...defaultsRef.current, ...options }
    const ok = await copyText(text)
    if (!ok) {
      settings.onError?.()
      return false
    }
    if (timer.current) window.clearTimeout(timer.current)
    setCopied(true)
    settings.onSuccess?.()
    const resetAfter = settings.resetAfter ?? 1500
    if (resetAfter > 0) {
      timer.current = window.setTimeout(() => setCopied(false), resetAfter)
    } else {
      timer.current = null
    }
    return true
  }, [])

  return { copied, copy, reset }
}
