import type { StoreApi } from 'zustand'
import { useUiStore } from '../useUiStore'
import type { AppState } from './types'

export type UiSlice = Pick<AppState, 'bumpChanges' | 'openFileBrowser'>

export function createUiSlice(set: StoreApi<AppState>['setState'], get: StoreApi<AppState>['getState']): UiSlice {
  return {
    bumpChanges: () => set((state) => ({ changesNonce: state.changesNonce + 1 })),

    openFileBrowser: (path) => {
      const cwd = get().active?.summary?.cwd
      if (!cwd) {
        useUiStore.getState().toast('当前会话没有工作目录', 'error')
        return
      }
      const ui = useUiStore.getState()
      ui.setFileBrowserVisible(true)
      ui.openFilePreview({ path: path ?? '', cwd })
    },
  }
}
