import { create } from 'zustand'
import type { DeviceAccess, DeviceListResult, DeviceMount, SessionDevices } from '@tandem/protocol'
import type { ServerMsg } from '@tandem/protocol'
import { api } from '../lib/api'
import type { HostConfig } from '../lib/types'
import { isDraftSession } from '../lib/draftSession'

export interface SerialView {
  text: string
  cursor: number
  alive: boolean
  truncated?: boolean
}

export interface SerialTerminalState {
  hostId: string
  sessionId: string
  mountId: string
  deviceId: string
  name: string
  baud: number
  opening?: boolean
  writable?: boolean
  error?: string
}

interface DevicesState {
  byHost: Record<string, DeviceListResult>
  errors: Record<string, string>
  loading: Record<string, boolean>
  sessionMounts: Record<string, DeviceMount[]>
  workstationOpen: boolean
  terminal?: SerialTerminalState
  serial: Record<string, SerialView>

  setWorkstationOpen: (open: boolean) => void
  refreshHost: (host: HostConfig) => Promise<void>
  checkAccess: (host: HostConfig, deviceId: string) => Promise<DeviceAccess>
  refreshAll: (hosts: HostConfig[]) => Promise<void>
  refreshSession: (host: HostConfig, sessionId: string) => Promise<void>
  mountDevice: (
    sessionHost: HostConfig,
    sessionId: string,
    deviceId: string,
    sourceHost: HostConfig,
    name?: string,
  ) => Promise<void>
  unmountDevice: (host: HostConfig, sessionId: string, mountId: string) => Promise<void>
  openTerminal: (host: HostConfig, sessionId: string, mount: DeviceMount, baud?: number) => Promise<void>
  hideTerminal: () => void
  releaseSerial: (host: HostConfig) => Promise<void>
  pollSerial: (host: HostConfig) => Promise<void>
  sendSerial: (host: HostConfig, data: string) => Promise<void>
  applyOutput: (hostId: string, msg: Extract<ServerMsg, { type: 'device_output' }>) => void
  onDevicesUpdated: (host: HostConfig, sessionId?: string) => void
  clearSession: (hostId: string, sessionId: string) => void
}

const MAX_SERIAL = 1_000_000
const keyOf = (hostId: string, sessionId: string, mountId: string) => `${hostId}:${sessionId}:${mountId}`
const sessionKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`

export const useDevicesStore = create<DevicesState>((set, get) => ({
  byHost: {},
  errors: {},
  loading: {},
  sessionMounts: {},
  workstationOpen: false,
  serial: {},

  setWorkstationOpen: (open) => set({ workstationOpen: open }),

  refreshHost: async (host) => {
    set((s) => ({ loading: { ...s.loading, [host.id]: true }, errors: { ...s.errors, [host.id]: '' } }))
    try {
      const result = await api.devices(host)
      set((s) => ({ byHost: { ...s.byHost, [host.id]: result }, loading: { ...s.loading, [host.id]: false } }))
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, [host.id]: false },
        errors: { ...s.errors, [host.id]: (err as Error).message },
      }))
    }
  },

  refreshAll: async (hosts) => {
    await Promise.all(hosts.map((host) => get().refreshHost(host)))
  },

  // 串口权限深度检测：Host 会短暂打开端口，结果写回设备列表。
  checkAccess: async (host, deviceId) => {
    const access = await api.deviceAccessCheck(host, deviceId)
    set((s) => {
      const list = s.byHost[host.id]
      if (!list) return s
      return {
        byHost: {
          ...s.byHost,
          [host.id]: {
            ...list,
            devices: list.devices.map((device) =>
              device.id === deviceId ? { ...device, access } : device,
            ),
          },
        },
      }
    })
    return access
  },

  refreshSession: async (host, sessionId) => {
    if (!sessionId || isDraftSession(sessionId)) return
    try {
      const data: SessionDevices = await api.sessionDevices(host, sessionId)
      set((s) => ({ sessionMounts: { ...s.sessionMounts, [sessionKey(host.id, sessionId)]: data.mounts } }))
    } catch {
      // 会话可能已删除；保持旧数据，下一次刷新覆盖
    }
  },

  mountDevice: async (sessionHost, sessionId, deviceId, sourceHost, name) => {
    if (sourceHost.id === sessionHost.id) {
      await api.mountDevice(sessionHost, sessionId, { deviceId, ...(name ? { name } : {}) })
    } else {
      const issued = await api.issueDevicePeerToken(sourceHost, `Tandem ${sessionHost.name}`)
      await api.mountDevice(sessionHost, sessionId, {
        deviceId,
        peerUrl: sourceHost.url,
        peerToken: issued.token,
        ...(name ? { name } : {}),
      })
      await get().refreshHost(sourceHost)
    }
    await get().refreshSession(sessionHost, sessionId)
    await get().refreshHost(sessionHost)
  },

  unmountDevice: async (host, sessionId, mountId) => {
    await api.unmountDevice(host, sessionId, mountId)
    await get().refreshSession(host, sessionId)
  },

  openTerminal: async (host, sessionId, mount, baud = 115200) => {
    const terminal: SerialTerminalState = {
      hostId: host.id,
      sessionId,
      mountId: mount.id,
      deviceId: mount.deviceId,
      name: mount.name,
      baud,
      opening: true,
    }
    set({ terminal, serial: { ...get().serial, [keyOf(host.id, sessionId, mount.id)]: { text: '', cursor: 0, alive: false } } })
    try {
      const opened = await api.serialOpen(host, sessionId, mount.id, baud)
      set((s) => ({
        terminal: s.terminal ? { ...s.terminal, opening: false, writable: opened.writable } : undefined,
        serial: { ...s.serial, [keyOf(host.id, sessionId, mount.id)]: { text: '', cursor: 0, alive: true } },
      }))
      const first = await api.serialRead(host, sessionId, mount.id, { since: 0 })
      set((s) => ({
        serial: {
          ...s.serial,
          [keyOf(host.id, sessionId, mount.id)]: {
            text: first.data,
            cursor: first.cursor,
            alive: first.alive,
            ...(first.truncated ? { truncated: true } : {}),
          },
        },
      }))
    } catch (err) {
      set((s) => ({
        terminal: s.terminal ? { ...s.terminal, opening: false, error: (err as Error).message } : undefined,
      }))
    }
  },

  hideTerminal: () => set({ terminal: undefined }),

  releaseSerial: async (host) => {
    const terminal = get().terminal
    if (!terminal) return
    try {
      await api.serialClose(host, terminal.sessionId, terminal.mountId)
    } catch {
      // 已关闭
    }
    set((s) => {
      const key = keyOf(terminal.hostId, terminal.sessionId, terminal.mountId)
      const next = { ...s.serial }
      delete next[key]
      return { terminal: undefined, serial: next }
    })
  },

  pollSerial: async (host) => {
    const terminal = get().terminal
    if (!terminal || terminal.opening) return
    const key = keyOf(terminal.hostId, terminal.sessionId, terminal.mountId)
    const view = get().serial[key]
    if (!view) return
    try {
      const res = await api.serialRead(host, terminal.sessionId, terminal.mountId, {
        since: view.cursor,
        waitMs: 0,
        maxBytes: 60_000,
      })
      if (res.data || res.cursor !== view.cursor || res.alive !== view.alive) {
        set((s) => {
          const current = s.serial[key]
          if (!current) return s
          const text = res.data ? `${current.text}${res.data}` : current.text
          return {
            serial: {
              ...s.serial,
              [key]: {
                text: text.length > MAX_SERIAL ? text.slice(-MAX_SERIAL) : text,
                cursor: Math.max(current.cursor, res.cursor),
                alive: res.alive,
                ...(res.truncated || current.truncated ? { truncated: true } : {}),
              },
            },
          }
        })
      }
    } catch {
      // 下一次轮询继续
    }
  },

  sendSerial: async (host, data) => {
    const terminal = get().terminal
    if (!terminal) return
    await api.serialWrite(host, terminal.sessionId, terminal.mountId, data)
  },

  applyOutput: (hostId, msg) => {
    const key = keyOf(hostId, msg.sessionId, msg.mountId)
    set((s) => {
      const current = s.serial[key]
      if (!current || msg.cursor <= current.cursor) return s
      const text = `${current.text}${msg.chunk}`
      return {
        serial: {
          ...s.serial,
          [key]: {
            ...current,
            text: text.length > MAX_SERIAL ? text.slice(-MAX_SERIAL) : text,
            cursor: msg.cursor,
            alive: true,
          },
        },
      }
    })
  },

  onDevicesUpdated: (host, sessionId) => {
    void get().refreshHost(host)
    if (sessionId) void get().refreshSession(host, sessionId)
  },

  clearSession: (hostId, sessionId) => {
    const prefix = sessionKey(hostId, sessionId)
    set((s) => {
      const mounts = { ...s.sessionMounts }
      delete mounts[prefix]
      return { sessionMounts: mounts }
    })
  },
}))

