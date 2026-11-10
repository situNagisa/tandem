import type { RefObject } from 'react'
import { ArrowUp, ChevronDown, FileText, GitFork, Paperclip, Square } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Button, IconButton } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import type { DelegationStrategy, ModelPriceInfo, PermissionMode, Profile, ReasoningEffort } from '@tandem/protocol'
import { ContextMeter } from '../chat/ContextMeter'
import { VoiceButton, type VoiceButtonHandle } from '../voice/VoiceButton'
import { ModelMenu } from './ModelMenu'
import { MobileMoreMenu, PermissionModeMenu, ThinkingModeMenu } from './ComposerMenus'
import {
  DELEGATION_META,
  DELEGATION_ORDER,
  ROUTE_MODE_OPTIONS,
  delegationLabel,
  routeModeLabel,
} from '../../lib/routeLabels'
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
  effectiveRouteMode: import('@tandem/protocol').TurnRouteMode | undefined
  effectiveDelegation: import('@tandem/protocol').DelegationStrategy
  onChangeRouteMode: (mode: import('@tandem/protocol').TurnRouteMode | undefined) => void
  onChangeDelegation: (strategy: import('@tandem/protocol').DelegationStrategy) => void
  keepRouteMode: boolean
  onToggleKeepRouteMode: () => void
  uiProfiles: Profile[]
  currentProfileId: string
  currentGroupId: string | undefined
  currentModel: string
  autoRoute: boolean
  routedModel: string | undefined
  modelPrices: Record<string, ModelPriceInfo> | undefined
  pricesLoading: boolean
  effort: ReasoningEffort
  supportedEfforts: ReasoningEffort[]
  effortLabels: Partial<Record<ReasoningEffort, string>> | undefined
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
  effectiveRouteMode,
  effectiveDelegation,
  onChangeRouteMode,
  onChangeDelegation,
  keepRouteMode,
  onToggleKeepRouteMode,
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
          {!compact && (
            <Menu
              side="top"
              align="end"
              className="w-[268px]"
              aria-label="执行方式"
              trigger={({ open }) => (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  aria-haspopup="menu"
                  aria-label={`执行方式：${routeModeLabel(effectiveRouteMode)}`}
                  tooltip="本条消息的执行方式；委派倾向在同一菜单内设置"
                  tooltipSide="top"
                  className={cn(
                    'max-w-[148px] justify-start gap-1 px-2 font-normal',
                    open && 'bg-[var(--t-bg-hover)] text-text-soft',
                    effectiveRouteMode && 'text-text',
                  )}
                >
                  <GitFork size={12} className="shrink-0 opacity-70" />
                  <span className="truncate">{routeModeLabel(effectiveRouteMode)}</span>
                  {!effectiveRouteMode && <ChevronDown size={11} className="shrink-0 opacity-50" />}
                </Button>
              )}
            >
              <Menu.Item
                selected={!effectiveRouteMode}
                hint="按规则判断；简单任务单代理，只影响本条消息"
                onSelect={() => onChangeRouteMode(undefined)}
              >
                自动
              </Menu.Item>
              {ROUTE_MODE_OPTIONS.map((option) => (
                <Menu.Item
                  key={option.value}
                  selected={effectiveRouteMode === option.value}
                  hint={option.hint}
                  disabled={option.value === 'division' && effectiveDelegation === 'none'}
                  disabledReason="委派倾向已关闭；先在下方「委派倾向」中开启"
                  onSelect={() => onChangeRouteMode(option.value)}
                >
                  {option.label}
                </Menu.Item>
              ))}
              <Menu.Separator />
              <Menu.Sub>
                <Menu.SubTrigger
                  trailing={delegationLabel(effectiveDelegation)}
                  hint="会话级：控制子代理可用程度；与「本条消息」的执行方式配合"
                >
                  委派倾向
                </Menu.SubTrigger>
                <Menu.SubContent className="w-[220px]" aria-label="委派倾向">
                  <Menu.RadioGroup
                    value={effectiveDelegation}
                    onValueChange={(value) => onChangeDelegation(value as DelegationStrategy)}
                  >
                    {DELEGATION_ORDER.map((value) => (
                      <Menu.RadioItem key={value} value={value} hint={DELEGATION_META[value].hint}>
                        {DELEGATION_META[value].label}
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.SubContent>
              </Menu.Sub>
              <Menu.Separator />
              <Menu.Item
                keepOpen
                hint="记住当前选择，本会话后续消息都用这个执行方式"
                trailing={keepRouteMode ? '✓' : undefined}
                onSelect={onToggleKeepRouteMode}
              >
                记住为会话偏好
              </Menu.Item>
            </Menu>
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
