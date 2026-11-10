import { useCallback, useEffect, useState } from 'react'
import type {
  DelegationStrategy,
  ModelPriceInfo,
  PermissionMode,
  Profile,
  ReasoningEffort,
  ProviderKind,
  RoutePreference,
  SessionSummary,
  TurnRouteOverride,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { defaultEffortsForKind, nearestEffort, rememberEffort } from '../../lib/effort'
import { prettyModel } from '../../lib/modelName'
import { profileModelGroups } from '../../lib/profileModels'
import { formatCost } from '../../lib/format'
import { MODES } from './ComposerMenus'

import type { HostConfig, SessionTarget } from '../../lib/types'

type StoreState = ReturnType<typeof useAppStore.getState>

interface Options {
  sessionless: boolean
  onPermissionModeChange?: (mode: PermissionMode) => void
  onModelChange?: (profileId: string, groupId: string | undefined, model: string) => void
  onRouteBiasChange?: (bias: RoutePreference) => void
  onDelegationChange?: (strategy: DelegationStrategy) => void
  onEffortChange?: (effort: ReasoningEffort) => void
  summary: SessionSummary | null
  activeHostId: string | null
  scopeTarget: SessionTarget | undefined
  effectiveHostId: string | null | undefined
  effectiveHost: HostConfig | null | undefined
  profiles: Profile[]
  uiProfiles: Profile[]
  currentProfileId: string
  currentGroupId: string | undefined
  currentModel: string
  currentKind: ProviderKind | undefined
  mode: PermissionMode
  contextUsed: number
  autoRoute: boolean
  localEffort: ReasoningEffort
  setLocalEffort: (effort: ReasoningEffort) => void
  effort: ReasoningEffort
  keepRouteMode: boolean
  setKeepRouteMode: (keep: boolean) => void
  effectiveDelegation: DelegationStrategy
  effectiveRouteBias: RoutePreference | undefined
  routeOverride: TurnRouteOverride | undefined
  setRouteOverride: (route: TurnRouteOverride | undefined) => void
  setModelMenuOpen: (open: boolean) => void
  setPendingSwitch: (
    value: { profileId: string; groupId?: string; model: string; tokens: number } | null,
  ) => void
  setPermissionMode: StoreState['setPermissionMode']
  setModel: StoreState['setModel']
  updateSession: StoreState['updateSession']
}

export function useComposerModelControls({
  sessionless,
  onPermissionModeChange,
  onModelChange,
  onRouteBiasChange,
  onDelegationChange,
  onEffortChange,
  summary,
  activeHostId,
  scopeTarget,
  effectiveHostId,
  effectiveHost,
  profiles,
  uiProfiles,
  currentProfileId,
  currentGroupId,
  currentModel,
  currentKind,
  mode,
  contextUsed,
  autoRoute,
  localEffort,
  setLocalEffort,
  effort,
  keepRouteMode,
  setKeepRouteMode,
  effectiveDelegation,
  effectiveRouteBias,
  routeOverride,
  setRouteOverride,
  setModelMenuOpen,
  setPendingSwitch,
  setPermissionMode,
  setModel,
  updateSession,
}: Options) {
  const [modelEfforts, setModelEfforts] = useState<ReasoningEffort[] | undefined>(undefined)
  const [modelEffortLabels, setModelEffortLabels] = useState<
    Partial<Record<ReasoningEffort, string>> | undefined
  >(undefined)
  const [modelContextWindow, setModelContextWindow] = useState<number | undefined>(undefined)
  const supportedEfforts = modelEfforts ?? defaultEffortsForKind(currentKind)

  const [priceCache, setPriceCache] = useState<
    Record<string, Record<string, ModelPriceInfo> | 'loading'>
  >({})

  // 当前模型支持哪些思考强度与上下文上限；请求失败按 provider 默认处理
  useEffect(() => {
    setModelEfforts(undefined)
    setModelEffortLabels(undefined)
    setModelContextWindow(undefined)
    if (!effectiveHostId || !currentProfileId || !currentModel || autoRoute) return
    const host = useAppStore.getState().hosts.find((h) => h.id === effectiveHostId)
    if (!host) return
    let cancelled = false
    api
      .modelCapabilities(host, currentProfileId, currentGroupId, currentModel)
      .then((info) => {
        if (cancelled) return
        setModelEfforts(info.efforts)
        setModelEffortLabels(info.effortLabels)
        setModelContextWindow(info.contextWindow)
      })
      .catch(() => {
        /* 能力未知时保留默认档位 */
      })
    return () => {
      cancelled = true
    }
  }, [effectiveHostId, currentProfileId, currentGroupId, currentModel, autoRoute])

  const changeMode = (next: PermissionMode) => {
    if (sessionless) onPermissionModeChange?.(next)
    else void setPermissionMode(next, scopeTarget)
  }

  const cycleMode = () => {
    const idx = MODES.indexOf(mode)
    changeMode(MODES[(idx + 1) % MODES.length])
  }

  const applyModelChange = (
    nextProfileId: string,
    nextGroupId: string | undefined,
    nextModel: string,
  ) => {
    if (sessionless) onModelChange?.(nextProfileId, nextGroupId, nextModel)
    else void setModel(nextProfileId, nextGroupId, nextModel, scopeTarget)
  }

  const changeModel = (
    nextProfileId: string,
    nextGroupId: string | undefined,
    nextModel: string,
  ) => {
    const same =
      nextProfileId === currentProfileId &&
      (nextGroupId ?? '') === (currentGroupId ?? '') &&
      nextModel === currentModel
    if (same) return
    // 已有上下文：换缓存前缀会让提示缓存失效，先确认再切（反馈10#02）。
    if (!sessionless && contextUsed > 0) {
      setModelMenuOpen(false)
      setPendingSwitch({
        profileId: nextProfileId,
        ...(nextGroupId ? { groupId: nextGroupId } : {}),
        model: nextModel,
        tokens: contextUsed,
      })
      return
    }
    applyModelChange(nextProfileId, nextGroupId, nextModel)
  }

  const loadModelPrices = useCallback(
    (profileId: string, groupId: string | undefined) => {
      if (!effectiveHost || !profileId) return
      const key = `${profileId}:${groupId ?? ''}`
      setPriceCache((prev) => (prev[key] ? prev : { ...prev, [key]: 'loading' }))
      api
        .modelPrices(effectiveHost, profileId, groupId)
        .then((res) => setPriceCache((prev) => ({ ...prev, [key]: res.prices })))
        .catch(() =>
          setPriceCache((prev) => {
            const next = { ...prev }
            delete next[key]
            return next
          }),
        )
    },
    [effectiveHost],
  )

  const priceKey = `${currentProfileId}:${currentGroupId ?? ''}`
  const cachedPrices = priceCache[priceKey]
  const modelPrices = cachedPrices === 'loading' ? undefined : cachedPrices

  const applyAutoRoute = () => {
    const profile = currentProfileId || profiles[0]?.id
    if (!profile) return
    const group = currentGroupId ?? profileModelGroups(profiles.find((p) => p.id === profile) ?? null)[0]?.groupId
    if (sessionless) {
      onModelChange?.(profile, group, 'auto')
      return
    }
    // 模型菜单只管模型；分工与取向改由输入框的「分工与取向」菜单统一选择。
    void updateSession(activeHostId!, summary!.id, { model: 'auto' })
  }

  const changeAutoRoute = () => {
    const profile = currentProfileId || profiles[0]?.id
    if (!profile) return
    const alreadyAuto = sessionless ? currentModel === 'auto' : summary?.autoRoute === true
    if (alreadyAuto) return
    if (!sessionless && contextUsed > 0) {
      setModelMenuOpen(false)
      setPendingSwitch({ profileId: profile, model: 'auto', tokens: contextUsed })
      return
    }
    applyAutoRoute()
  }

  // 会话内只写本条消息的覆盖；「记住为会话偏好」打开时同时落库。
  const applyDelegation = (strategy: DelegationStrategy) => {
    if (sessionless) {
      onDelegationChange?.(strategy)
      return
    }
    setRouteOverride({ ...routeOverride, delegation: strategy })
    if (!keepRouteMode) return
    if (activeHostId && summary) {
      void updateSession(activeHostId, summary.id, { delegation: strategy })
    }
  }

  const applyRouteBias = (bias: RoutePreference) => {
    if (sessionless) {
      onRouteBiasChange?.(bias)
      return
    }
    setRouteOverride({ ...routeOverride, routeBias: bias })
    if (!keepRouteMode) return
    if (activeHostId && summary) {
      void updateSession(activeHostId, summary.id, { routeBias: bias })
    }
  }

  const toggleKeepRouteMode = () => {
    const next = !keepRouteMode
    setKeepRouteMode(next)
    if (next && !sessionless && activeHostId && summary) {
      void updateSession(activeHostId, summary.id, {
        delegation: effectiveDelegation,
        ...(effectiveRouteBias ? { routeBias: effectiveRouteBias } : {}),
      })
    }
  }

  const changeEffort = (next: ReasoningEffort, remember = true) => {
    if (remember) rememberEffort(next)
    setLocalEffort(next)
    if (sessionless) {
      onEffortChange?.(next)
      return
    }
    if (activeHostId && summary) {
      void updateSession(activeHostId, summary.id, { effort: next })
    }
  }

  // 切换模型后当前强度不再受支持：降到最近的可用档；完全不支持思考则回到关
  useEffect(() => {
    if (modelEfforts === undefined) return
    if (modelEfforts.length === 0) {
      if (effort !== 'off') changeEffort('off', false)
      return
    }
    if (!modelEfforts.includes(effort)) {
      changeEffort(nearestEffort(modelEfforts, effort), false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelEfforts, effort])

  const switchLabel = (pick: { profileId: string; groupId?: string; model: string }) => {
    if (pick.model === 'auto') return '自动路由'
    const profile = uiProfiles.find((p) => p.id === pick.profileId)
    const group = profile?.groups?.find((g) => g.id === pick.groupId)
    const parts = [profile?.name, group?.name].filter(Boolean)
    return `${parts.length ? `${parts.join(' › ')} · ` : ''}${prettyModel(pick.model)}`
  }

  /** 估算切换后下一轮重新写入缓存的价格：用目标模型的实际输入单价，未知时只显示 token。 */
  const switchCost = (pick: {
    profileId: string
    groupId?: string
    model: string
    tokens: number
  }): number | undefined => {
    if (pick.model === 'auto') return undefined
    const key = `${pick.profileId}:${pick.groupId ?? ''}`
    const cached = priceCache[key]
    const price =
      cached && cached !== 'loading'
        ? cached[pick.model]?.input
        : pick.profileId === currentProfileId
          ? modelPrices?.[pick.model]?.input
          : undefined
    return price === undefined ? undefined : (pick.tokens * price) / 1_000_000
  }

  const switchCostText = (cost: number | undefined): string | null => {
    if (cost === undefined) return null
    if (cost >= 0.01) return formatCost(cost)
    if (cost >= 0.0001) return `$${cost.toFixed(4)}`
    return '< $0.0001'
  }
  return {
    modelEfforts,
    modelEffortLabels,
    modelContextWindow,
    supportedEfforts,
    modelPrices,
    cachedPrices,
    loadModelPrices,
    changeMode,
    cycleMode,
    applyModelChange,
    changeModel,
    applyAutoRoute,
    changeAutoRoute,
    applyDelegation,
    applyRouteBias,
    toggleKeepRouteMode,
    changeEffort,
    switchLabel,
    switchCost,
    switchCostText,
  }
}
