import { expect, test } from 'vitest'
import { isDesktopLocalHost } from './desktopFolder'

test('桌面版且主机 hostId 等于内嵌 Host 时用系统文件夹对话框', () => {
  expect(
    isDesktopLocalHost({
      isDesktop: true,
      selectedHostId: 'host-embedded',
      localHostId: 'host-embedded',
    }),
  ).toBe(true)
})

test('远程主机 / WSL Host 的 hostId 不同，回退应用内目录浏览器', () => {
  expect(
    isDesktopLocalHost({
      isDesktop: true,
      selectedHostId: 'host-wsl',
      localHostId: 'host-windows',
    }),
  ).toBe(false)
})

test('网页、手机或信息缺失时一律按非本机处理', () => {
  expect(
    isDesktopLocalHost({
      isDesktop: false,
      selectedHostId: 'host-a',
      localHostId: 'host-a',
    }),
  ).toBe(false)
  expect(isDesktopLocalHost({ isDesktop: true, selectedHostId: '', localHostId: '' })).toBe(false)
  expect(isDesktopLocalHost({ isDesktop: true, selectedHostId: null, localHostId: 'host-a' })).toBe(
    false,
  )
  expect(isDesktopLocalHost({ isDesktop: true, selectedHostId: 'host-a', localHostId: undefined })).toBe(
    false,
  )
})
