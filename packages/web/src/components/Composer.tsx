import { flushSync } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContentBlock,
  DelegationStrategy,
  PermissionMode,
  Profile,
  ReasoningEffort,
  SlashCommand,
} from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { usePreviewStore } from '../store/usePreviewStore'
import { useDemoStore } from '../store/useDemoStore'
import { selectionContextText, selectionLabel, selectionSource } from '../lib/previewElement'
import { useSessionTarget, useSessionView } from './session/SessionScope'
import { useIsMobile } from '../lib/hooks'
import { cn } from '../lib/cn'
import { loadLastEffort } from '../lib/effort'
import { loadDraft } from '../lib/storage'
import { Button, IconButton } from './ui/Button'
import { VoiceButton, type VoiceButtonHandle } from './voice/VoiceButton'
import { ConfirmAction } from './ui/ConfirmAction'
import { CompletionMenu } from './composer/CompletionMenu'
import { estimateInputTokens } from '../lib/tokens'
import { formatTokens } from '../lib/format'
import { ComposerCard } from './composer/ComposerCard'
import { useComposerStore } from './composer/useComposerStore'
import type { ComposerProps } from './composer/ComposerProps'
import { ComposerInputArea } from './composer/ComposerInputArea'
import { ComposerFooter } from './composer/ComposerFooter'
import { ModelSwitchConfirm } from './composer/ModelSwitchConfirm'
import { useComposerAttachments } from './composer/useComposerAttachments'
import { useComposerCompletion } from './composer/useComposerCompletion'
import { useComposerDraft } from './composer/useComposerDraft'
import { useComposerVoiceShortcut } from './composer/useComposerVoiceShortcut'
import { useComposerModelControls } from './composer/useComposerModelControls'
import { useComposerSend } from './composer/useComposerSend'
import {
  EMPTY_COMMANDS,
  EMPTY_PENDING,
  EMPTY_PROFILES,
  EMPTY_SELECTIONS,
  MAX_ATTACHMENTS,
  SOURCE_LABEL,
  type Attachment,
  type PastedText,
} from './composer/composerTypes'
import '../styles/chat.css'



export function Composer({
  onSubmit,
  sessionless = false,
  model: modelProp,
  profileId: profileIdProp,
  groupId: groupIdProp,
  permissionMode: permissionModeProp,
  onModelChange,
  routeBias: routeBiasProp,
  onRouteBiasChange,
  delegation: delegationProp,
  onDelegationChange,
  onPermissionModeChange,
  effort: effortProp,
  onEffortChange,
  hostId: hostIdProp,
  cwd: cwdProp,
  placeholder,
  autoFocus = false,
  disabled = false,
  className,
  running: runningProp,
  onStop,
  compact = false,
}: ComposerProps) {
  const {
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
    routeOverride,
    setRouteOverride,
    keepRouteMode,
    setKeepRouteMode,
    effectiveDelegation,
    effectiveRouteBias,
    currentProfileId,
    currentGroupId,
    contextUsed,
    contextWindow,
    localEffort,
    setLocalEffort,
    currentKind,
    effort,
    draftKey,
  } = useComposerStore({
    sessionless,
    modelProp,
    profileIdProp,
    groupIdProp,
    permissionModeProp,
    routeBiasProp,
    delegationProp,
    effortProp,
    hostIdProp,
    cwdProp,
    runningProp,
  })


  const [text, setText] = useState(() => loadDraft(draftKey))
  const [pasted, setPasted] = useState<PastedText[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [composing, setComposing] = useState(false)
  /** 切换模型/账号/分组会换掉缓存前缀：选中后先确认（反馈10#02）。 */
  const [pendingSwitch, setPendingSwitch] = useState<{
    profileId: string
    groupId?: string
    model: string
    tokens: number
  } | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const voiceRef = useRef<VoiceButtonHandle>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const worktreeBusyRef = useRef(false)
  const fileSeq = useRef(0)
  const prevSessionRef = useRef<string | null>(draftKey)
  const textRef = useRef(text)
  textRef.current = text



  const {
    completion,
    setCompletion,
    index,
    setIndex,
    fileItems,
    fileLoading,
    items,
    selectItem,
  } = useComposerCompletion({
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
    textareaRef,
  })

  useComposerDraft({
    draftKey,
    text,
    setText,
    textRef,
    textareaRef,
    prevSessionRef,
    setPasted,
    setAttachments,
    setCompletion,
    sessionId,
    composerResetNonce,
    seed,
    clearPromptSeed,
    scopeTarget,
    disabled,
    autoFocus,
    isMobile,
    sessionless,
  })

  const {
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
  } = useComposerModelControls({
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
    effectiveHost: effectiveHost ?? undefined,
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
  })

  const { addImages, onPaste, onDrop } = useComposerAttachments({
    attachments,
    setAttachments,
    setPasted,
    setDragging,
    toast,
  })

  const pastedText = pasted.map((p) => p.text).join('\n\n')
  const selectionContext = useMemo(
    () => (previewSelections.length ? selectionContextText(previewSelections) : ''),
    [previewSelections],
  )
  const outgoingText = [text.trim(), pastedText].filter(Boolean).join('\n\n')
  const estimatedText = [outgoingText, selectionContext].filter(Boolean).join('\n\n')
  const inputTokens = estimateInputTokens({ text: estimatedText, attachments: attachments.length })
  const contextLimit = contextWindow ?? modelContextWindow
  const expectedContext = contextUsed + inputTokens
  const expectedPct = contextLimit
    ? Math.min(100, (expectedContext / contextLimit) * 100)
    : undefined
  const hasContent =
    outgoingText.length > 0 || attachments.length > 0 || previewSelections.length > 0
  const canSend = hasContent && !disabled && (onSubmit ? true : !!summary)

  const {
    resetInput,
    handleSend,
    stop,
    applyTextEdit,
    onKeyDown,
    onChange,
    insertVoiceText,
  } = useComposerSend({
    text,
    setText,
    textRef,
    composingRef,
    textareaRef,
    draftKey,
    sessionId,
    isMobile,
    canSend,
    outgoingText,
    selectionContext,
    attachments,
    setPasted,
    setAttachments,
    setCompletion,
    setIndex,
    completion,
    items,
    index,
    selectItem,
    cycleMode,
    running,
    stopping,
    autoRoute,
    currentProfileId,
    currentGroupId,
    currentModel,
    summary,
    activeHostId,
    scopeTarget,
    hostStatus,
    pendingRequests,
    routeOverride,
    setRouteOverride,
    onSubmit,
    onStop,
    interrupt,
    ensureWorktree,
    send,
    worktreeBusyRef,
    openScheduleComposer,
    openMemoryEditor,
    toast,
    clearSelections: (id) => usePreviewStore.getState().clearSelections(id),
  })

  const sendState = running ? 'running' : canSend ? 'ready' : 'idle'

  useComposerVoiceShortcut({ disabled, scopeTarget, textareaRef, voiceRef })

  return (
    <div className={cn('relative', className)}>
      <ModelSwitchConfirm
        pendingSwitch={pendingSwitch}
        switchLabel={switchLabel}
        switchCost={switchCost}
        switchCostText={switchCostText}
        onConfirm={() => {
          const pick = pendingSwitch
          if (!pick) return
          setPendingSwitch(null)
          if (pick.model === 'auto') applyAutoRoute()
          else applyModelChange(pick.profileId, pick.groupId, pick.model)
        }}
        onClose={() => setPendingSwitch(null)}
      />
      {completion && (
        <div ref={menuRef}>
          <CompletionMenu
            completion={completion}
            items={items}
            index={index}
            loading={completion.kind === 'file' ? fileLoading : !commandsLoaded}
            onIndex={setIndex}
            onSelect={selectItem}
          />
        </div>
      )}

      <ComposerCard
        dragging={dragging}
        setDragging={setDragging}
        disabled={disabled}
        onDrop={onDrop}
      >
        <ComposerInputArea
          previewSelections={previewSelections}
          onRemoveSelection={(selection) => {
            if (sessionId) removePreviewSelection(sessionId, selection.id)
          }}
          attachments={attachments}
          onRemoveAttachment={(id) =>
            setAttachments((prev) => prev.filter((x) => x.id !== id))
          }
          pasted={pasted}
          onRemovePasted={(id) => setPasted((prev) => prev.filter((x) => x.id !== id))}
          text={text}
          composing={composing}
          disabled={disabled}
          placeholder={placeholder}
          running={running}
          textareaRef={textareaRef}
          highlightRef={highlightRef}
          composingRef={composingRef}
          setComposing={setComposing}
          setCompletion={setCompletion}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <ComposerFooter
          disabled={disabled}
          running={running}
          stopping={stopping}
          canSend={canSend}
          sendState={sendState}
          onSend={() => void handleSend()}
          onStop={stop}
          compact={compact}
          isMobile={isMobile}
          showSummary={!sessionless && !!summary && !compact}
          sessionless={sessionless}
          attachDisabled={disabled || attachments.length >= MAX_ATTACHMENTS}
          onAddImage={() => fileInputRef.current?.click()}
          voiceRef={voiceRef}
          onVoiceText={insertVoiceText}
          mode={mode}
          onChangeMode={changeMode}
          inputTokens={inputTokens}
          contextLimit={contextLimit}
          expectedContext={expectedContext}
          expectedPct={expectedPct}
          effectiveDelegation={effectiveDelegation}
          effectiveRouteBias={effectiveRouteBias}
          onChangeDelegation={applyDelegation}
          onChangeRouteBias={applyRouteBias}
          keepRouteMode={keepRouteMode}
          onToggleKeepRouteMode={toggleKeepRouteMode}
          uiProfiles={uiProfiles}
          currentProfileId={currentProfileId}
          currentGroupId={currentGroupId}
          currentModel={currentModel}
          autoRoute={autoRoute}
          routedModel={routedModel}
          modelPrices={modelPrices}
          pricesLoading={cachedPrices === 'loading'}
          effort={effort}
          supportedEfforts={supportedEfforts}
          effortLabels={modelEffortLabels}
          profilesLoading={profilesLoading}
          modelDisabled={disabled || (!sessionless && !summary)}
          modelMenuOpen={modelMenuOpen}
          onModelMenuOpenChange={setModelMenuOpen}
          onChangeModel={changeModel}
          onChangeAutoRoute={changeAutoRoute}
          onLoadPrices={loadModelPrices}
          onChangeEffort={changeEffort}
          onManageModels={() => openSettings('profiles')}
          onSetupPrice={() => {
            setModelMenuOpen(false)
            if (currentProfileId) focusSetting('profiles', `profiles.prices:${currentProfileId}`)
            else openSettings('profiles')
          }}
          onOpenModelMenu={() => {
            if (effectiveHostId && uiProfiles.length === 0 && !profilesLoading) {
              void refreshProfiles(effectiveHostId)
            }
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length) void addImages(files)
          }}
        />
      </ComposerCard>
    </div>
  )
}

