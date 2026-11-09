import { describe, expect, it } from 'vitest'
import { crc32, createZip, readZipEntries } from './zipStore'
import { buildFeedbackArchive } from './feedbackArchive'
import type { FeedbackItem, FeedbackPageShot } from './feedback'

function base64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

const PNG = `data:image/png;base64,${base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])}`
const REF = `data:image/png;base64,${base64([1, 2, 3, 4])}`

const item: FeedbackItem = {
  id: 'fb-test',
  type: 'issue',
  text: '按钮点不动',
  selector: 'button.save',
  textSnippet: '保存',
  route: '#/chat',
  rect: { x: 10, y: 20, width: 30, height: 40, pageX: 10, pageY: 20 },
  viewport: { width: 1200, height: 800 },
  dpr: 2,
  theme: 'dark',
  platform: 'web',
  ua: 'test',
  createdAt: 1_700_000_000_000,
  screenshot: PNG,
  screenshotKind: 'element',
  annotatedScreenshot: PNG,
  references: [{ id: 'ref-1', name: '参考.png', dataURL: REF, addedAt: 1 }],
  trace: [{ time: 1_700_000_000_000, kind: 'click', detail: '点击保存' }],
  snapshot: {
    capturedAt: 1_700_000_000_000,
    route: '#/chat',
    viewport: { width: 1200, height: 800, dpr: 2 },
    theme: 'dark',
    hidePaths: false,
    client: { platform: 'web', language: 'zh-CN', ua: 'test' },
    ui: {},
    session: { id: 's1', title: '会话', messageCount: 3 },
  },
  featureId: 'composer',
  featureName: '输入框',
  causeId: 'R01',
  causeTitle: '弹层裁切',
}

const pageShot: FeedbackPageShot = {
  id: 'page-1',
  route: '#/chat',
  dataURL: PNG,
  width: 1200,
  height: 800,
  createdAt: 1_700_000_000_000,
}

describe('zip store', () => {
  it('crc32 与标准值一致', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('写入后能原样读回（UTF-8 文件名、二进制不受损）', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255])
    const zip = createZip([
      { name: 'README.txt', data: new TextEncoder().encode('你好') },
      { name: '01-元素截图.png', data: bytes },
    ])
    const entries = readZipEntries(zip)
    expect(entries.map((entry) => entry.name)).toEqual(['README.txt', '01-元素截图.png'])
    expect(new TextDecoder().decode(entries[0].data)).toBe('你好')
    expect([...entries[1].data]).toEqual([...bytes])
  })
})

describe('反馈包 .tfb', () => {
  it('包里是正常文件：manifest、feedback.md、逐条截图/快照/轨迹、整页截图、体验清单', () => {
    const archive = buildFeedbackArchive({
      items: [item],
      pageShots: [pageShot],
      errors: [],
      env: { route: '#/chat', viewport: { width: 1200, height: 800 }, dpr: 2, theme: 'dark' },
      app: { name: 'Tandem', version: '0.4.2', client: 'web' },
      checklistMarkdown: '# 体验清单\n',
      draftId: '草稿-20261109-1530',
      draftStartedAt: 1_700_000_000_000,
      exportedAt: null,
    })
    expect(archive.filename).toMatch(/^tandem-feedback-\d{8}-\d{4}\.tfb$/)
    const entries = readZipEntries(archive.bytes)
    const names = entries.map((entry) => entry.name)
    for (const expected of [
      'manifest.json',
      'feedback.md',
      '体验清单.md',
      '01-元素截图.png',
      '01-标注截图.png',
      '01-参考-1.png',
      '01-快照.json',
      '01-轨迹.md',
      'page-1.png',
    ]) {
      expect(names).toContain(expected)
    }
    // 图片是原始字节，不再塞进 JSON
    const screenshot = entries.find((entry) => entry.name === '01-元素截图.png')
    expect([...(screenshot?.data ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((entry) => entry.name === 'manifest.json')?.data),
    )
    expect(manifest.format).toBe('tfb')
    expect(manifest.draft.id).toBe('草稿-20261109-1530')
    expect(manifest.items[0].text).toBe('按钮点不动')
    expect(manifest.items[0].files.screenshot).toBe('01-元素截图.png')
    expect(manifest.items[0].files.trace).toBe('01-轨迹.md')
    expect(manifest.items[0].screenshot).toBeUndefined()
    expect(manifest.items[0].trace).toBeUndefined()
    expect(manifest.items[0].files.references[0].file).toBe('01-参考-1.png')
    expect(manifest.pageShots[0].file).toBe('page-1.png')
    const markdown = new TextDecoder().decode(
      entries.find((entry) => entry.name === 'feedback.md')?.data,
    )
    expect(markdown).toContain('### 01. 问题')
    expect(markdown).toContain('`01-元素截图.png`')
    expect(markdown).toContain('根因建议：R01')
    expect(markdown).toContain('草稿：`草稿-20261109-1530`')
  })
})
