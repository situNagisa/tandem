import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { readFileAsDataURL, type FeedbackVideo } from '../../lib/feedback'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useUiStore } from '../../store/useUiStore'
import { MAX_VIDEO_BYTES } from './feedbackModeHelpers'

export function useFeedbackRecording(
  active: boolean,
  setPendingVideo: Dispatch<SetStateAction<FeedbackVideo | null>>,
) {
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordStartedRef = useRef(0)
  const recordTimerRef = useRef<number | null>(null)
  const recordTickRef = useRef<number | null>(null)

  const canRecord =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'

  const stopRecording = () => {
    if (recordTimerRef.current) {
      window.clearTimeout(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (recordTickRef.current) {
      window.clearInterval(recordTickRef.current)
      recordTickRef.current = null
    }
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    setRecording(false)
  }

  const startRecording = async () => {
    if (!canRecord || recording) return
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      streamRef.current = stream
      chunksRef.current = []
      recordStartedRef.current = Date.now()
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = async () => {
        if (recordTickRef.current) {
          window.clearInterval(recordTickRef.current)
          recordTickRef.current = null
        }
        if (recordTimerRef.current) {
          window.clearTimeout(recordTimerRef.current)
          recordTimerRef.current = null
        }
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        recorderRef.current = null
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' })
        chunksRef.current = []
        if (blob.size === 0) return
        if (blob.size > MAX_VIDEO_BYTES) {
          useUiStore.getState().toast('录屏超过 8MB，已丢弃（可缩短后重录）', 'error')
          return
        }
        const dataURL = await readFileAsDataURL(blob)
        if (!dataURL) return
        if (!useFeedbackStore.getState().active) return
        setPendingVideo({
          name: `repro-${Date.now()}.webm`,
          mime: blob.type,
          dataURL,
          durationMs: Date.now() - recordStartedRef.current,
          sizeBytes: blob.size,
        })
        useUiStore.getState().toast('录屏已附加到下一条反馈', 'success')
      }
      recorder.start(1000)
      setRecording(true)
      setRecordSeconds(0)
      recordTickRef.current = window.setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - recordStartedRef.current) / 1000))
      }, 1000)
      recordTimerRef.current = window.setTimeout(() => stopRecording(), 60_000)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording())
    } catch {
      useUiStore.getState().toast('无法开始录屏（可能取消了授权）', 'error')
    }
  }
  // 退出反馈模式时停止录制并释放屏幕流。
  useEffect(() => {
    if (active) return
    if (recordTimerRef.current) {
      window.clearTimeout(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (recordTickRef.current) {
      window.clearInterval(recordTickRef.current)
      recordTickRef.current = null
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setRecording(false)
  }, [active])

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) window.clearTimeout(recordTimerRef.current)
      if (recordTickRef.current) window.clearInterval(recordTickRef.current)
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  return { canRecord, recording, recordSeconds, stopRecording, startRecording }
}
