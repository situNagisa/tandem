/** 发布版替身：演示工作区不存在，读取永远为空。 */
const state = {
  byHost: {} as Record<string, undefined>,
  loading: {} as Record<string, boolean>,
  error: {} as Record<string, string | undefined>,
  load: async () => undefined,
  create: async () => undefined,
  clear: async () => false,
  replay: async () => undefined,
  apply: () => undefined,
}

export const useDemoStore = Object.assign(
  <T>(selector: (value: typeof state) => T): T => selector(state),
  { getState: () => state },
)
