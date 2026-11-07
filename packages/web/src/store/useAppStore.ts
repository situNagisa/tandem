import { create } from 'zustand'
import type { ServerMsg } from '@tandem/protocol'
import type { AppState } from './appStore/types'
import { createSessionCore } from './appStore/sessionCore'
import { createServerMessageHandler } from './appStore/serverMessages'
import { createHostsSlice } from './appStore/hostsSlice'
import { createSessionsSlice } from './appStore/sessionsSlice'
import { createMessagesSlice } from './appStore/messagesSlice'
import { createInboxSlice } from './appStore/inboxSlice'
import { createWorktreeSlice } from './appStore/worktreeSlice'
import { createUiSlice } from './appStore/uiSlice'

export type { HostInboxState } from './appStore/types'
export { depthOf } from './appStore/helpers'

export const useAppStore = create<AppState>((set, get) => {
  let handleServerMessage: (hostId: string, msg: ServerMsg) => void = () => {}
  const core = createSessionCore(set, get, (hostId, msg) => handleServerMessage(hostId, msg))
  handleServerMessage = createServerMessageHandler(set, get, core)

  return {
    initialized: false,
    hosts: [],
    activeHostId: null,
    runtimes: {},
    externalSessions: {},
    inbox: {},
    active: null,
    sessionViews: {},
    changesNonce: 0,
    worktreeIntents: {},

    ...createHostsSlice(set, get, core),
    ...createSessionsSlice(set, get, core),
    ...createMessagesSlice(set, get, core),
    ...createInboxSlice(set, get, core),
    ...createWorktreeSlice(set, get, core),
    ...createUiSlice(set, get),
  }
})
