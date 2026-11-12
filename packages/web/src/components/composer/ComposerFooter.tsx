import type { RefObject } from 'react'
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Button, IconButton } from '../ui/Button'
import { formatTokens } from '../../lib/format'
import type {
  DelegationStrategy,
  ModelPriceInfo,
  PermissionMode,
  Profile,
  ReasoningEffort,
  RoutePreference,
} from '@tandem/protocol'
import { ContextMeter } from '../chat/ContextMeter'
import { VoiceButton, type VoiceButtonHandle } from '../voice/VoiceButton'
import { ModelMenu } from './ModelMenu'
import { MobileMoreMenu, PermissionModeMenu, ThinkingModeMenu } from './ComposerMenus'
import { MAX_ATTACHMENTS } from './composerTypes'

interface ComposerFooterProps {
  disabled: boolean
  running: boolean
  stopping: boolean
  canSend: boolean
  sendState: 'running' | 'ready' | 'idle'
  onSend: () => void
  onStop: () => void
  compact: boolean
  isMobile: boolean
  showSummary: boolean
  sessionless: boolean
  attachDisabled: boolean
  onAddImage: () => void
  voiceRef: RefObject<VoiceButtonHandle | null>
  onVoiceText: (spoken: string) => void
  mode: PermissionMode
  onChangeMode: (mode: PermissionMode) => void
  inputTokens: number
  contextLimit: number | undefined
  expectedContext: number
  expectedPct: number | undefined
  effectiveDelegation: DelegationStrategy
  effectiveRouteBias: RoutePreference | undefined
  routeNative: boolean
  onChangeDelegation: (strategy: DelegationStrategy) => void
  onChangeRouteBias: (bias: RoutePreference) => void
  onChangeRouteNative: (native: boolean) => void
  uiProfiles: Profile[]
  currentProfileId: string
  currentGroupId: string | undefined
  currentModel: string
  autoRoute: boolean
  routedModel: string | undefined
  modelPrices: Record<string, ModelPriceInfo> | undefined
  pricesLoading: boolean
  effort: ReasoningEffort | undefined
  supportedEfforts: ReasoningEffort[]
  effortLabels: Partial<Record<ReasoningEffort, string>> | undefined
  defaultEffort: ReasoningEffort | undefined
  effortNote: string | undefined
  profilesLoading: boolean
  modelDisabled: boolean
  modelMenuOpen: boolean
  onModelMenuOpenChange: (open: boolean) => void
  onChangeModel: (profileId: string, groupId: string | undefined, model: string) => void
  onChangeAutoRoute: () => void
  onLoadPrices: (profileId: string, groupId: string | undefined) => void
  onChangeEffort: (effort: ReasoningEffort) => void
  onManageModels: () => void
  onSetupPrice: () => void
  onOpenModelMenu: () => void
}

export function ComposerFooter({
  disabled,
  running,
  stopping,
  canSend,
  sendState,
  onSend,
  onStop,
  compact,
  isMobile,
  showSummary,
  sessionless,
  attachDisabled,
  onAddImage,
  voiceRef,
  onVoiceText,
  mode,
  onChangeMode,
  inputTokens,
  contextLimit,
  expectedContext,
  expectedPct,
  effectiveDelegation,
  effectiveRouteBias,
  routeNative,
  onChangeDelegation,
  onChangeRouteBias,
  onChangeRouteNative,
  uiProfiles,
  currentProfileId,
  currentGroupId,
  currentModel,
  autoRoute,
  routedModel,
  modelPrices,
  pricesLoading,
  effort,
  supportedEfforts,
  effortLabels,
  defaultEffort,
  effortNote,
  profilesLoading,
  modelDisabled,
  modelMenuOpen,
  onModelMenuOpenChange,
  onChangeModel,
  onChangeAutoRoute,
  onLoadPrices,
  onChangeEffort,
  onManageModels,
  onSetupPrice,
  onOpenModelMenu,
}: ComposerFooterProps) {
  return (
        <div className="flex min-w-0 flex-nowrap items-center gap-1 px-2 pb-2 pt-1">
          <IconButton
            onClick={onAddImage}
            disabled={attachDisabled}
            label="添加图片"
            tooltipSide="top"
            className="max-sm:size-11"
          >
            <Paperclip size={16} />
          </IconButton>
          <VoiceButton
            ref={voiceRef}
            onText={onVoiceText}
            disabled={disabled}
            tooltipSide="top"
          />
          {isMobile || compact ? (
            <MobileMoreMenu mode={mode} disabled={disabled} onChange={onChangeMode} />
          ) : (
            <>
              <ThinkingModeMenu />
              <PermissionModeMenu mode={mode} disabled={disabled} onChange={onChangeMode} />
            </>
          )}
          <span className="min-w-0 flex-1" />
          {!compact && inputTokens > 0 && (
            <span
              data-composer-tokens=""
              data-tip={
                contextLimit
                  ? `本次输入约 ~${formatTokens(inputTokens)} token（含附件与已选元素）；发送后上下文约 ~${formatTokens(expectedContext)} / ~${formatTokens(contextLimit)} token，占上限 ${expectedPct !== undefined && expectedPct > 0 && expectedPct < 1 ? '<1' : Math.round(expectedPct ?? 0)}%`
                  : `本次输入约 ~${formatTokens(inputTokens)} token（含附件与已选元素）`
              }
              aria-label="本条消息的输入 token 估算"
              className="shrink-0 whitespace-nowrap px-1 font-mono text-[11px] tabular-nums text-muted max-sm:text-[11px]"
            >
              ~{formatTokens(inputTokens)} tok
              {expectedPct !== undefined && (
                <span className="max-sm:hidden">
                  {' · '}发送后 ~{expectedPct > 0 && expectedPct < 1 ? '<1' : Math.round(expectedPct)}%
                </span>
              )}
            </span>
          )}
          {showSummary && (
            <span className="contents max-sm:hidden">
              <ContextMeter compactDisabled={running} />
            </span>
          )}
          <ModelMenu
            compact={compact}
            profiles={uiProfiles}
            profileId={currentProfileId}
            groupId={currentGroupId}
            model={currentModel}
            autoRoute={autoRoute}
            autoModel={autoRoute ? routedModel : undefined}
            prices={modelPrices}
            pricesLoading={pricesLoading}
            effort={effort}
            efforts={supportedEfforts}
            effortLabels={effortLabels}
            defaultEffort={defaultEffort}
            effortNote={effortNote}
            delegation={effectiveDelegation}
            routeBias={effectiveRouteBias}
            routeNative={routeNative}
            onDelegationChange={onChangeDelegation}
            onRouteBiasChange={onChangeRouteBias}
            onRouteNativeChange={onChangeRouteNative}
            loading={profilesLoading}
            disabled={modelDisabled}
            open={modelMenuOpen}
            onOpenChange={onModelMenuOpenChange}
            onSelect={onChangeModel}
            onSelectAuto={onChangeAutoRoute}
            onLoadPrices={onLoadPrices}
            onEffortChange={onChangeEffort}
            onManage={onManageModels}
            onSetupPrice={onSetupPrice}
            onOpen={onOpenModelMenu}
          />
          <Button
            variant="accent"
            onClick={running ? onStop : onSend}
            disabled={running ? stopping : !canSend}
            data-state={sendState}
            tooltip={running ? '停止生成 (Esc)' : '发送 (Enter)'}
            tooltipSide="top"
            aria-label={running ? '停止生成' : '发送消息'}
            className="composer-send ml-0.5 shrink-0 disabled:cursor-not-allowed"
          >
            <span key={sendState} className="send-icon flex items-center justify-center">
              {running ? (
                stopping ? (
                  <Spinner size={15} />
                ) : (
                  <Square size={11} className="fill-current" />
                )
              ) : (
                <ArrowUp size={17} strokeWidth={2.2} />
              )}
            </span>
          </Button>
        </div>
  )
}
