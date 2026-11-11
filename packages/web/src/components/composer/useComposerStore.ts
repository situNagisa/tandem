import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReasoningEffort, RoutePreference } from '@tandem/protocol'
import { cachedRouteBias, loadRouteBias, subscribeRouteBias } from '../../lib/routeBias'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { usePreviewStore } from '../../store/usePreviewStore'
import { useDemoStore } from '../../store/useDemoStore'
import { useIsMobile } from '../../lib/hooks'
import { loadLastEffort } from '../../lib/effort'
import { useSessionTarget, useSessionView } from '../session/SessionScope'
import {
  EMPTY_COMMANDS,
  EMPTY_PENDING,
  EMPTY_PROFILES,
  EMPTY_SELECTIONS,
} from './composerTypes'

function useGlobalRouteBias(hostId: string | null | undefined): RoutePreference | undefined {
  useEffect(() => {
    if (!hostId) return
    const host = useAppStore.getState().hosts.find((h) => h.id === hostId)
    if (!host) return
    /* 读取失败时按协议默认值展示 */
    void loadRouteBias(host).catch(() => {})
  }, [hostId])
  return useSyncExternalStore(subscribeRouteBias, () =>
    hostId ? cachedRouteBias(hostId) : undefined,
  )
}

interface Options {
  sessionless: boolean
  modelProp: string | undefined
  profileIdProp: string | undefined
  groupIdProp: string | undefined
  permissionModeProp: import('@tandem/protocol').PermissionMode | undefined
  routeBiasProp: RoutePreference | undefined
  delegationProp: import('@tandem/protocol').DelegationStrategy | undefined
  routeNativeProp: boolean | undefined
  effortProp: ReasoningEffort | undefined
  hostIdProp: string | undefined
  cwdProp: string | undefined
  runningProp: boolean | undefined
}

export function useComposerStore({
  sessionless,
  modelProp,
  profileIdProp,
  groupIdProp,
  permissionModeProp,
  routeBiasProp,
  delegationProp,
  routeNativeProp,
  effortProp,
  hostIdProp,
  cwdProp,
  runningProp,
}: Options) {
  const isMobile = useIsMobile()
  const scopeTarget = useSessionTarget() ?? undefined
  const sessionId = useSessionView((s) => s?.sessionId ?? null)
  const previewSelections = usePreviewStore((s) =>
    sessionId ? s.selections[sessionId] ?? EMPTY_SELECTIONS : EMPTY_SELECTIONS,
  )
  const removePreviewSelection = usePreviewStore((s) => s.removeSelection)
  const summary = useSessionView((s) => s?.summary ?? null)
  const storeRunning = useSessionView((s) => s?.running ?? false)
  const pendingRequests = useSessionView((s) => s?.pending ?? EMPTY_PENDING)
  const storeStopping = useSessionView((s) => s?.stopping ?? false)
  const activeHostId = useSessionView((s) => s?.hostId ?? null)
  const hostStatus = useAppStore((s) =>
    (hostIdProp ?? activeHostId) ? (s.runtimes[hostIdProp ?? activeHostId!]?.status ?? 'offline') : 'offline',
  )
  const commands = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.commands ?? EMPTY_COMMANDS)
      : EMPTY_COMMANDS,
  )
  const commandsLoaded = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.commandsLoaded ?? false)
      : false,
  )
  const profiles = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.profiles ?? EMPTY_PROFILES)
      : EMPTY_PROFILES,
  )
  const profilesLoading = useAppStore((s) =>
    (hostIdProp ?? activeHostId)
      ? (s.runtimes[hostIdProp ?? activeHostId!]?.profilesLoading ?? false)
      : false,
  )
  // 演示账号只在下属演示会话里加入模型菜单，正常会话完全看不到。
  const demoProfile = useDemoStore((s) =>
    summary?.demo
      ? (s.byHost[hostIdProp ?? activeHostId ?? '']?.profile ?? undefined)
      : undefined,
  )
  const uiProfiles =
    demoProfile && !profiles.some((profile) => profile.id === demoProfile.id)
      ? [...profiles, demoProfile]
      : profiles
  const send = useAppStore((s) => s.send)
  const hosts = useAppStore((s) => s.hosts)
  const ensureWorktree = useAppStore((s) => s.ensureWorktree)
  const interrupt = useAppStore((s) => s.interrupt)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const setModel = useAppStore((s) => s.setModel)
  const updateSession = useAppStore((s) => s.updateSession)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const refreshCommands = useAppStore((s) => s.refreshCommands)
  const seed = useUiStore((s) => s.promptSeed)
  const clearPromptSeed = useUiStore((s) => s.clearPromptSeed)
  const composerResetNonce = useUiStore((s) => s.composerResetNonce)
  const toast = useUiStore((s) => s.toast)
  const openSettings = useUiStore((s) => s.openSettings)
  const focusSetting = useUiStore((s) => s.focusSetting)
  const openScheduleComposer = useUiStore((s) => s.openScheduleComposer)
  const openMemoryEditor = useUiStore((s) => s.openMemoryEditor)

  const effectiveHostId = hostIdProp ?? activeHostId
  const effectiveHost = hosts.find((h) => h.id === effectiveHostId)
  const cwd = cwdProp ?? summary?.cwd
  const running = runningProp ?? storeRunning
  const stopping = runningProp === undefined && storeStopping
  const mode = sessionless ? (permissionModeProp ?? 'default') : (summary?.permissionMode ?? 'default')
  const currentModel = sessionless ? (modelProp ?? '') : (summary?.model ?? '')
  const autoRoute = sessionless ? currentModel === 'auto' : summary?.autoRoute === true
  const routedModel = summary?.route?.model
  const globalRouteBias = useGlobalRouteBias(effectiveHostId)
  // 选择即写入会话：会话页的当前值就是会话记录里的值，新会话页用创建前选择的值。
  const effectiveDelegation = sessionless ? (delegationProp ?? 'less') : (summary?.delegation ?? 'less')
  const effectiveRouteBias = sessionless
    ? (routeBiasProp ?? globalRouteBias)
    : (summary?.routeBias ?? globalRouteBias)
  const routeNative = sessionless ? (routeNativeProp ?? false) : summary?.routeNative === true
  const currentProfileId = sessionless ? (profileIdProp ?? '') : (summary?.profileId ?? '')
  const currentGroupId = sessionless ? groupIdProp : summary?.groupId
  const contextUsed = summary?.context?.usedTokens ?? 0
  const contextWindow = summary?.context?.contextWindow
  const [localEffort, setLocalEffort] = useState<ReasoningEffort>(loadLastEffort)
  const currentProfile = uiProfiles.find((p) => p.id === currentProfileId)
  const currentGroup = currentProfile?.groups?.find((g) => g.id === currentGroupId)
  const currentKind = currentGroup?.kind ?? currentProfile?.kind
  const effort = sessionless ? (effortProp ?? localEffort) : (summary?.effort ?? 'off')
  const draftKey = sessionId ? `${activeHostId ?? ''}:${sessionId}` : `new:${effectiveHostId ?? ''}`
  return {
    isMobile,
    scopeTarget,
    sessionId,
    previewSelections,
    removePreviewSelection,
    summary,
    pendingRequests,
    activeHostId,
    hostStatus,
    commands,
    commandsLoaded,
    profiles,
    profilesLoading,
    uiProfiles,
    send,
    ensureWorktree,
    interrupt,
    setPermissionMode,
    setModel,
    updateSession,
    refreshProfiles,
    refreshCommands,
    seed,
    clearPromptSeed,
    composerResetNonce,
    toast,
    openSettings,
    focusSetting,
    openScheduleComposer,
    openMemoryEditor,
    effectiveHostId,
    effectiveHost,
    cwd,
    running,
    stopping,
    mode,
    currentModel,
    autoRoute,
    routedModel,
    effectiveDelegation,
    effectiveRouteBias,
    routeNative,
    currentProfileId,
    currentGroupId,
    contextUsed,
    contextWindow,
    localEffort,
    setLocalEffort,
    currentKind,
    effort,
    draftKey,
  }
}
