/** 发布版替身：反馈模式不存在，所有读取都返回未激活。 */
const state = {
  active: false,
  enter: () => undefined,
  exit: () => undefined,
}

export const useFeedbackStore = Object.assign(
  <T>(selector: (value: typeof state) => T): T => selector(state),
  {
    getState: () => state,
    subscribe: () => () => undefined,
  },
)
