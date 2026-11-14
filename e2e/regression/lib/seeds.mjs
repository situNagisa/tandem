/**
 * 回归夹具：临时 Host、造数、Workstation、API/WebSocket 快照与无障碍检查。
 * 全部在本机回环与临时目录内运行，不读真实 Key、不碰 ~/.tandem。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { AxeBuilder } from '@axe-core/playwright'
import WebSocket from 'ws'
import { HOST_ENTRY, ROOT, sleep } from './common.mjs'

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** 启动工作站进程；本机主机上下文的数据在 <工作站>/local-host/。 */
export function startHost({ home, token, hostId, extraEnv = {} }) {
  mkdirSync(home, { recursive: true })
  const wsHome = path.join(home, 'tandem')
  const configDir = path.join(wsHome, 'local-host')
  // 假 adb：工作站用例模拟一台手机；序列号可由 FAKE_ADB_SERIAL 覆盖。
  const fakeAdb = path.join(home, 'fake-adb.sh')
  writeFileSync(
    fakeAdb,
    `#!/usr/bin/env bash
set -u
SERIAL="\${FAKE_ADB_SERIAL:-R58M1234}"
MODEL="\${FAKE_ADB_DEVICE:-SM_G950F}"
case "$1" in
  devices)
    echo "List of devices attached"
    echo "\${SERIAL}           device product:reg model:\${MODEL} device:reg transport_id:1"
    ;;
  -s)
    shift; serial="$1"; shift; cmd="\${1:-}"; shift || true
    case "$cmd" in
      shell)
        remote="\${*:-}"
        case "$remote" in
          "getprop ro.product.model") echo "\${MODEL}" ;;
          "getprop ro.build.version.release") echo "14" ;;
          *) echo "[fake-adb \${serial}] shell: \${remote}" ;;
        esac
        ;;
      logcat)
        n=0
        while true; do
          n=$((n+1))
          echo "11-08 12:00:00.000  1234  1234 I FakeApp: device log \${n}"
          sleep 0.3
        done
        ;;
      *) echo "[fake-adb \${serial}] \${cmd} \${*:-}" ;;
    esac
    ;;
  *) echo "[fake-adb] $*" ;;
esac
`,
  )
  chmodSync(fakeAdb, 0o755)
  // 假 gh：PR 聚合用例只打本地 bare 仓库，不连公网。其它用例不会调用它。
  const fakeGh = path.join(home, 'fake-gh')
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require('node:fs')
const { execSync } = require('node:child_process')
const args = process.argv.slice(2)
const state = ${JSON.stringify(path.join(home, 'gh-state.json'))}
const log = ${JSON.stringify(path.join(home, 'gh.log'))}
if (args[0] === '--version') { console.log('gh version 2.60.0 (fake)'); process.exit(0) }
if (args[0] === 'auth') { console.log('github.com\\n  ✓ Logged in to github.com account reg-tester (keyring)'); process.exit(0) }
if (args[0] === 'pr' && args[1] === 'create') {
  const title = args[args.indexOf('--title') + 1] || 'PR'
  const body = args[args.indexOf('--body') + 1] || ''
  const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim()
  const info = {
    number: 9,
    url: 'https://github.com/reg/board/pull/9',
    title,
    body,
    branch,
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/reg/board/actions/runs/1' },
    ],
  }
  fs.writeFileSync(state, JSON.stringify(info, null, 2))
  fs.appendFileSync(log, JSON.stringify({ args, branch }) + '\\n')
  console.log(info.url)
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view') {
  let info = { number: 9, url: 'https://github.com/reg/board/pull/9', title: '看板 PR', state: 'OPEN', isDraft: false, statusCheckRollup: [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/reg/board/actions/runs/1' },
  ], mergeable: 'MERGEABLE', baseRefName: 'main' }
  try { info = { ...info, ...JSON.parse(fs.readFileSync(state, 'utf8')) } } catch {}
  fs.appendFileSync(log, JSON.stringify({ args }) + '\\n')
  console.log(JSON.stringify(info))
  process.exit(0)
}
console.error('fake gh: unsupported ' + args.join(' '))
process.exit(1)
`,
  )
  chmodSync(fakeGh, 0o755)
  mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        hostId,
        token,
        idleTimeoutSec: 180,
        resumeOnRestart: 'auto',
        defaultDelegation: 'less',
      },
      null,
      2,
    ),
  )

  const env = {
    ...process.env,
      HOME: path.join(home, 'home'),
      TANDEM_HOME: wsHome,
      TANDEM_ADB_BIN: fakeAdb,
      TANDEM_MOCK_SERIAL: '1',
      ...extraEnv,
      TANDEM_GH_PATH: fakeGh,
      CODEX_HOME: path.join(home, 'home', '.codex'),
      // HOME 被替换成临时目录，Playwright 需要显式指向本机已安装的浏览器缓存。
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache', 'ms-playwright'),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
  // extraEnv 里显式 undefined 表示“删掉这个变量”，用于让调试版默认值生效。
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', '0'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工作站启动超时\n${stdout}\n${stderr}`)), 25_000)
    const check = () => {
      const match = stdout.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`工作站提前退出（${code}）\n${stdout}\n${stderr}`))
    })
  })

  // 调试账号免密登录，并等本机主机上下文登记上线；返回访问本机主机的根地址与账号令牌。
  const debugEnabled = (env.TANDEM_DEBUG_ACCOUNT ?? '') !== '0'
  const session = !debugEnabled
    ? undefined
    : (async () => {
    const port = await ready
    const wsBase = `http://127.0.0.1:${port}`
    const res = await fetch(`${wsBase}/api/debug/auto-login`, { method: 'POST' })
    if (!res.ok) throw new Error(`调试账号登录失败（${res.status}）：${stdout}\n${stderr}`)
    const login = await res.json()
    const record = await waitForValue(async () => {
      const list = await fetch(`${wsBase}/api/workstation/hosts`, {
        headers: { authorization: `Bearer ${login.accessToken}` },
      }).then((r) => r.json())
      return list.find((item) => item.id === hostId && item.online)
    }, 30_000, '本机主机上线')
      return {
        wsBase,
        base: `${wsBase}/h/${hostId}`,
        token: login.accessToken,
        hostId,
        fingerprint: record.fingerprint,
      }
    })()

  return { child, ready, session, logs: () => `${stdout}\n${stderr}`, configDir, wsHome }
}

/** 独立工作站进程：登录门用例只验证客户端流程，不再借 Host 侧本机路由启动。 */
export function startWorkstation({ home }) {
  mkdirSync(home, { recursive: true })
  const env = {
    ...process.env,
    HOME: path.join(home, 'home'),
    TANDEM_HOME: home,
    TANDEM_DEBUG_ACCOUNT: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  const child = spawn(process.execPath, [HOST_ENTRY, '--port', '0', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工作站启动超时\n${stdout}\n${stderr}`)), 25_000)
    const check = () => {
      const match = stdout.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`工作站提前退出（${code}）\n${stdout}\n${stderr}`))
    })
  })
  return { child, ready, logs: () => `${stdout}\n${stderr}` }
}

/** 轮询直到 fn 返回真值；超时给出标签与最后一次结果。 */
export async function waitForValue(fn, timeout, label) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** 把造数用的模型账号写进工作站账号级加密存储（调试账号），并去掉调试用的演示账号。 */
export async function importSeededProfiles(wsHome, profiles) {
  const file = path.join(wsHome, 'accounts.json')
  const accounts = JSON.parse(readFileSync(file, 'utf8'))
  const debug = (accounts.accounts ?? []).find((account) => account.username === 'debug')
  if (!debug) throw new Error('工作站里没有调试账号，无法导入模型账号')
  const { AccountProfileStore } = await import(
    pathToFileURL(path.join(ROOT, 'packages/server/dist/workstation/profiles.js')).href
  )
  const store = new AccountProfileStore(wsHome)
  for (const item of store.list(debug.id)) {
    if (item.kind === 'demo') store.remove(debug.id, item.id)
  }
  store.importStored(debug.id, profiles)
  store.dispose()
}

export function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

export async function api(base, token, pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}

/** 订阅会话并取第一份快照（用于验证首屏下发字节/条数）。 */
export function wsInboxSnapshot(base, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('inbox snapshot timeout'))
    }, 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe_inbox' })))
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.type !== 'inbox_snapshot') return
      clearTimeout(timer)
      ws.close()
      resolve(msg.snapshot)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export function wsSessionSnapshot(base, token, sessionId, tail) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('WS 快照超时'))
    }, 20_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId, ...(tail ? { tail } : {}) }))
    })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.type === 'session_snapshot') {
        clearTimeout(timer)
        ws.close()
        resolve({ msg, bytes: Buffer.byteLength(String(raw)) })
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** 造一份带 M/A/D/U、未跟踪目录、Windows 盘符路径的 git 仓库。 */
export function seedRepo(repo) {
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'reg@example.com')
  git('config', 'user.name', 'reg')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  mkdirSync(path.join(repo, 'docs'), { recursive: true })
  writeFileSync(path.join(repo, 'src/hello.ts'), 'export const hello = 1\n')
  writeFileSync(path.join(repo, 'docs/old.md'), '# old\n')
  writeFileSync(path.join(repo, 'README.md'), '# regrepo\n')
  git('add', '.')
  git('commit', '-qm', 'init')

  writeFileSync(
    path.join(repo, 'src/hello.ts'),
    'export const hello = 2\nexport const world = 3\nexport const longLine = "' + '长'.repeat(120) + '"\n',
  )
  writeFileSync(path.join(repo, 'src/staged.ts'), 'export const staged = true\n')
  git('add', 'src/staged.ts')
  rmSync(path.join(repo, 'docs/old.md'))

  mkdirSync(path.join(repo, 'untracked-dir/nested'), { recursive: true })
  writeFileSync(path.join(repo, 'untracked-dir/one.ts'), 'export const one = 1\n')
  writeFileSync(path.join(repo, 'untracked-dir/nested/two.ts'), 'export const two = 2\n')

  // Windows 盘符路径：前端把 /D:/repo/demo.ts 归一化为 D:/repo/demo.ts，
  // Host 在 Linux 上解析为 <repo>/D:/repo/demo.ts。
  mkdirSync(path.join(repo, 'D:/repo'), { recursive: true })
  writeFileSync(path.join(repo, 'D:/repo/demo.ts'), 'const windows = true\n// windows drive file\n')

  // 有未提交改动的 worktree 目录：删除 409 时应能列出文件名与分支。
  const dirty = path.join(path.dirname(repo), 'tandem', 'dirty-wt')
  mkdirSync(dirty, { recursive: true })
  const gitDirty = (...args) => execFileSync('git', args, { cwd: dirty, stdio: 'pipe' })
  gitDirty('init', '-q')
  gitDirty('config', 'user.email', 'reg@example.com')
  gitDirty('config', 'user.name', 'reg')
  writeFileSync(path.join(dirty, 'dirty.txt'), 'clean\n')
  gitDirty('add', '.')
  gitDirty('commit', '-qm', 'init')
  writeFileSync(path.join(dirty, 'dirty.txt'), 'changed\n')
}

/** 应用预览用例的本地 Vite 页面：真实 React 组件 + 可变内容，供自动刷新/对比断言。 */
export async function seedPreviewApp(root) {
  mkdirSync(path.join(root, 'src'), { recursive: true })
  try {
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  } catch {
    /* 已存在（重复运行）时忽略 */
  }
  const port = await new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const value = probe.address().port
      probe.close(() => resolve(value))
    })
  })
  const requests = []
  const blocked = http.createServer((req, res) => {
    requests.push({ url: req.url, host: req.headers.host })
    res.writeHead(403)
    res.end('blocked')
  })
  // 探测端口刚释放时可能被 blocked 服务复用，导致 Vite 起不来、预览打开 blocked 页面。
  let blockedPort = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => blocked.listen(0, '0.0.0.0', resolve))
    blockedPort = blocked.address().port
    if (blockedPort !== port) break
    await new Promise((resolve) => blocked.close(resolve))
  }
  assert.notEqual(blockedPort, port, 'blocked 测试服务误占 Vite 端口')

  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'preview-reg-app',
        private: true,
        scripts: { dev: `vite --port ${port}` },
        devDependencies: { vite: '^8.0.0' },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    path.join(root, 'index.html'),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>预览回归页</title>
<style>
  html, body { margin: 0; height: 100%; background: #f6f7fb; font-family: system-ui, sans-serif; }
  main { padding: 24px; }
  h1 { margin: 0 0 72px; font-size: 28px; color: #223; }
  #login { position: fixed; left: 32px; top: 140px; width: 220px; height: 64px; border-radius: 12px; border: 1px solid #9aa; background: #fff; font-size: 20px; }
</style></head>
<body><div id="root"></div><script src="/content.js"></script><script type="module" src="/src/App.tsx"></script></body></html>
`,
  )
  writeFileSync(path.join(root, 'content.js'), 'window.__PREVIEW_TEXT__ = "PREVIEW_MARKER";\n')
  writeFileSync(
    path.join(root, 'src/App.tsx'),
    `import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

export function LoginButton({ label }: { label: string }) {
  return (
    <button id="login" aria-label="登录按钮">
      {label}
    </button>
  )
}

export function App() {
  const [text] = useState(() => (window as unknown as { __PREVIEW_TEXT__?: string }).__PREVIEW_TEXT__ ?? 'PREVIEW_MARKER')
  useEffect(() => {
    document.title = \`预览回归页 \${text}\`
  }, [text])
  return (
    <main>
      <h1 id="title">{text}</h1>
      <LoginButton label="登录" />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
`,
  )
  const child = spawn(path.join(ROOT, 'node_modules/.bin/vite'), [
    '--port',
    String(port),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ], {
    cwd: root,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    logs += chunk
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
  })
  const ready = async () => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const status = await new Promise((resolve) => {
        const req = http.get(
          { hostname: '127.0.0.1', port, path: '/', timeout: 500 },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('timeout', () => {
          req.destroy()
          resolve(0)
        })
        req.on('error', () => resolve(0))
      })
      if (status === 200) return
      await sleep(200)
    }
    throw new Error(`Vite 预览页启动超时\n${logs}`)
  }
  await ready()
  return {
    root,
    port,
    blockedPort,
    requests,
    logs: () => logs,
    close: async () => {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000).then(() => child.kill('SIGKILL')),
      ])
      await new Promise((resolve) => blocked.close(resolve))
    },
  }
}

/** 预置一份 Wiki：页面/手写段落/commit 都可控，UI 用例无需真实模型。 */
export function seedWiki(configDir, repo) {
  const hash = createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 16)
  const dir = path.join(configDir, 'wiki', hash)
  mkdirSync(path.join(dir, 'pages'), { recursive: true })
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const pages = [
    {
      id: 'overview',
      title: '项目概览',
      kind: 'overview',
      files: ['README.md'],
      auto: '# regrepo 项目概览\n\nMock 概览：回归仓库。\n\n## 如何运行\n\n`npm run build`\n\n## 目录地图\n\n- `src/`\n- `docs/`',
    },
    {
      id: 'm-src',
      title: 'src',
      kind: 'module',
      module: 'src',
      files: ['src/hello.ts'],
      auto: '# src\n\nMock 职责：示例源码。\n\n## 关键文件\n\n- `src/hello.ts`\n\n## 常见改动入口\n\n修改 `src/hello.ts`。',
    },
    {
      id: 'glossary',
      title: '术语表',
      kind: 'glossary',
      files: ['README.md'],
      auto: '# 术语表\n\n- regrepo：回归仓库。',
    },
  ]
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        version: 1,
        project: path.resolve(repo),
        name: 'repo',
        createdAt: Date.now() - 4 * 86_400_000,
        updatedAt: Date.now() - 3 * 86_400_000,
        commit,
        model: 'mock-1',
        pages: pages.map((page) => ({
          id: page.id,
          title: page.title,
          kind: page.kind,
          ...(page.module ? { module: page.module } : {}),
          files: page.files,
          commit,
          updatedAt: Date.now() - 3 * 86_400_000,
          chars: page.auto.length,
        })),
      },
      null,
      2,
    ),
  )
  for (const page of pages) {
    writeFileSync(
      path.join(dir, 'pages', `${page.id}.md`),
      [
        '<!-- tandem-wiki:auto:start -->',
        page.auto,
        '<!-- tandem-wiki:auto:end -->',
        '',
        '<!-- tandem-wiki:manual:start -->',
        page.id === 'm-src' ? '手写：保留这条说明。' : '',
        '<!-- tandem-wiki:manual:end -->',
        '',
      ].join('\n'),
    )
  }
}

export function seedData({ configDir, repo, hostId, mockPort, previewCwd, today, day }) {
  const baseUrl = `http://127.0.0.1:${mockPort}/v1`
  const profiles = [
    {
      id: 'p-main',
      name: '主力账号',
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'reg-key-main',
      models: ['mock-1', 'mock-2'],
      defaultModel: 'mock-1',
      createdAt: Date.now() - 10_000,
      groups: [
        {
          id: 'g1',
          name: '生产',
          // 反馈1323#02：旧数据里同一分组有两个 Key，界面只显示第一个可用的，保存不删其余。
          keys: [
            { id: 'k-g1-a', label: '主', apiKey: 'reg-key-g1' },
            { id: 'k-g1-b', label: '备', apiKey: 'reg-key-g1-backup' },
          ],
          models: ['mock-1', 'mock-2'],
          defaultModel: 'mock-1',
        },
        {
          id: 'g2',
          name: '备用',
          apiKey: 'reg-key-g2',
          models: ['o3', 'o4-mini'],
          defaultModel: 'o3',
        },
      ],
    },
    {
      id: 'p-custom',
      name: '自建端点',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4321/v1',
      apiKey: 'reg-key-custom',
      models: ['custom-1'],
      defaultModel: 'custom-1',
      createdAt: Date.now() - 20_000,
    },
    {
      // 反馈2121#01：Anthropic 协议 + adaptive 型号，档位按官方 effort 表而不是旧 token 预算。
      id: 'p-claude',
      name: 'Claude 账号',
      kind: 'anthropic',
      baseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'reg-key-claude',
      models: ['claude-sonnet-5-5', 'claude-sonnet-4-5'],
      defaultModel: 'claude-sonnet-5-5',
      createdAt: Date.now() - 25_000,
    },
    {
      id: 'p-quota',
      name: '限流账号',
      kind: 'openai-compatible',
      baseUrl,
      models: ['quota-model'],
      defaultModel: 'quota-model',
      createdAt: Date.now() - 30_000,
      groups: [
        {
          id: 'g-quota-main',
          name: '主分组',
          keys: [{ id: 'k-quota-main', label: '主', apiKey: 'reg-key-quota-main' }],
          models: ['quota-model'],
          defaultModel: 'quota-model',
          fallbackGroupIds: ['g-quota-backup'],
        },
        {
          id: 'g-quota-backup',
          name: '备用分组',
          keys: [{ id: 'k-quota-backup', label: '备', apiKey: 'reg-key-quota-backup' }],
          models: ['quota-backup-model'],
          defaultModel: 'quota-backup-model',
        },
      ],
    },
    {
      // 反馈0220#02：没有备用分组，验证「继续使用当前分组」与「关闭交接」。
      id: 'p-quota2',
      name: '额度继续账号',
      kind: 'openai-compatible',
      baseUrl,
      models: ['quota-continue-model', 'quota-off-model'],
      defaultModel: 'quota-continue-model',
      createdAt: Date.now() - 31_000,
      groups: [
        {
          id: 'g-continue',
          name: '继续分组',
          keys: [{ id: 'k-continue', label: '主', apiKey: 'reg-key-continue' }],
          models: ['quota-continue-model'],
          defaultModel: 'quota-continue-model',
        },
        {
          id: 'g-off',
          name: '关闭交接分组',
          keys: [{ id: 'k-off', label: '主', apiKey: 'reg-key-off' }],
          models: ['quota-off-model'],
          defaultModel: 'quota-off-model',
        },
      ],
    },
    {
      id: 'p-route',
      name: '自动路由账号',
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'reg-key-route',
      models: ['route-mini', 'route-mid', 'route-power', 'route-kimi'],
      defaultModel: 'route-mini',
      price: {
        'route-mini': { input: 0.1, output: 0.2 },
        'route-mid': { input: 1, output: 2 },
        'route-kimi': { input: 4, output: 12 },
        'route-power': { input: 10, output: 20 },
      },
      createdAt: Date.now() - 28_000,
    },
    {
      // 反馈10#04：多代/别名/日期快照混在一起的模型列表。
      id: 'p-versioned',
      name: '多代模型账号',
      kind: 'openai-compatible',
      baseUrl: baseUrl.replace(/\/v1$/, '/versioned/v1'),
      apiKey: 'reg-key-versioned',
      models: ['claude-sonnet-4-5'],
      defaultModel: 'claude-sonnet-4-5',
      groups: [
        {
          id: 'g-versioned',
          name: 'aws',
          kind: 'openai-compatible',
          apiKey: 'sk-reg-abcdefghij',
          models: ['claude-sonnet-4-5'],
          defaultModel: 'claude-sonnet-4-5',
        },
      ],
      createdAt: Date.now() - 30_000,
    },
    {
      // 菜单反馈 #17：一个分组塞满模型，验证列表滚动、底部操作固定可见。
      id: 'p-many',
      name: '多模型账号',
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'reg-key-many',
      models: [
        ...Array.from({ length: 20 }, (_, i) => `many-${String(i).padStart(2, '0')}`),
        'many-extra-long-model-name-0123456789',
      ],
      defaultModel: 'many-00',
      groups: [
        {
          id: 'g-many',
          name: '大分组',
          apiKey: 'reg-key-many-g',
          models: [
            ...Array.from({ length: 20 }, (_, i) => `many-${String(i).padStart(2, '0')}`),
            'many-extra-long-model-name-0123456789',
          ],
          defaultModel: 'many-00',
        },
      ],
      createdAt: Date.now() - 29_000,
    },
  ]

  const common = {
    cwd: repo,
    profileId: 'p-main',
    groupId: 'g1',
    model: 'mock-1',
    permissionMode: 'default',
    delegation: 'less',
    todos: [],
    allowedTools: [],
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.12 },
    env: { repoRoot: repo, repoName: path.basename(repo), branch: 'main' },
    depth: 0,
  }
  const createdAt = Date.now() - 3_600_000
  const message = (id, role, text, extra = {}) => ({
    id,
    role,
    content: [{ type: 'text', text }],
    createdAt: createdAt + Number(id.replace(/\D/g, '') || 0) * 1000,
    ...extra,
  })

  const longMessages = []
  for (let n = 1; n <= 40; n++) {
    longMessages.push(message(`u${n}`, 'user', `第 ${n} 轮：检查文件`))
    longMessages.push(
      message(`a${n}`, 'assistant', `第 ${n} 轮的结果：一切正常。`, {
        model: 'mock-1',
        usage: { inputTokens: 100 + n, outputTokens: 20 + n, costUsd: 0.001 * n },
        durationMs: 12_300,
        ttftMs: 800,
      }),
    )
  }

  // 分页回归：320 轮 / 640 条消息，首屏应只下发最近 200 条。
  const hugeMessages = []
  for (let n = 1; n <= 320; n++) {
    hugeMessages.push(message(`hu${n}`, 'user', `大会话第 ${n} 轮：检查分页加载`))
    hugeMessages.push(
      message(`ha${n}`, 'assistant', `第 ${n} 轮结果：分页正常。`, { model: 'mock-1' }),
    )
  }

  const linksMessages = [
    message('l1', 'user', '帮我看这两个文件'),
    message(
      'l2',
      'assistant',
      'Windows 盘符链接：[D 盘文件](/D:/repo/demo.ts:2)\n\n行内路径：`D:\\repo\\demo.ts`\n\n相对路径：`src/hello.ts`',
      { model: 'mock-1' },
    ),
  ]

  // 反馈0220#04：纯文本里「长得像文件」的不再成为链接；行内代码只有文件确实存在才是链接。
  const linkRuleMessages = [
    message('lk1', 'user', '看看这些引用'),
    message(
      'lk2',
      'assistant',
      [
        '纯文本不是链接：menu.cpp、.cpp、.cppm、unique_ptr、buffer_type.c。',
        '',
        '存在：`src/hello.ts`、`D:\\repo\\demo.ts`；不存在：`missing-demo.cpp`、`there/is/no/file.ts`。',
        '',
        '显式链接：[D 盘文件](/D:/repo/demo.ts:2)',
      ].join('\n'),
      { model: 'mock-1' },
    ),
  ]

  // 宽内容回归（#7-02）：长表格 + 长代码行。
  const wideCode = `const LONG_LINE = "${'x'.repeat(260)}"`
  const wideCell = `这是一段足够长的说明-${'wide-token-'.repeat(4)}`
  const wideToken = 'X'.repeat(90)
  const wideMarkdown = [
    '宽内容回归：',
    '',
    '| 模块 | 说明 | 负责人 | 状态 | 备注 | 路径 | 数量 | 更新时间 | 关联 | 操作 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Array.from(
      { length: 10 },
      (_, i) =>
        `| module-${i} | ${wideCell} | 张三 | 进行中 | ${wideToken}-${i} | ${wideToken}/src/features/module-${i}/index.ts | ${i * 17} | 2026-11-09 | 关联-${wideToken} | 查看 |`,
    ),
    '',
    '```ts',
    wideCode,
    '```',
  ].join('\n')
  const wideMessages = [
    message('w1', 'user', '看看这张宽表格和长代码行'),
    message('w2', 'assistant', wideMarkdown, { model: 'mock-1' }),
  ]

  // 反馈16：照着真实会话（截图 10）还原的夹具——多个 PowerShell/bash 代码块、
  // 带行内代码的表格、长段落、工具调用、多轮；旧版宽内容改造把块推到正文列之外，
  // 在消息列里看起来是空白块 / 表格缺列。
  const richCode = (text) => `\`\`\`powershell\n${text}\n\`\`\``
  const richMessages = [
    message('r16u1', 'user', '帮我在我的windows上安装一下sdk环境'),
    message('r16a1', 'assistant', '我首先检查手机端的构建脚本和 Android 配置，再看看本机已安装的 SDK、Java 等依赖，确认生成 APK 还缺哪些东西。', {
      model: 'mock-1',
      usage: { inputTokens: 16_100, outputTokens: 69, costUsd: 0.01 },
      createdAt: createdAt + 600_000,
      durationMs: 15_300,
      content: [
        { type: 'text', text: '我首先检查手机端的构建脚本和 Android 配置，再看看本机已安装的 SDK、Java 等依赖，确认生成 APK 还缺哪些东西。' },
        { type: 'tool_use', id: 'tu-r16-1', name: 'Bash', input: { command: 'cd', description: '运行 cd' } },
      ],
    }),
    {
      id: 'r16r1',
      role: 'user',
      createdAt: createdAt + 601_000,
      content: [{ type: 'tool_result', toolUseId: 'tu-r16-1', content: '/home/user/project' }],
    },
    message(
      'r16a2',
      'assistant',
      [
        '检查过了，目前打包脚本找不到 JDK 21 和 Android SDK。我实际运行了该命令调用的脚本，环境检查报错：',
        '',
        '```text',
        '缺少打包环境：',
        '- JDK 21（设置 JAVA_HOME，或安装 Temurin 21 / Android Studio 自带 JBR）',
        '- Android SDK（设置 ANDROID_HOME 或 sdk.dir）',
        '```',
        '',
        '你的 `Node.js` 是 24.0.2，满足项目要求。Java、SDK 的环境变量都没有设置，默认安装目录中也未找到它们；如果装在自定义目录，需要配置路径。',
        '',
        '需要准备这些：',
        '',
        '| 本项目的版本 / 用途 |',
        '| --- |',
        '| 21，编译 Android 代码 |',
        '| Android 16 / API 36，项目明确制定 compileSdkVersion = 36 |',
        '| 建议安装 35.0.0，供项目使用的 Android Gradle Plugin 8.13 使用 |',
        '| 包含 adb，方便连接手机安装、调试 |',
        '| 建议安装最新版，方便管理 SDK 和接受许可 |',
        '',
        'Windows 上最简单的方式是安装 Android Studio，再通过它的 SDK Manager 安装组件：',
        '',
        '1. 安装并启动 Android Studio，完成首次 SDK 安装向导。',
        '2. 打开 More Actions → SDK Manager。',
        '3. 在 SDK Platforms 勾选 Android 16 / API 36。',
        '',
        'Android Studio 自带 Java 运行环境，脚本会搜索默认路径 C:\\Program Files\\Android\\Android Studio\\jbr；确认其版本为 21，或者单独安装 Temurin JDK 21，SDK 默认路径是：',
        '',
        '```text',
        'C:\\Users\\<用户名>\\AppData\\Local\\Android\\Sdk',
        '```',
        '',
        '安装好后，在 PowerShell 中进入实际项目根目录运行：',
        '',
        richCode('npm ci --include=dev\nnpm run build\nnpx cap sync android\ncd packages/mobile/android\n.\\gradlew.bat assembleDebug'),
        '',
        '构建成功后会自动生成 `dist-apk\\tandem-debug.apk`，并自动复制到你的下载文件夹。',
      ].join('\n'),
      { model: 'mock-1', usage: { inputTokens: 15_100, outputTokens: 312, costUsd: 0.02 }, createdAt: createdAt + 602_000, durationMs: 41_100 },
    ),
    message('r16u2', 'user', 'android studio是否太大一个了，有没有更干净，更新的方式', {
      createdAt: createdAt + 700_000,
    }),
    message(
      'r16a3',
      'assistant',
      [
        '是的，只为了生成 APK，没必要装整个 Android Studio，更精简的方案是：JDK 21 + Google 官方 Android SDK 命令行工具，直接用项目自带的 Gradle 构建。',
        '',
        '推荐这样配置：',
        '',
        '| 组件 | 安装方式 |',
        '| --- | --- |',
        '| JDK 21 | 通过 Windows 的 `winget` 安装 |',
        '| Platform-Tools（adb） | 从 Google 官网下载独立压缩包 |',
        '| Command-line Tools | 用 `sdkmanager` 安装 |',
        '',
        '安装 JDK 后重新打开 PowerShell，确认 `JAVA_HOME` 指向 JDK 安装目录，再执行：',
        '',
        richCode(`$env:JAVA_HOME = "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.8.9-hotspot"\n$env:ANDROID_HOME = "C:\\Android\\Sdk"\n& "$env:ANDROID_HOME\\${'cmdline-tools\\latest\\bin\\sdkmanager.bat'}" --licenses\n& "$env:ANDROID_HOME\\${'cmdline-tools\\latest\\bin\\sdkmanager.bat'}" "platform-tools" "platforms;android-36" "build-tools;35.0.0"`),
        '',
        '最后回到项目运行：',
        '',
        '```bash\nnpm ci --include=dev\nnpm run build\nnpm run apk -w @tandem/mobile\n```',
      ].join('\n'),
      { model: 'mock-1', usage: { inputTokens: 19_400, outputTokens: 1_040, costUsd: 0.03 }, createdAt: createdAt + 800_000, durationMs: 43_500 },
    ),
    // 时间格式：两天前的一条（`MM-DD HH:mm`）与一条十年前的（带年份）。
    // 各自单起一轮，保证它们仍是本轮最后一条回复、保留下方时间行（反馈0220#05）。
    message('r16u3', 'user', '两天前那条呢', { createdAt: createdAt - 2 * 86_400_000 - 1000 }),
    message('r16a4', 'assistant', '两天前的回复：分页正常。', {
      model: 'mock-1',
      createdAt: createdAt - 2 * 86_400_000,
      content: [{ type: 'text', text: '两天前的回复：分页正常。' }, { type: 'tool_use', id: 'tu-r16-old', name: 'Read', input: { file_path: 'README.md' } }],
    }),
    {
      id: 'r16rold',
      role: 'user',
      createdAt: createdAt - 2 * 86_400_000 + 1000,
      content: [{ type: 'tool_result', toolUseId: 'tu-r16-old', content: '# demo' }],
    },
    message('r16u4', 'user', '去年的呢', { createdAt: createdAt - 400 * 86_400_000 - 1000 }),
    message('r16a5', 'assistant', '去年的回复：归档。', { model: 'mock-1', createdAt: createdAt - 400 * 86_400_000 }),
  ]

  const mk = (id, title, messages, extra = {}) => ({
    ...common,
    id,
    title,
    messages,
    createdAt,
    updatedAt: Date.now() - (id === 'long' ? 1000 : 2000),
    ...extra,
  })

  const sessions = [
    mk('long', '回归长会话', longMessages),
    // 侧栏「固定项目 / 最近项目」分组：第二个项目用于验证固定后跨组移动。
    mk('otherproj', '另一个项目会话', [
      message('op1', 'user', '看看另一个项目'),
      message('op2', 'assistant', '另一个项目正常。', { model: 'mock-1' }),
    ], {
      cwd: previewCwd,
      env: { repoRoot: previewCwd, repoName: 'second-project', branch: 'main' },
      updatedAt: Date.now() - 1450,
    }),
    mk('turns4', '四轮工具会话', [
      message('t41', 'user', '第一轮：检查目录'),
      {
        id: 't42',
        role: 'assistant',
        createdAt,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我先读 README。' },
          { type: 'tool_use', id: 'tu-turns4', name: 'Read', input: { file_path: 'README.md' } },
        ],
        durationMs: 12_300,
        ttftMs: 800,
      },
      {
        id: 't43',
        role: 'user',
        createdAt: createdAt + 3000,
        content: [{ type: 'tool_result', toolUseId: 'tu-turns4', content: '# regrepo' }],
        toolDurationMs: 40_000,
      },
      message('t44', 'user', '第二轮：继续'),
      message('t45', 'assistant', '第二轮完成。', { model: 'mock-1' }),
      message('t46', 'user', '第三轮：再确认'),
      message('t47', 'assistant', '第三轮完成。', { model: 'mock-1' }),
      message('t48', 'user', '第四轮：收尾'),
      message('t49', 'assistant', '收尾完成。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 950 }),
    mk('priced', '参考价会话', [
      message('pr1', 'user', '看看这个模型的价格'),
      message('pr2', 'assistant', '按参考价估算。', { model: 'o3' }),
    ], { groupId: 'g2', model: 'o3', updatedAt: Date.now() - 980 }),
    // 反馈2121#01：adaptive 型号的思考强度档位（无 token 预算标签）。
    mk('claude-effort', 'Claude 思考强度会话', [
      message('ce1', 'user', '这道题先想一想'),
      message('ce2', 'assistant', '好的。', { model: 'claude-sonnet-5-5' }),
    ], { profileId: 'p-claude', groupId: undefined, model: 'claude-sonnet-5-5', effort: 'max', updatedAt: Date.now() - 985 }),
    // 1M 上下文：Sonnet 4.5 只有 200K，模型菜单不应出现上下文开关。
    mk('claude-45', 'Claude 4.5 会话', [
      message('c451', 'user', '看看这个文件'),
      message('c452', 'assistant', '好的。', { model: 'claude-sonnet-4-5' }),
    ], { profileId: 'p-claude', groupId: undefined, model: 'claude-sonnet-4-5', updatedAt: Date.now() - 990 }),
    // 升级前落库的上下文快照：分母停在 200K、没有 longContext，原生 1M 型号打开时应实时按 1M 显示。
    mk('claude-legacy', 'Claude 旧快照会话', [
      message('clg1', 'user', '继续上次的活'),
      message('clg2', 'assistant', '好的。', { model: 'claude-sonnet-5-5' }),
    ], {
      profileId: 'p-claude',
      groupId: undefined,
      model: 'claude-sonnet-5-5',
      context: {
        model: 'claude-sonnet-5-5',
        contextWindow: 200_000,
        usedTokens: 61_000,
        parts: [
          { kind: 'system', tokens: 10_000 },
          { kind: 'tools', tokens: 6_000 },
          { kind: 'messages', tokens: 45_000 },
          { kind: 'free', tokens: 139_000 },
        ],
        updatedAt: Date.now() - 3_600_000,
      },
      updatedAt: Date.now() - 995,
    }),
    // 反馈1601#03：输入 6 tok、按参考价折算后不足 $0.0001，不能显示成 $0.0000。
    mk('tinycost', '小额花费会话', [
      message('tc1', 'user', '这条输入的金额不要显示成 0', {
        usage: { inputTokens: 6, outputTokens: 0, costUsd: 0.00003 },
      }),
      message('tc2', 'assistant', '已记录。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 1565 }),
    mk('huge', '超大会话 · 320 轮', hugeMessages, { updatedAt: Date.now() - 900 }),
    mk('links', '文件链接会话', linksMessages, { updatedAt: Date.now() - 1500 }),
    mk('links2', '文件识别规则会话', linkRuleMessages, { updatedAt: Date.now() - 1501 }),
    mk('wide', '宽内容会话', wideMessages, { updatedAt: Date.now() - 1520 }),
    mk('codeblock', '代码块与表格会话', richMessages, { updatedAt: Date.now() - 1530 }),
    // 反馈0220#05：一轮内三段 assistant 回复（中间穿插工具调用），只有最后一段保留操作行。
    mk('trail', '一轮多段回复会话', [
      message('tr1', 'user', '请分三段回答'),
      {
        id: 'tr2',
        role: 'assistant',
        createdAt: createdAt + 2000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '第一段：先看目录结构。' },
          { type: 'tool_use', id: 'tu-trail-1', name: 'Read', input: { file_path: 'src/hello.ts' } },
        ],
        usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.001 },
      },
      {
        id: 'tr3',
        role: 'user',
        createdAt: createdAt + 3000,
        content: [{ type: 'tool_result', toolUseId: 'tu-trail-1', content: 'export const hello = 1' }],
      },
      {
        id: 'tr4',
        role: 'assistant',
        createdAt: createdAt + 4000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '第二段：再确认构建脚本。' },
          { type: 'tool_use', id: 'tu-trail-2', name: 'Read', input: { file_path: 'README.md' } },
        ],
        usage: { inputTokens: 130, outputTokens: 24, costUsd: 0.0012 },
      },
      {
        id: 'tr5',
        role: 'user',
        createdAt: createdAt + 5000,
        content: [{ type: 'tool_result', toolUseId: 'tu-trail-2', content: '# regrepo' }],
      },
      message('tr6', 'assistant', '第三段：全部完成。', {
        model: 'mock-1',
        usage: { inputTokens: 140, outputTokens: 30, costUsd: 0.0015 },
      }),
    ], { updatedAt: Date.now() - 1532 }),
    mk('slow2', '排队消息会话', [
      message('sq1', 'user', '先看看项目'),
      message('sq2', 'assistant', '项目看起来正常。', { model: 'mock-1' }),
    ], { permissionMode: 'bypassPermissions', updatedAt: Date.now() - 1536 }),
    mk('scroll', '流式跟随会话', Array.from({ length: 8 }, (_, i) => [
      message(`sc${i}u`, 'user', `第 ${i + 1} 个问题：请逐段介绍一下项目的结构与约定。`),
      message(
        `sc${i}a`,
        'assistant',
        Array.from({ length: 6 }, (_, j) => `第 ${i + 1} 节第 ${j + 1} 段：较长的说明文字，用来撑高对话区，便于观察滚动位置。`).join('\n\n'),
        { model: 'mock-1' },
      ),
    ]).flat(), { permissionMode: 'bypassPermissions', updatedAt: Date.now() - 1534 }),
    mk('slow', '慢速运行会话', [
      message('slow1', 'user', '先看看项目'),
      message('slow2', 'assistant', '项目看起来正常。', { model: 'mock-1' }),
    ], { permissionMode: 'bypassPermissions', updatedAt: Date.now() - 1535 }),
    // 配额交接：主分组第一次请求成功后下一次 429，备用分组接住。
    mk('quota', '配额交接会话', [
      message('q1', 'user', '第一轮：介绍一下项目'),
      message('q2', 'assistant', '配额主分组回复：第一轮完成。', {
        model: 'quota-model',
        usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.001 },
      }),
    ], {
      profileId: 'p-quota',
      groupId: 'g-quota-main',
      model: 'quota-model',
      updatedAt: Date.now() - 1550,
    }),
    // 反馈0220#02：没有备用分组时继续使用当前分组 / 关闭交接。
    mk('quota-continue', '额度继续会话', [
      message('qc1', 'user', '第一轮：介绍一下项目'),
      message('qc2', 'assistant', '额度主分组回复：第一轮完成。', {
        model: 'quota-continue-model',
        usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.001 },
      }),
    ], {
      profileId: 'p-quota2',
      groupId: 'g-continue',
      model: 'quota-continue-model',
      permissionMode: 'bypassPermissions',
      updatedAt: Date.now() - 1552,
    }),
    mk('quota-off', '关闭交接会话', [
      message('qo1', 'user', '第一轮：介绍一下项目'),
      message('qo2', 'assistant', '额度主分组回复：第一轮完成。', {
        model: 'quota-off-model',
        usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.001 },
      }),
    ], {
      profileId: 'p-quota2',
      groupId: 'g-off',
      model: 'quota-off-model',
      permissionMode: 'bypassPermissions',
      updatedAt: Date.now() - 1553,
    }),
    mk('nockpt', '无检查点会话', [
      message('n1', 'user', '先看看目录'),
      message('n2', 'assistant', '目录结构如下。', { model: 'mock-1' }),
      message('n3', 'user', '再列一下文件'),
    ]),
    // 菜单反馈 #17：模型很多的账号/分组。
    mk('many', '多模型分组会话', [
      message('ma1', 'user', '帮我选一个模型'),
      message('ma2', 'assistant', '已就绪。', { model: 'many-00' }),
    ], {
      profileId: 'p-many',
      groupId: 'g-many',
      model: 'many-00',
      updatedAt: Date.now() - 1560,
    }),
    // 状态筛选用：专用未读会话（其他用例不打开它，避免提前清除未读）
    mk('unreadonly', '未读筛选专用会话', [
      message('uo1', 'user', '这个会话只用于未读筛选。'),
      message('uo2', 'assistant', '完成后保持未读。', { model: 'mock-1' }),
    ], { unread: true, updatedAt: Date.now() - 1700 }),
    // 未读持久化专用：打开一次后重新加载，未读点不能再出现（反馈2156#02）。
    mk('unreadopen', '未读持久化会话', [
      message('up1', 'user', '打开我以后未读应该被记住清除。'),
      message('up2', 'assistant', '这轮结果已经完成。', { model: 'mock-1' }),
    ], { unread: true, updatedAt: Date.now() - 1710 }),
    // 全文搜索：中文短语只出现在 s2，用于断言命中片段与跳转定位
    mk('search', '全文检索会话', [
      message('s1', 'user', '帮我确认离线索引是否覆盖中文词句。'),
      message('s2', 'assistant', 'Elasticsearch 索引已重建，中文短语检索正常。', {
        model: 'mock-1',
      }),
      message('s3', 'user', '再看一下工具命令。'),
      message('s4', 'assistant', '执行 npm run build 并检查 src/hello.ts。', {
        model: 'mock-1',
      }),
    ], { updatedAt: Date.now() - 1800 }),
    mk('retry', '网络重试会话', [
      message('r1', 'user', '继续'),
      message('r2', 'assistant', '网络不好，稍后重试。'),
    ], {
      retryInfo: { attempt: 2, nextAt: Date.now() + 60_000, lastError: 'ECONNREFUSED' },
      updatedAt: Date.now() - 500,
    }),
    mk(
      'wt',
      '重构 worktree 缓存',
      [message('w1', 'user', '改缓存层'), message('w2', 'assistant', '好的。')],
      {
        cwd: path.join(configDir, '..', 'cache-worktree'),
        worktreeRepoRoot: repo,
        worktree: {
          path: path.join(configDir, '..', 'cache-worktree'),
          branch: 'tandem/cache',
          baseBranch: 'main',
        },
        updatedAt: Date.now() - 2500,
      },
    ),
    mk('secrets', 'Secrets 打码会话', [
      message('s1', 'user', '读一下数据库密码'),
      {
        id: 's2',
        role: 'assistant',
        createdAt,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我运行命令看看。' },
          {
            type: 'tool_use',
            id: 'tu-secret',
            name: 'Bash',
            input: { command: 'echo $DB_PASSWORD; env | grep DB_; printf %s "$DB_PASSWORD" | base64' },
          },
        ],
      },
      {
        id: 's3',
        role: 'user',
        createdAt: createdAt + 2000,
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-secret',
            content:
              'DB_PASSWORD=[secret:DB_PASSWORD]\n[secret:DB_PASSWORD]\n[secret:DB_PASSWORD]',
          },
        ],
      },
    ], { updatedAt: Date.now() - 1700 }),
    // 分屏：两个独立会话，待办用于验证右栏跟随聚焦窗格。
    mk('split-a', '分屏会话 A', [
      message('spa1', 'user', '分屏 A 的第一条消息'),
      message('spa2', 'assistant', '分屏 A 已有回复。', { model: 'mock-1' }),
    ], {
      todos: [{ content: '分屏 A 的待办', status: 'pending' }],
      updatedAt: Date.now() - 1600,
    }),
    mk('inboxmulti', '收件箱聚合用例', [
      message('im1', 'user', '跑两条命令看看。'),
      message('im2', 'assistant', '收到。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 100 }),
    mk('split-b', '分屏会话 B', [
      message('spb1', 'user', '分屏 B 的第一条消息'),
      message('spb2', 'assistant', '分屏 B 已有回复。', { model: 'mock-1' }),
    ], {
      todos: [{ content: '分屏 B 的待办', status: 'pending' }],
      updatedAt: Date.now() - 1650,
    }),
    // 反馈1603#01：超过 7 天的会话默认收起；项目固定 / 未读的始终显示（运行态由单测覆盖）。
    mk('oldidle1', '旧会话 · 空闲一', [
      message('oi1', 'user', '很久以前的会话一'),
      message('oi2', 'assistant', '早就结束了。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 9 * 86_400_000 }),
    mk('oldidle2', '旧会话 · 空闲二', [
      message('oi3', 'user', '很久以前的会话二'),
      message('oi4', 'assistant', '早就结束了。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 12 * 86_400_000 }),
    mk('oldpinned', '旧会话 · 项目固定', [
      message('op3', 'user', '很久以前但固定了'),
      message('op4', 'assistant', '仍然要看见。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 10 * 86_400_000, pinnedInProject: true }),
    mk('oldunread', '旧会话 · 未读', [
      message('ou3', 'user', '很久以前但没看过'),
      message('ou4', 'assistant', '仍然要看见。', { model: 'mock-1' }),
    ], { updatedAt: Date.now() - 11 * 86_400_000, unread: true }),
  ]
  // 待审批会话：Host 启动时按 resumeState 恢复并重新广播权限请求，供手机审批卡走查。
  const approveAt = Date.now() - 1200
  sessions.push({
    ...common,
    id: 'approve',
    title: '等待审批：在 taskcli 项目里运行 npm test 并一句话汇报结果，不要改代码。请先阅读任务说明，然后运行测试，最后把输出贴到回复里。',
    messages: [
      {
        id: 'ap1',
        role: 'user',
        content: [{ type: 'text', text: '跑一下测试，然后再提交。' }],
        createdAt: approveAt - 5000,
      },
      {
        id: 'ap2',
        role: 'assistant',
        content: [
          { type: 'text', text: '我先运行测试。' },
          { type: 'tool_use', id: 'tu-ap', name: 'Bash', input: { command: 'npm test' } },
        ],
        createdAt: approveAt - 4000,
        model: 'mock-1',
      },
    ],
    createdAt: approveAt - 10_000,
    updatedAt: approveAt - 1000,
    runState: {
      version: 1,
      startedAt: approveAt - 5000,
      updatedAt: approveAt - 1000,
      completedMessages: ['ap1', 'ap2'],
      queue: [],
      inFlightTools: [{ id: 'tu-ap', name: 'Bash', startedAt: approveAt - 1000 }],
      pendingPermissions: [
        {
          id: 'perm-ap',
          sessionId: 'approve',
          toolUseId: 'tu-ap',
          toolName: 'Bash',
          input: { command: 'npm test' },
          description: '运行命令: npm test',
        },
      ],
      phase: 'tools',
      permissionMode: 'default',
      assistantMessageId: 'ap2',
    },
  })
  // 审批策略学习：同类请求已批准多次的会话（快捷选项）与危险命令会话（不应出现快捷选项）。
  const pendingSession = (id, title, command, toolUseId) => ({
    ...common,
    id,
    title,
    messages: [
      message(`${id}1`, 'user', '继续'),
      {
        id: `${id}2`,
        role: 'assistant',
        createdAt: approveAt - 4000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我先跑一下。' },
          { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } },
        ],
      },
    ],
    createdAt: approveAt - 10_000,
    updatedAt: approveAt - 1000,
    runState: {
      version: 1,
      startedAt: approveAt - 5000,
      updatedAt: approveAt - 1000,
      completedMessages: [`${id}1`, `${id}2`],
      queue: [],
      inFlightTools: [{ id: toolUseId, name: 'Bash', startedAt: approveAt - 1000 }],
      pendingPermissions: [
        {
          id: `perm-${id}`,
          sessionId: id,
          toolUseId,
          toolName: 'Bash',
          input: { command },
          description: `运行命令: ${command}`,
        },
      ],
      phase: 'tools',
      permissionMode: 'default',
      assistantMessageId: `${id}2`,
    },
  })
  sessions.push(pendingSession('learn', '学习审批的会话', 'vitest run', 'tu-learn'))
  sessions.push(pendingSession('danger', '危险命令审批会话', 'rm -rf build', 'tu-danger'))

  // 命令沙箱：acceptEdits 下写工作目录之外仍必须出现审批卡（沙箱说明由 Host 恢复时重算）。
  const outsideWrite = path.join(os.homedir(), 'tandem-reg-outside.txt')
  sessions.push({
    ...common,
    id: 'outside',
    title: '越界写入审批会话',
    permissionMode: 'acceptEdits',
    messages: [
      message('o1', 'user', '把结果写到工作目录外。'),
      {
        id: 'o2',
        role: 'assistant',
        createdAt: approveAt - 4000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我写一个文件。' },
          { type: 'tool_use', id: 'tu-outside', name: 'Write', input: { file_path: outsideWrite, content: 'x' } },
        ],
      },
    ],
    createdAt: approveAt - 10_000,
    updatedAt: approveAt - 1000,
    runState: {
      version: 1,
      startedAt: approveAt - 5000,
      updatedAt: approveAt - 1000,
      completedMessages: ['o1', 'o2'],
      queue: [],
      inFlightTools: [{ id: 'tu-outside', name: 'Write', startedAt: approveAt - 1000 }],
      pendingPermissions: [
        {
          id: 'perm-outside',
          sessionId: 'outside',
          toolUseId: 'tu-outside',
          toolName: 'Write',
          input: { file_path: outsideWrite, content: 'x' },
          description: `写入文件: ${outsideWrite}`,
        },
      ],
      phase: 'tools',
      permissionMode: 'acceptEdits',
      assistantMessageId: 'o2',
    },
  })

  // 审批历史：vitest run 批准 4 次；rm -rf 也批准过 4 次（危险命令只能建议「询问」）。
  const approvalAt = Date.now()
  const approvalRows = []
  for (let i = 0; i < 4; i++) {
    approvalRows.push({
      at: approvalAt - (10 + i) * 60_000,
      project: repo,
      tool: 'Bash',
      key: 'vitest run',
      decision: 'allow',
    })
  }
  for (let i = 0; i < 4; i++) {
    approvalRows.push({
      at: approvalAt - (20 + i) * 60_000,
      project: repo,
      tool: 'Bash',
      key: 'rm',
      decision: 'allow',
      danger: '删除命令 rm',
    })
  }
  approvalRows.push({
    at: approvalAt - 30 * 60_000,
    project: repo,
    tool: 'Bash',
    key: 'git push',
    decision: 'deny',
    danger: 'git push',
  })
  writeFileSync(
    path.join(configDir, 'approvals.jsonl'),
    approvalRows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
  writeFileSync(
    path.join(configDir, 'approval-stats.jsonl'),
    [
      { at: approvalAt - 40 * 60_000, project: repo, tool: 'Read', action: 'allow' },
      { at: approvalAt - 35 * 60_000, project: repo, tool: 'Bash', action: 'allow' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )

  mkdirSync(path.join(configDir, '..', 'cache-worktree'), { recursive: true })
  const wtSession = sessions.find((s) => s.id === 'wt')
  if (wtSession) wtSession.cwd = path.join(configDir, '..', 'cache-worktree')
  const dirtyWt = path.join(configDir, '..', 'dirty-wt')
  sessions.push(
    mk(
      'wtdirty',
      '未提交改动的 worktree',
      [message('d1', 'user', '改一下文件'), message('d2', 'assistant', '已修改。', { model: 'mock-1' })],
      {
        cwd: dirtyWt,
        worktreeRepoRoot: repo,
        worktree: { path: dirtyWt, branch: 'tandem/dirty', baseBranch: 'main' },
      },
    ),
  )
  // 浏览器工具调用过的会话：工具卡 + 截图 image block。
  sessions.push({
    ...common,
    id: 'browser',
    title: '浏览器走查会话',
    messages: [
      message('b1', 'user', '打开本地页面并截图。'),
      {
        id: 'b2',
        role: 'assistant',
        createdAt: createdAt + 20_000,
        model: 'mock-1',
        content: [
          { type: 'text', text: '我先打开页面。' },
          { type: 'tool_use', id: 'bu-n', name: 'browser_navigate', input: { url: 'http://127.0.0.1:9/' } },
          { type: 'tool_use', id: 'bu-s', name: 'browser_screenshot', input: {} },
        ],
      },
      {
        id: 'b3',
        role: 'user',
        createdAt: createdAt + 30_000,
        content: [
          { type: 'tool_result', toolUseId: 'bu-n', content: '已打开 http://127.0.0.1:9/\n标题：走查页面' },
          {
            type: 'tool_result',
            toolUseId: 'bu-s',
            content: '截图 screenshotId=shot_reg（800×600）\n页面：http://127.0.0.1:9/\n标题：走查页面',
          },
          {
            type: 'image',
            mediaType: 'image/png',
            dataBase64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          },
        ],
      },
    ],
    createdAt: createdAt + 15_000,
    updatedAt: createdAt + 35_000,
  })
  if (previewCwd) {
    sessions.push(
      mk(
        'preview',
        '应用预览回归会话',
        [
          message('pv1', 'user', '打开应用预览看看。'),
          message('pv2', 'assistant', '已准备好预览。', { model: 'mock-1' }),
        ],
        { cwd: previewCwd, permissionMode: 'acceptEdits' },
      ),
    )
  }
  // 压缩着色：当前消息只含摘要 + 压缩提示 + 保留轮；原文备份里有被压掉的两轮。
  const compactOlder = [
    message('cu1', 'user', '旧轮一：改造登录', { createdAt: createdAt + 100_000 }),
    message('ca1', 'assistant', '旧轮一结果：登录已改造。', {
      model: 'mock-1',
      usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.001 },
    }),
    message('cu2', 'user', '旧轮二：补测试', { createdAt: createdAt + 110_000 }),
    message('ca2', 'assistant', '旧轮二结果：测试已补齐。', {
      model: 'mock-1',
      usage: { inputTokens: 300, outputTokens: 80, costUsd: 0.0008 },
    }),
  ]
  sessions.push(
    mk(
      'compact',
      '压缩着色会话',
      [
        {
          id: 'cmp-summary',
          role: 'user',
          summary: true,
          createdAt: createdAt + 120_000,
          content: [{ type: 'text', text: '[此前对话摘要]\n\n旧轮一、旧轮二已完成。' }],
        },
        {
          id: 'cmp-notice',
          role: 'assistant',
          notice: true,
          createdAt: createdAt + 120_001,
          content: [{ type: 'text', text: '已压缩上下文 · 节省 1.2k tokens' }],
          compaction: {
            summary: '旧轮一、旧轮二已完成。',
            savedTokens: 1200,
            keptTurns: 1,
            auto: false,
            canUndo: true,
          },
        },
        message('ck1', 'user', '保留轮：继续收尾', { createdAt: createdAt + 130_000 }),
        message('ck2', 'assistant', '保留轮结果：收尾完成。', {
          model: 'mock-1',
          usage: { inputTokens: 200, outputTokens: 50, costUsd: 0.0004 },
        }),
      ],
      { updatedAt: Date.now() - 940 },
    ),
  )
  for (const session of sessions) writeJson(path.join(configDir, 'sessions', `${session.id}.json`), session)
  writeJson(path.join(configDir, 'sessions', 'compact.compact.json'), {
    noticeId: 'cmp-notice',
    at: createdAt + 120_001,
    summary: '旧轮一、旧轮二已完成。',
    messages: compactOlder,
  })

  writeJson(path.join(configDir, 'usage.json'), {
    rows: [
      { day: today, hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 12000, outputTokens: 3000, costUsd: 0.84, turns: 4 },
      { day: day(1), hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 9000, outputTokens: 2200, costUsd: 0.61, turns: 3 },
      { day: day(2), hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 5000, outputTokens: 1000, costUsd: 0.32, turns: 2 },
      { day: day(3), hostId, profileId: 'p-main', model: 'mock-1', inputTokens: 3000, outputTokens: 700, costUsd: 0.18, turns: 1 },
    ],
  })

  writeJson(path.join(configDir, 'permissions.json'), [
    { tool: 'Bash', pattern: 'npm test*', action: 'ask' },
  ])

  writeJson(path.join(configDir, 'mcp.json'), {
    servers: [{ name: 'reg-fs', command: '/nonexistent/mcp-reg', args: [], enabled: true }],
  })

  mkdirSync(path.join(configDir, 'memory'), { recursive: true })
  writeFileSync(
    path.join(configDir, 'memory', '_global.md'),
    `<!-- tandem-memory ${JSON.stringify({ project: 'reg' })} -->\n- 用户喜欢深色主题\n- 默认使用中文\n`,
  )

  seedEvals(configDir, repo)
  return { profiles }
}

/** 评测页走查数据：两个用例 × 两个配置，带完整轨迹。 */
export function seedEvals(configDir, repo) {
  const now = Date.now()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim()
  const mkCase = (name, title) => ({
    suite: 'default',
    name,
    title,
    initialPrompt: title,
    snapshot: { mode: 'git', cwd: repo, repoPath: repo, commit },
    checkCommand: 'test -f README.md',
    createdAt: now - 700_000,
  })
  const cases = [mkCase('reg-case-a', '回归用例 A'), mkCase('reg-case-b', '回归用例 B')]
  for (const item of cases) writeJson(path.join(configDir, 'evals/default', `${item.name}.json`), item)
  const configs = [
    { id: 'cfg-a', name: '配置 1', profileId: 'p-main', groupId: 'g1', model: 'mock-1' },
    { id: 'cfg-b', name: '配置 2', profileId: 'p-main', groupId: 'g2', model: 'o3' },
  ]
  const results = []
  for (const item of cases) {
    for (const config of configs) {
      const passed = config.id === 'cfg-a'
      results.push({
        caseName: item.name,
        caseTitle: item.title,
        configId: config.id,
        configName: config.name,
        status: 'done',
        completed: true,
        passed,
        check: { command: 'test -f README.md', exitCode: passed ? 0 : 1, ok: passed, output: '', durationMs: 8 },
        turns: 2,
        toolCalls: 3,
        usage: { inputTokens: 900, outputTokens: 120 },
        costUsd: 0.01,
        durationMs: 40_000,
        messages: [
          { id: `u-${item.name}-${config.id}`, role: 'user', createdAt: now - 50_000, content: [{ type: 'text', text: item.title }] },
          { id: `a-${item.name}-${config.id}`, role: 'assistant', createdAt: now - 40_000, model: config.model, content: [{ type: 'text', text: passed ? '完成。' : '未完成。' }] },
        ],
      })
    }
  }
  writeJson(path.join(configDir, 'evals/runs/run_reg.json'), {
    id: 'run_reg',
    suite: 'default',
    status: 'done',
    startedAt: now - 3_600_000,
    finishedAt: now - 3_500_000,
    configs,
    concurrency: 2,
    total: results.length,
    finished: results.length,
    results,
  })
}

export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
export const A11Y_SEVERE = new Set(['serious', 'critical'])

/** axe 扫描：严重（serious）与关键（critical）违规必须为 0，否则本步失败。 */
export async function auditA11y(page, label) {
  // 等侧栏/消息的入场动画结束，避免把动画中的半透明文字算成对比度违规。
  await page.waitForTimeout(350)
  const analysis = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze()
  const severe = analysis.violations.filter((v) => A11Y_SEVERE.has(v.impact))
  const detail = severe
    .map((v) => `${v.id}(${v.nodes.length} 节点)`)
    .join('、')
  console.log(`  a11y ${label}: 严重/关键 ${severe.length} 条规则${detail ? ` — ${detail}` : ''}`)
  for (const violation of severe) {
    for (const node of violation.nodes.slice(0, 3)) {
      console.log(
        `    - ${violation.id} ${node.target.join(' ')}\n      ${(node.html ?? '').slice(0, 220)}\n      ${(node.failureSummary ?? '').split('\n').slice(1, 2).join(' ')}`,
      )
    }
  }
  assert.equal(severe.length, 0, `${label} 存在严重/关键无障碍违规：${detail}`)
  return analysis
}

export function assertNoOverflow(name, info) {
  assert.ok(info.scrollWidth <= info.clientWidth + 1, `${name}: scrollWidth ${info.scrollWidth} > clientWidth ${info.clientWidth}`)
}

export function withinViewport(box, viewport, label) {
  assert.ok(box, `${label}: 没有可测量的盒子`)
  assert.ok(box.x >= -1, `${label}: 左缘越界 x=${box.x}`)
  assert.ok(box.y >= -1, `${label}: 上缘越界 y=${box.y}`)
  assert.ok(box.x + box.width <= viewport.width + 1, `${label}: 右缘越界 ${box.x + box.width} > ${viewport.width}`)
  assert.ok(box.y + box.height <= viewport.height + 1, `${label}: 下缘越界 ${box.y + box.height} > ${viewport.height}`)
}

/**
 * 等元素上的入场动画结束再测量：弹层带 scale(0.97) 的 chat-pop-in，
 * 动画途中测得的高度/位置都是缩小的中间态（44px 会读成 43px）。
 */
export async function waitAnimations(locator) {
  await locator.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})))
  })
}

