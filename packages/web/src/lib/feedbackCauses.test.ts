import { describe, expect, it } from 'vitest'
import { suggestCause } from './feedbackCauses'

const causeOf = (text: string, selector = '', component = '') =>
  suggestCause({ text, selector, component })?.id

describe('反馈根因建议', () => {
  it('轮次大纲/审批描述截断归 R15，而不是弹层裁切 R03', () => {
    expect(
      causeOf(
        '轮次大纲每行文本被截断成省略号，悬停没有 tooltip，读屏软件也无法知道每轮是什么。',
        'nav.turn-rail > div.turn-clip > div.turn-item > span.turn-item-t',
        'Sz',
      ),
    ).toBe('R15')
    expect(
      causeOf('手机审批卡的任务描述仍截成一行，看不到全文。', '', 'PermissionCard'),
    ).toBe('R15')
  })

  it('改动审阅面板空白/布局问题归 R14', () => {
    expect(
      causeOf(
        '改动审阅右侧面板中间约 350px 空白，diff 要到面板中段才出现，长行被右边缘截断。',
        'aside.relative.flex > div.flex.min-h-0 > div.min-h-\\[64px\\].shrink-0',
        'lV',
      ),
    ).toBe('R14')
  })

  it('价格入口、压缩轮次等非浮层文案不再误判 R03', () => {
    expect(
      causeOf('模型菜单里两个模型仍都写单价未设置，看不到任何参考价。', '#radix-_r_2l_ > div', 'Hb'),
    ).not.toBe('R03')
    expect(
      causeOf('当前会话的 8 轮对话会被压成一段摘要，把工具结果也当成了用户轮次。', '', 'vx'),
    ).not.toBe('R03')
  })

  it('真正的浮层越界仍归 R03', () => {
    expect(
      causeOf('模型下拉菜单被遮住，弹层越界到屏幕外。', '#radix-test > [role="menuitem"]', 'unknown'),
    ).toBe('R03')
  })
})
