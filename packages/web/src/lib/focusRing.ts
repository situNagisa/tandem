// 焦点环只在键盘导航时出现。
// 文本输入框在鼠标点击或程序化聚焦后同样命中 :focus-visible，
// 直接按 :focus-visible 画环会让「点开弹层后自动聚焦的输入框」闪出焦点环。
// 这里记录最近一次输入方式，CSS 只在 data-input-modality="keyboard" 时画环。

const NAV_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

function isTextEntry(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'].includes(type)
}

let installed = false

export function installFocusRing(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  const root = document.documentElement
  const mark = (modality: 'pointer' | 'keyboard') => {
    if (root.dataset.inputModality !== modality) root.dataset.inputModality = modality
  }
  window.addEventListener('pointerdown', () => mark('pointer'), { capture: true, passive: true })
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Tab') {
        mark('keyboard')
        return
      }
      // 在文本输入框里按方向键只是移动光标，不算键盘导航。
      if (NAV_KEYS.has(event.key) && !isTextEntry(document.activeElement)) mark('keyboard')
    },
    { capture: true },
  )
}
