type Listener = () => void

const listeners = new Set<Listener>()
let timer: number | undefined

/**
 * 共享的「每分钟」时钟：消息时间里的相对时间（刚刚 / x 分钟前）需要每分钟刷新，
 * 但一条会话可能同时挂几百条消息，不能每条各开一个 interval。
 */
export function subscribeMinute(listener: Listener): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    timer = window.setInterval(() => {
      for (const item of [...listeners]) item()
    }, 60_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}
