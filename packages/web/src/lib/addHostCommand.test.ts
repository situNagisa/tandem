import { expect, test } from 'vitest'
import {
  buildAddHostCommands,
  defaultAddHostPlatform,
  isLoopbackUrl,
  maskToken,
  normalizeWorkstationUrl,
  pickShareUrl,
} from './addHostCommand'

const TOKEN = 'ach_0123456789abcdef'

test('Linux / macOS 一行命令使用 install.sh', () => {
  expect(
    buildAddHostCommands({
      workstationUrl: 'http://192.168.1.10:8481',
      token: TOKEN,
      platform: 'linux',
    }).oneLiner,
  ).toBe('curl -fsSL http://192.168.1.10:8481/install.sh | sh -s -- --token ach_0123456789abcdef')
  expect(
    buildAddHostCommands({
      workstationUrl: 'http://192.168.1.10:8481',
      token: TOKEN,
      platform: 'macos',
    }).oneLiner,
  ).toBe('curl -fsSL http://192.168.1.10:8481/install.sh | sh -s -- --token ach_0123456789abcdef')
})

test('Windows PowerShell 一行命令使用 install.ps1 并带引号令牌', () => {
  expect(
    buildAddHostCommands({
      workstationUrl: 'http://192.168.1.10:8481',
      token: TOKEN,
      platform: 'windows',
    }).oneLiner,
  ).toBe("& ([scriptblock]::Create((irm http://192.168.1.10:8481/install.ps1))) -Token 'ach_0123456789abcdef'")
})

test('已装 tandem-host 的 join 命令与平台无关', () => {
  const expected = 'tandem-host join http://192.168.1.10:8481 --token ach_0123456789abcdef --service'
  for (const platform of ['linux', 'macos', 'windows'] as const) {
    expect(
      buildAddHostCommands({ workstationUrl: 'http://192.168.1.10:8481', token: TOKEN, platform })
        .installed,
    ).toBe(expected)
  }
})

test('结尾斜杠与空白会被去掉', () => {
  expect(
    buildAddHostCommands({
      workstationUrl: '  http://192.168.1.10:8481///  ',
      token: TOKEN,
      platform: 'linux',
    }).oneLiner,
  ).toBe('curl -fsSL http://192.168.1.10:8481/install.sh | sh -s -- --token ach_0123456789abcdef')
  expect(normalizeWorkstationUrl('https://ws.example.com/')).toBe('https://ws.example.com')
  expect(normalizeWorkstationUrl('https://ws.example.com///')).toBe('https://ws.example.com')
})

test('登录地址不是回环时直接使用，状态里的局域网地址作为候选', () => {
  const result = pickShareUrl('http://192.168.1.10:8481/', [
    'http://127.0.0.1:8481',
    'http://192.168.1.10:8481',
    'http://10.0.0.5:8481',
  ])
  expect(result.url).toBe('http://192.168.1.10:8481')
  expect(result.candidates).toEqual(['http://192.168.1.10:8481', 'http://10.0.0.5:8481'])
  expect(result.loopbackOnly).toBe(false)
})

test('登录地址是回环时替换成第一个非回环地址', () => {
  const result = pickShareUrl('http://127.0.0.1:8481', [
    'http://localhost:8481',
    'http://192.168.1.10:8481',
    'http://10.0.0.5:8481',
  ])
  expect(result.url).toBe('http://192.168.1.10:8481')
  expect(result.candidates).toEqual(['http://192.168.1.10:8481', 'http://10.0.0.5:8481'])
  expect(result.loopbackOnly).toBe(false)
})

test('只有回环地址时 loopbackOnly=true 并保留登录地址', () => {
  const result = pickShareUrl('http://127.0.0.1:8481', ['http://localhost:8481', 'http://[::1]:8481'])
  expect(result.url).toBe('http://127.0.0.1:8481')
  expect(result.candidates).toEqual(['http://127.0.0.1:8481', 'http://localhost:8481', 'http://[::1]:8481'])
  expect(result.loopbackOnly).toBe(true)
})

test('登录地址为空时从状态地址里挑非回环', () => {
  const result = pickShareUrl('', ['http://127.0.0.1:8481', 'http://192.168.1.10:8481'])
  expect(result.url).toBe('http://192.168.1.10:8481')
  expect(result.loopbackOnly).toBe(false)
})

test('isLoopbackUrl 识别常见回环写法', () => {
  expect(isLoopbackUrl('http://127.0.0.1:8481')).toBe(true)
  expect(isLoopbackUrl('http://localhost:8481')).toBe(true)
  expect(isLoopbackUrl('http://[::1]:8481')).toBe(true)
  expect(isLoopbackUrl('http://192.168.1.10:8481')).toBe(false)
  expect(isLoopbackUrl('not a url')).toBe(false)
})

test('按 UA 选择默认平台', () => {
  expect(
    defaultAddHostPlatform(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    ),
  ).toBe('windows')
  expect(
    defaultAddHostPlatform(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    ),
  ).toBe('macos')
  expect(
    defaultAddHostPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'),
  ).toBe('linux')
  expect(defaultAddHostPlatform('Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36')).toBe('linux')
})

test('maskToken 只保留前缀', () => {
  expect(maskToken('token=ach_0123456789abcdef done')).toBe('token=ach_**** done')
  expect(maskToken('& ([scriptblock]::Create((irm http://h:1/install.ps1))) -Token \'ach_abc-DEF_123\'')).toBe(
    "& ([scriptblock]::Create((irm http://h:1/install.ps1))) -Token 'ach_****'",
  )
  expect(maskToken('没有令牌')).toBe('没有令牌')
})
