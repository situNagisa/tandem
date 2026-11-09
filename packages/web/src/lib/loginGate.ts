import { readRaw, removeRaw, writeRaw } from './storage'

// 登录门：打开 Tandem 先登录工作站，登录后才进入工作台。
// 只有调试版可以用测试开关跳过（e2e 与老的「地址 + token」直连回归用），发布版没有任何绕过入口。
const SKIP_KEY = 'tandem.gate.skip'

/** 调试版测试开关：`?gate=off` 写入 localStorage，`?gate=on` 清除。 */
export function loginGateSkipped(): boolean {
  if (!__TANDEM_DEBUG__) return false
  try {
    const param = new URL(window.location.href).searchParams.get('gate')
    if (param === 'off') writeRaw(SKIP_KEY, '1')
    else if (param === 'on') removeRaw(SKIP_KEY)
    return readRaw(SKIP_KEY) === '1'
  } catch {
    return false
  }
}

export function loginGateEnabled(): boolean {
  return !loginGateSkipped()
}
