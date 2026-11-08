/** 从演示工作区/体验清单打开场景：会按目标切到会话、看板、设置或面板。 */
import type { DemoScenarioInfo } from '@tandem/protocol'
import type { HostConfig, SettingsTab } from './types'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useDemoStore } from '../store/useDemoStore'
import { useDevicesStore } from '../store/useDevicesStore'
import { useEvalStore } from '../store/useEvalStore'
import { useFeedbackStore } from '../store/useFeedbackStore'
import { api } from './api'
import { navigateBoard } from './boardRoute'
import { navigate } from './router'
import type { ChecklistAction } from './testPoints'

function hostOf(hostId?: string): HostConfig | undefined {
  const app = useAppStore.getState()
  const id = hostId ?? app.activeHostId ?? app.hosts[0]?.id
  return app.hosts.find((host) => host.id === id)
}

function after(ms: number, fn: () => void): void {
  window.setTimeout(fn, ms)
}

export async function openDemoScenario(
  scenario: DemoScenarioInfo,
  host: HostConfig | undefined = hostOf(),
): Promise<void> {
  if (!host) return
  const ui = useUiStore.getState()
  const sessionId = scenario.sessionIds?.[0]
  if (scenario.kind === 'board' && scenario.boardId) {
    navigateBoard(host.id, scenario.boardId)
    return
  }
  if (scenario.kind === 'settings' || scenario.kind === 'eval') {
    ui.openSettings((scenario.settingsTab ?? 'general') as SettingsTab)
    if (scenario.evalRunId) {
      const evals = useEvalStore.getState()
      await evals.refreshRuns(host)
      evals.selectRun(host.id, scenario.evalRunId)
      void evals.loadRun(host, scenario.evalRunId)
      evals.selectRun(host.id, scenario.evalRunId)
    }
    return
  }
  if (scenario.kind === 'inbox') {
    ui.setInboxOpen(true)
    return
  }
  if (scenario.kind === 'wiki' && scenario.project && !sessionId) {
    ui.openWiki({ project: scenario.project })
    return
  }
  if (!sessionId) {
    ui.toast('这个演示场景还没有数据，请点「重新播放」', 'info')
    return
  }
  navigate({ kind: 'session', hostId: host.id, sessionId })
  if (scenario.kind === 'wiki' && scenario.project) {
    after(700, () => useUiStore.getState().openWiki({ project: scenario.project! }))
  }
  after(500, () => {
    const current = useUiStore.getState()
    if (scenario.panel === 'changes') current.setChangesOpen(true)
    else if (scenario.panel === 'agents') current.setPanelOpen(true)
    else if (scenario.panel === 'background') current.openBackgroundTasks(host.id, sessionId)
    else if (scenario.panel === 'preview') current.openPreviewPanel(host.id, sessionId)
  })
  if (scenario.playable) {
    after(900, () => {
      void api.playDemo(host, scenario.id).catch(() => undefined)
    })
  }
}

export async function openDemoById(scenarioId: string): Promise<boolean> {
  const host = hostOf()
  if (!host) return false
  let state = useDemoStore.getState().byHost[host.id]
  if (!state) state = await useDemoStore.getState().load(host)
  const scenario = state?.scenarios.find((item) => item.id === scenarioId)
  if (!scenario) return false
  await openDemoScenario(scenario, host)
  return true
}

export async function openChecklistAction(
  action: { demo?: string; settingsTab?: SettingsTab; action?: ChecklistAction },
  host: HostConfig | undefined = hostOf(),
): Promise<void> {
  if (!host) return
  if (action.action) {
    const ui = useUiStore.getState()
    if (action.action === 'split') ui.setSplitPickerOpen(true)
    else if (action.action === 'search' || action.action === 'command') ui.setSearchOpen(true)
    else if (action.action === 'clear-demo') ui.setDemoOpen(true)
    else if (action.action === 'feedback') useFeedbackStore.getState().enter()
    else if (action.action === 'workstation') useDevicesStore.getState().setWorkstationOpen(true)
    return
  }
  if (action.settingsTab) {
    useUiStore.getState().openSettings(action.settingsTab)
    return
  }
  if (!action.demo) return
  let state = useDemoStore.getState().byHost[host.id]
  if (!state) state = await useDemoStore.getState().load(host)
  const scenario = state?.scenarios.find((item) => item.id === action.demo)
  if (!scenario) {
    useUiStore.getState().toast('演示场景尚未创建，请先在「演示工作区」一键创建', 'info')
    return
  }
  await openDemoScenario(scenario, host)
}
