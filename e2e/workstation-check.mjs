// 工作站客户端-服务模式回归：只跑工作站 + 两台主机，账号只填工作站地址，
// 主机出站隧道 + E2E 转发，用户 2 默认不可见、授权后才可见。
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { E2EChannel } from '../packages/protocol/dist/e2eClient.js'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const CLI = path.join(ROOT, 'packages/server/dist/cli.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 递归读取目录下所有文本文件，用于断言主机本地没有 Key 明文。 */
function assertNoTextInDir(dir, needles, label) {
  const files = []
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  for (const file of files) {
    let text = ''
    try {
      if (statSync(file).size > 5 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const needle of needles) {
      assert.equal(text.includes(needle), false, `${label}：${file} 不应包含 Key 明文`)
    }
  }
}

function mockProvider() {
  const seenKeys = []
  const balanceCalls = { count: 0 }
  const server = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')
    if (auth) seenKeys.push(auth.replace(/^Bearer\s+/i, ''))
    if (req.url.endsWith('/balance')) {
      balanceCalls.count += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ balance: 3.5, currency: 'USD' }))
      return
    }
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'ws-model', object: 'model' }] }))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* ignore */
    }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '标题' }, finish_reason: 'stop' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: '工作站流式' } }] })
    await sleep(40)
    send({ choices: [{ index: 0, delta: { content: '回复通过。' } }] })
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  server.seenKeys = seenKeys
  server.balanceCalls = balanceCalls
  return server
}

function startProcess({ home, mode, port = 0, extraEnv = {} }) {
  const dataDir = mode === 'host' ? path.join(home, '.tandem') : home
  mkdirSync(path.join(dataDir, 'sessions'), { recursive: true })
  const token = randomUUID()
  const hostId = randomUUID()
  if (mode === 'host') {
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ hostId, token, idleTimeoutSec: 300 }))
  }
  const args = mode === 'host' ? [CLI, '--port', String(port)] : [CLI, 'workstation', '--port', String(port), '--host', '127.0.0.1']
  // 默认关掉调试账号自动引导，避免每个用例 Host 都拉起内嵌工作站互相占端口；
  // 调试引导用例用 extraEnv 传 undefined（不设置该变量）覆盖回“调试版默认开启”。
  const env = {
    ...process.env,
    TANDEM_HOME: dataDir,
    HOME: home,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    TANDEM_DEBUG_ACCOUNT: '0',
    ...extraEnv,
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (output += chunk))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`进程启动超时：${output}`)), 20_000)
    const check = () => {
      const match = output.match(/访问:\s+http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', check)
    child.stderr.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`进程提前退出（${code}）：${output}`))
    })
  })
  return { child, ready, token, hostId, logs: () => output }
}

async function json(base, pathname, init = {}, token) {
  const res = await fetch(base + pathname, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}

async function waitFor(fn, label, timeout = 25_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* retry */
    }
    await sleep(200)
  }
  throw new Error(`超时：${label}`)
}

/** 调试版工作站：自动测试账号、密码文件权限、首个真实注册者仍是管理员。 */
async function runDebugAccountCheck(base) {
  const home = path.join(base, 'debug-ws')
  // debug dist 自带调试账号；startProcess 默认 TANDEM_DEBUG_ACCOUNT=0，这里覆盖回调试版默认。
  const proc = startProcess({ home, mode: 'workstation', extraEnv: { TANDEM_DEBUG_ACCOUNT: undefined } })
  try {
    const port = await proc.ready
    const WS = `http://127.0.0.1:${port}`
    const status = await json(WS, '/api/workstation/status')
    assert.equal(status.initialized, true, '调试版工作站应已自动初始化')
    assert.equal(status.debug, true, '调试版工作站状态应带 debug 标记')
    const file = path.join(home, 'debug-account.json')
    assert.ok(existsSync(file), '调试版应生成测试账号密码文件')
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, '测试账号密码文件应为 0600')
    }
    const login = await json(WS, '/api/debug/auto-login', { method: 'POST' })
    assert.equal(login.account.username, 'debug', '免密登录应返回 debug 账号')
    assert.equal(login.account.debug, true, '账号应带调试标记')
    assert.notEqual(login.account.role, 'admin', '测试账号不是管理员')
    const owner = await json(WS, '/api/workstation/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'dbg-owner', password: 'dbg-owner-pass' }),
    })
    assert.equal(owner.account.role, 'admin', '测试账号不算第一个用户，首个真实注册者应为管理员')
    const overview = await json(WS, '/api/workstation/overview', {}, owner.accessToken)
    assert.ok(overview.accounts.some((a) => a.username === 'debug' && a.debug), '管理员应能看到带调试标记的测试账号')
  } finally {
    proc.child.kill('SIGTERM')
  }

  // 调试版 Host 默认自动引导：不传任何 env 开关，几秒内拉起内嵌工作站并登记本机 + 演示主机。
  const hostProc = startProcess({
    home: path.join(base, 'debug-host'),
    mode: 'host',
    extraEnv: { TANDEM_DEBUG_ACCOUNT: undefined },
  })
  try {
    const hostBase = `http://127.0.0.1:${await hostProc.ready}`
    const local = await waitFor(async () => {
      const status = await json(hostBase, '/api/workstation/local/status', {}, hostProc.token)
      return status.embedded?.running && status.embedded.urls?.length ? status : null
    }, '调试版 Host 自动拉起内嵌工作站', 40_000)
    const WS = local.embedded.urls[0]
    assert.ok(WS, '内嵌工作站应下发地址')
    const login = await json(WS, '/api/debug/auto-login', { method: 'POST' })
    const hosts = await waitFor(async () => {
      const list = await json(WS, '/api/workstation/hosts', {}, login.accessToken)
      return list.length === 2 && list.every((h) => h.online) ? list : null
    }, '本机与演示主机经隧道上线', 60_000)
    const demo = hosts.find((h) => h.demo === true)
    assert.ok(demo, '调试账号应看到 demo:true 的演示主机')
    assert.equal(demo.name, '演示主机')
    assert.ok(hosts.some((h) => !h.demo), '调试账号应看到本机主机')
    // 客户端发现新增主机后会换一次访问令牌（新 perHost），再用新令牌访问演示主机。
    const refreshed = await json(WS, '/api/workstation/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    })
    // 演示主机可经工作站 E2E 访问，且演示工作区已创建（演示模型/会话/设备）。
    const demoChannel = new E2EChannel({ baseUrl: `${WS}/h/${demo.id}`, fingerprint: demo.fingerprint })
    const demoRes = await demoChannel.fetch('/api/demo', { headers: { Authorization: `Bearer ${refreshed.accessToken}` } })
    assert.equal(demoRes.status, 200, '应能经工作站访问演示主机')
    const demoState = await demoRes.json()
    assert.equal(demoState.active, true, '演示主机应有已创建的演示工作区')
    assert.ok(demoState.profile?.kind === 'demo', '演示工作区应带演示模型')
    assert.ok(demoState.scenarios.length > 0, '演示工作区应有预置场景')
  } finally {
    hostProc.child.kill('SIGTERM')
  }

  // TANDEM_DEBUG_ACCOUNT=0 模拟发布语义：Host 不拉起内嵌工作站。
  const plain = startProcess({ home: path.join(base, 'plain-host'), mode: 'host' })
  try {
    const plainBase = `http://127.0.0.1:${await plain.ready}`
    await sleep(3000)
    const status = await json(plainBase, '/api/workstation/local/status', {}, plain.token)
    assert.equal(status.mode, 'none', '关闭调试账号时 Host 不应加入工作站')
    assert.equal(status.embedded.running, false, '关闭调试账号时不应拉起内嵌工作站')
  } finally {
    plain.child.kill('SIGTERM')
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/** 安装脚本拉起的后台 Host 不在本进程树里：按 TANDEM_HOME 前缀找到进程并结束（不碰其它进程）。 */
function killHostsUnder(prefix) {
  if (process.platform === 'win32') return
  let entries = []
  try {
    entries = readdirSync('/proc')
  } catch {
    return
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (!pid || pid === process.pid) continue
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      if (!args.some((arg) => arg.endsWith('cli.js'))) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      const home = env.find((item) => item.startsWith('TANDEM_HOME='))?.slice('TANDEM_HOME='.length)
      if (home && home.startsWith(prefix)) process.kill(pid, 'SIGTERM')
    } catch {
      // 进程已退出或无权读取
    }
  }
}

/** 一行命令添加主机：真实 install.sh + 安装包 + 一次性令牌。主机在前台连接工作站，不会自行退出。 */
function startRun(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  return { child, exited, output: () => output }
}

/** 结束前台进程：先按 TANDEM_HOME 结束主机（管道里的 node 不在 sh 的直接子进程树里），再结束 sh。 */
async function stopRun(run, dataDir) {
  killHostsUnder(dataDir)
  run.child.kill('SIGTERM')
  const code = await Promise.race([run.exited, sleep(10_000).then(() => 'timeout')])
  if (code === 'timeout') run.child.kill('SIGKILL')
}

async function waitConnected(run, label) {
  const state = await waitFor(() => {
    if (/已连接工作站/.test(run.output())) return 'connected'
    if (run.child.exitCode !== null) return 'exited'
    return null
  }, label, 90_000)
  assert.equal(state, 'connected', `${label}：进程提前退出：${run.output()}`)
}

export async function runInstallCheck(home) {
  const base = path.join(home, 'workstation-install')
  killHostsUnder(base)
  await sleep(500)
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  mkdirSync(base, { recursive: true })
  const hostPackDir = path.join(ROOT, 'packages', 'server', 'host-pack')
  const packScript = path.join(ROOT, 'scripts', 'pack-host.mjs')
  const ws = startProcess({ home: path.join(base, 'ws'), mode: 'workstation', extraEnv: { TANDEM_HOST_PACK: undefined } })
  const runs = []
  try {
    const wsPort = await ws.ready
    const WS = `http://127.0.0.1:${wsPort}`
    const admin = await json(WS, '/api/workstation/setup', {
      method: 'POST',
      body: JSON.stringify({ name: '安装回归工作站', username: 'inst-admin', password: 'inst-pass-123' }),
    })
    const bind = await json(WS, '/api/workstation/hosts/bind-code', { method: 'POST' }, admin.accessToken)
    assert.ok(bind.code.startsWith('ach_'), '绑定码应为 ach_ 前缀')

    // 每次安装都用独立的 HOME 与安装目录（数据目录在安装目录下的 data）。
    const installEnv = (installDir, extra = {}) => ({
      ...process.env,
      HOME: path.join(base, 'home'),
      TANDEM_INSTALL_DIR: installDir,
      // 调试版 Host 默认会自动登录内嵌调试工作站（8481）；主机包本身是发布版，这里再保险地关掉。
      TANDEM_DEBUG_ACCOUNT: '0',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      ...extra,
    })
    const installCommand = (token, service = false) =>
      `curl -fsSL ${WS}/install.sh | sh -s -- --token ${token}${service ? ' --service' : ''}`
    const startInstall = (installDir, { token = bind.code, service = false, env = {} } = {}) => {
      const run = startRun('sh', ['-c', installCommand(token, service)], installEnv(installDir, env))
      runs.push({ run, dataDir: path.join(installDir, 'data') })
      return run
    }

    // 1) 工作站没有随附安装包：下载失败要非零退出并说明原因（不能静默）。
    rmSync(hostPackDir, { recursive: true, force: true })
    const noPack = spawnSync('sh', ['-c', installCommand(bind.code)], {
      env: installEnv(path.join(base, 'inst-nopack')),
      encoding: 'utf8',
      timeout: 120_000,
    })
    const noPackOut = `${noPack.stdout ?? ''}${noPack.stderr ?? ''}`
    assert.notEqual(noPack.status, 0, `没有安装包时 install.sh 应失败：${noPackOut}`)
    assert.match(noPackOut, /下载主机安装包/, '失败时要说明是下载主机安装包失败')
    assert.match(noPackOut, /tandem-host\.tgz/)
    const noPackDl = await fetch(`${WS}/dl/tandem-host.tgz`)
    assert.equal(noPackDl.status, 404, '没有安装包时 /dl/tandem-host.tgz 应 404')

    // 2) 生成安装包：工作站 status 下发 hostPackage，/dl 可下载。
    execFileSync(process.execPath, [packScript], { cwd: ROOT, stdio: 'pipe' })
    assert.ok(existsSync(path.join(hostPackDir, 'tandem-host.tgz')), 'pack-host 应生成 host-pack/tandem-host.tgz')
    assert.match(execFileSync('tar', ['-xzOf', path.join(hostPackDir, 'tandem-host.tgz'), 'dist/flavor.js'], { encoding: 'utf8' }), /FLAVOR = 'release'/, '主机安装包永远是发布版风味')
    const status = await waitFor(async () => {
      const value = await json(WS, '/api/workstation/status')
      return value.hostPackage?.size > 0 ? value : null
    }, '工作站状态下发 hostPackage', 10_000)
    assert.ok(status.hostPackage.version, 'hostPackage 应带版本号')
    assert.equal(status.hostPackage.zip, true, '工作站应同时下发 Windows ZIP 安装包')
    const dl = await fetch(`${WS}/dl/tandem-host.tgz`)
    assert.equal(dl.status, 200, '应能下载主机安装包')
    assert.equal(Number(dl.headers.get('content-length')), status.hostPackage.size)
    const dlZip = await fetch(`${WS}/dl/tandem-host.zip`)
    assert.equal(dlZip.status, 200, '应能下载 Windows ZIP 安装包')
    const zipBody = Buffer.from(await dlZip.arrayBuffer())
    assert.equal(zipBody.readUInt32LE(0), 0x04034b50, 'ZIP 文件头应为本地文件头')
    assert.ok(zipBody.includes(Buffer.from('dist/cli.js')), 'ZIP 内应包含 dist/cli.js')
    const zipEocd = zipBody.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    assert.ok(zipBody.readUInt16LE(zipEocd + 10) > 1000, 'ZIP 内文件数应合理')

    // 3) 一行命令安装并前台连接：主机上线，令牌不回显，主机凭据 0600，数据目录与安装目录分开。
    const installDir = path.join(base, 'inst')
    const dataDir = path.join(installDir, 'data')
    const first = startInstall(installDir)
    await waitConnected(first, '安装脚本前台连接工作站')
    const installedOut = first.output()
    assert.ok(existsSync(path.join(installDir, 'app', 'dist', 'cli.js')), '安装目录应包含解压后的 CLI')
    assert.ok(installedOut.includes('ach_****'), '安装输出应脱敏令牌')
    assert.ok(!installedOut.includes(bind.code), '安装输出不能回显明文令牌')
    assert.match(installedOut, /已加入工作站/)
    assert.match(installedOut, /关闭此窗口即断开/)
    const hosts = await waitFor(async () => {
      const list = await json(WS, '/api/workstation/hosts', {}, admin.accessToken)
      return list.length === 1 && list[0].online ? list : null
    }, '安装脚本登记的主机上线', 60_000)
    assert.ok(hosts[0].name, '主机应有显示名')
    assert.ok(existsSync(path.join(dataDir, 'accounts.json')), '主机数据目录应为安装目录下的 data')
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(dataDir, 'accounts.json')).mode & 0o777, 0o600, '主机账号文件应为 0600')
    }

    // 4) 前台进程结束后再次执行 join：同一工作站幂等（不报 409，令牌已用也不影响）。
    await stopRun(first, dataDir)
    const cli = path.join(installDir, 'app', 'dist', 'cli.js')
    const again = startRun(process.execPath, [cli, 'join', WS, '--token', bind.code], {
      ...installEnv(installDir),
      TANDEM_HOME: dataDir,
    })
    runs.push({ run: again, dataDir })
    await waitConnected(again, '重复 join 应幂等并连接')
    assert.ok(!/已加入过别的工作站/.test(again.output()), `重复 join 不应报错：${again.output()}`)
    await stopRun(again, dataDir)

    // 5) 同一令牌再用于另一台主机：被工作站拒绝（非零退出、输出含「已使用」）。
    const reusedDir = path.join(base, 'inst2')
    const reused = startInstall(reusedDir)
    const reusedCode = await Promise.race([reused.exited, sleep(120_000).then(() => 'timeout')])
    assert.notEqual(reusedCode, 'timeout', '重复使用令牌应很快失败')
    assert.notEqual(reusedCode, 0, `重复使用令牌应失败：${reused.output()}`)
    assert.match(reused.output(), /已使用|已过期/)
    assert.match(reused.output(), /主机进程退出/)

    // 6) --service：没有 systemd --user 时只告警，前台仍保持连接（用假的 systemctl/loginctl 模拟，不动真实系统）。
    const fakeBin = path.join(base, 'fake-bin')
    mkdirSync(fakeBin, { recursive: true })
    for (const name of ['systemctl', 'loginctl']) {
      writeFileSync(path.join(fakeBin, name), '#!/bin/sh\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n')
      execFileSync('chmod', ['755', path.join(fakeBin, name)])
    }
    const serviceBind = await json(WS, '/api/workstation/hosts/bind-code', { method: 'POST' }, admin.accessToken)
    const serviceDir = path.join(base, 'inst-service')
    const withService = startInstall(serviceDir, {
      token: serviceBind.code,
      service: true,
      env: { PATH: `${fakeBin}:${process.env.PATH}` },
    })
    await waitConnected(withService, '--service 无 systemd 时仍应前台连接')
    assert.match(withService.output(), /开机自启设置失败，不影响本次连接/, '无 systemd 时只告警')
    await stopRun(withService, path.join(serviceDir, 'data'))
  } finally {
    for (const { run, dataDir } of runs) await stopRun(run, dataDir).catch(() => undefined)
    killHostsUnder(base)
    await sleep(500)
    ws.child.kill('SIGTERM')
    // 有主机隧道未断开时工作站关闭可能等待，兜底强杀，避免回归进程挂着不退。
    await sleep(1500)
    if (ws.child.exitCode === null) ws.child.kill('SIGKILL')
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
}

export async function runWorkstationCheck(home) {
  if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket
  const base = path.join(home, 'workstation-reg')
  rmSync(base, { recursive: true, force: true })
  const mock = mockProvider()
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  // 真实注册流程用发布语义（同一份 debug dist 里用 TANDEM_DEBUG_ACCOUNT=0 关掉调试账号）。
  const ws = startProcess({
    home: path.join(base, 'ws'),
    mode: 'workstation',
    extraEnv: { TANDEM_DEBUG_ACCOUNT: '0' },
  })
  const h1 = startProcess({ home: path.join(base, 'h1'), mode: 'host' })
  const h2 = startProcess({ home: path.join(base, 'h2'), mode: 'host' })
  try {
    const wsPort = await ws.ready
    const h1Port = await h1.ready
    const h2Port = await h2.ready
    const WS = `http://127.0.0.1:${wsPort}`
    const autoLogin = await fetch(`${WS}/api/debug/auto-login`, { method: 'POST' })
    assert.equal(autoLogin.status, 404, '关闭调试账号时不应注册 auto-login 路由')
    const alice = await json(WS, '/api/workstation/setup', {
      method: 'POST',
      body: JSON.stringify({ name: '回归工作站', username: 'ws-alice', password: 'alice-pass-123' }),
    })
    assert.equal(alice.account.role, 'admin', '首个注册账号应为管理员')
    assert.deepEqual(alice.hosts, [], '初始化后不应自动出现主机（本机也要显式添加）')
    const bob = await json(WS, '/api/workstation/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'ws-bob', password: 'bob-pass-123' }),
    })
    assert.equal(bob.account.role, 'member', '后续注册应为普通成员')

    // 管理员可改为仅邀请注册；无邀请码注册被拒，带邀请码可注册。
    await json(WS, '/api/workstation/settings', {
      method: 'PATCH',
      body: JSON.stringify({ registration: 'invite' }),
    }, alice.accessToken)
    const deniedRegister = await fetch(`${WS}/api/workstation/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ws-charlie', password: 'charlie-pass-123' }),
    })
    assert.equal(deniedRegister.status, 403, '仅邀请模式下无邀请码注册应 403')
    const invite = await json(WS, '/api/workstation/invites', { method: 'POST' }, alice.accessToken)
    const charlie = await json(WS, '/api/workstation/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'ws-charlie', password: 'charlie-pass-123', inviteCode: invite.code }),
    })
    assert.equal(charlie.account.role, 'member', '邀请注册应为普通成员')

    const aliceKey1 = `sk-ws-alice-${randomUUID()}`
    const aliceKey2 = `sk-ws-alice2-${randomUUID()}`
    const hosts = [
      { proc: h1, port: h1Port, key: aliceKey1 },
      { proc: h2, port: h2Port, key: aliceKey2 },
    ]
    for (const { proc, key } of hosts) {
      await json(`http://127.0.0.1:${proc === h1 ? h1Port : h2Port}`, '/api/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Mock 账号',
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: key,
          models: ['ws-model'],
          defaultModel: 'ws-model',
        }),
      }, proc.token)
      const bind = await json(WS, '/api/workstation/hosts/bind-code', { method: 'POST' }, alice.accessToken)
      const port = proc === h1 ? h1Port : h2Port
      await json(`http://127.0.0.1:${port}`, '/api/workstation/join', {
        method: 'POST',
        body: JSON.stringify({ workstationUrl: WS, code: bind.code }),
      }, proc.token)
    }
    const visible = await waitFor(async () => {
      const list = await json(WS, '/api/workstation/hosts', {}, alice.accessToken)
      return list.length === 2 && list.every((h) => h.online) ? list : null
    }, '两台主机经出站隧道上线')

    // 账号级模型账号：主机连接时一次性把本地 profiles 搬到 alice 账号，然后删除本地文件；
    // 同名同协议以工作站已有为准（h2 的重复账号被丢弃）。
    const profiles = await waitFor(async () => {
      const snapshot = await json(WS, '/api/workstation/profiles', {}, alice.accessToken)
      return snapshot.profiles?.length === 1 ? snapshot : null
    }, '旧 profiles 搬迁到账号级存储')
    assert.equal(profiles.accountId, alice.account.id)
    assert.equal(profiles.profiles[0].name, 'Mock 账号')
    assert.ok(profiles.profiles.every((p) => p.apiKeyMasked.includes('****')), '账号设置只回掩码')
    assert.equal(JSON.stringify(profiles).includes(aliceKey1), false, '账号设置不能回 Key 明文')
    for (const { proc, key } of hosts) {
      const home = path.join(proc === h1 ? path.join(base, 'h1') : path.join(base, 'h2'), '.tandem')
      await waitFor(async () => !existsSync(path.join(home, 'profiles.json')), '主机本地 profiles 文件已删除')
      assertNoTextInDir(home, [aliceKey1, aliceKey2, key], '主机本地文件')
    }
    // 旧的按主机账号 API 已删除：工作站模式下只认账号级 API。
    const legacyProfiles = await fetch(`http://127.0.0.1:${h1Port}/api/profiles`, {
      headers: { authorization: `Bearer ${alice.accessToken}` },
    })
    assert.equal(legacyProfiles.status, 410, '旧的按主机账号 API 应已删除')

    assert.deepEqual(await json(WS, '/api/workstation/hosts', {}, bob.accessToken), [], '新用户默认看不到别人的主机')
    const target = visible.find((h) => h.id === h2.hostId)
    await json(WS, `/api/workstation/hosts/${target.id}/grants`, {
      method: 'POST',
      body: JSON.stringify({ accountId: bob.account.id, role: 'collaborator' }),
    }, alice.accessToken)
    const bobHosts = await json(WS, '/api/workstation/hosts', {}, bob.accessToken)
    assert.deepEqual(bobHosts.map((h) => h.id), [target.id], '授权后只应看到被授权的主机')
    // 授权后刷新令牌：主机侧按新 perHost 声明放行。
    const bobAccess = await json(WS, '/api/workstation/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: bob.refreshToken }) })
    bob.accessToken = bobAccess.accessToken
    bob.refreshToken = bobAccess.refreshToken

    // 只连工作站端口：E2E 经工作站转发到 h1。
    const channel = new E2EChannel({
      baseUrl: `${WS}/h/${h1.hostId}`,
      fingerprint: visible.find((h) => h.id === h1.hostId).fingerprint,
    })
    const info = await channel.fetch('/api/host', { headers: { Authorization: `Bearer ${alice.accessToken}` } })
    assert.ok(info.ok, `经工作站 E2E 访问主机失败：${info.status}`)

    const work = path.join(base, 'work')
    mkdirSync(work, { recursive: true })
    const sessionRes = await channel.fetch('/api/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: work,
        title: '工作站回归会话',
        profileId: profiles.profiles[0].id,
      }),
    })
    assert.equal(sessionRes.status, 201, '应能在 h1 新建会话')
    const session = await sessionRes.json()
    const seen = []
    const reply = await new Promise((resolve, reject) => {
      const socket = channel.openWebSocket(`/ws?token=${encodeURIComponent(alice.accessToken)}`)
      const timer = setTimeout(
        () => reject(new Error(`未收到流式回复（收到 ${seen.join(',')}）\n--- h1 ---\n${h1.logs()}\n--- 工作站 ---\n${ws.logs()}`)),
        30_000,
      )
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }))
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'send', sessionId: session.id, content: [{ type: 'text', text: '请回复' }] }))
        }, 200)
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data)
        seen.push(message.type === 'turn_end' ? `turn_end(${JSON.stringify(message)})` : message.type)
        if (message.type === 'message_end' && message.message?.role === 'assistant') {
          const text = (message.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
          if (text.includes('工作站流式回复通过')) {
            clearTimeout(timer)
            socket.close()
            resolve(text)
          }
        }
        if (message.type === 'error') {
          clearTimeout(timer)
          reject(new Error(`发送失败：${message.message}`))
        }
        if (message.type === 'turn_end' && message.reason === 'error') {
          clearTimeout(timer)
          reject(new Error(`回合失败：${message.error}`))
        }
      }
      socket.onerror = () => reject(new Error('加密 WebSocket 连接失败'))
    })
    assert.ok(reply.includes('工作站流式回复通过'), '应经工作站收到流式回复')
    // 工作站按账号记账；主机本地任何文件都不含 Key 明文。
    const usageFile = path.join(base, 'ws', 'model-usage.json')
    const usageRows = JSON.parse(readFileSync(usageFile, 'utf8')).rows ?? []
    assert.ok(
      usageRows.some((row) => row.accountId === alice.account.id && row.hostId === h1.hostId && row.model === 'ws-model'),
      '工作站应按账号和主机记账',
    )
    assert.ok(mock.seenKeys.includes(aliceKey1), '上游请求应使用工作站里的 alice Key')

    // 共享主机：被授权人用自己的账号级模型账号（bob 的 Key），主机上仍没有明文 Key。
    const bobKey = `sk-ws-bob-${randomUUID()}`
    const bobProfile = await json(WS, '/api/workstation/profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bob 账号',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: bobKey,
        models: ['ws-model'],
        defaultModel: 'ws-model',
        balanceQuery: {
          platform: 'custom',
          url: `http://127.0.0.1:${mockPort}/balance`,
          path: 'balance',
          threshold: 5,
        },
      }),
    }, bob.accessToken)
    // 余额查询：工作站用 Key 查 mock 平台，5 分钟缓存；手动刷新强制重查。
    const bobSnapshot = await json(WS, '/api/workstation/profiles', {}, bob.accessToken)
    const bobBalance = bobSnapshot.profiles.find((p) => p.id === bobProfile.id)?.balance
    assert.equal(bobBalance?.amount, 3.5, '应显示 mock 平台余额')
    assert.equal(mock.balanceCalls.count, 1)
    await json(WS, '/api/workstation/profiles', {}, bob.accessToken)
    assert.equal(mock.balanceCalls.count, 1, '5 分钟内应复用缓存')
    await json(WS, '/api/workstation/profiles?refresh=1', {}, bob.accessToken)
    assert.equal(mock.balanceCalls.count, 2, '手动刷新应强制重查余额')
    assert.deepEqual(
      (await json(WS, '/api/workstation/profiles', {}, alice.accessToken)).profiles.some((p) => p.id === bobProfile.id),
      false,
      'alice 看不到 bob 的模型账号',
    )
    const h2Channel = new E2EChannel({
      baseUrl: `${WS}/h/${h2.hostId}`,
      fingerprint: visible.find((h) => h.id === h2.hostId).fingerprint,
    })
    const bobSessionRes = await h2Channel.fetch('/api/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: work, title: '共享主机会话', profileId: bobProfile.id }),
    })
    const bobSessionText = await bobSessionRes.text()
    assert.equal(bobSessionRes.status, 201, `被授权人应能在共享主机建会话：${bobSessionText}`)
    const bobSession = JSON.parse(bobSessionText)
    const bobReply = await new Promise((resolve, reject) => {
      const socket = h2Channel.openWebSocket(`/ws?token=${encodeURIComponent(bob.accessToken)}`)
      const timer = setTimeout(() => reject(new Error(`bob 未收到流式回复\n${h2.logs()}`)), 30_000)
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: bobSession.id }))
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'send', sessionId: bobSession.id, content: [{ type: 'text', text: '请回复' }] }))
        }, 200)
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data)
        if (message.type === 'message_end' && message.message?.role === 'assistant') {
          const text = (message.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
          if (text.includes('工作站流式回复通过')) {
            clearTimeout(timer)
            socket.close()
            resolve(text)
          }
        }
        if (message.type === 'turn_end' && message.reason === 'error') {
          clearTimeout(timer)
          reject(new Error(`bob 回合失败：${message.error}`))
        }
      }
      socket.onerror = () => reject(new Error('bob 加密 WebSocket 连接失败'))
    })
    assert.ok(bobReply.includes('工作站流式回复通过'), '被授权人应经工作站代理拿到回复')
    assert.ok(mock.seenKeys.includes(bobKey), '共享主机上的请求应使用 bob 自己的 Key')
    assertNoTextInDir(path.join(base, 'h2', '.tandem'), [bobKey], '共享主机本地文件')

    // 撤销授权：旧令牌立即失效（主机快照 invalidBefore），刷新后看到空列表。
    await json(WS, `/api/workstation/hosts/${target.id}/grants/${bob.account.id}`, { method: 'DELETE' }, alice.accessToken)
    const oldTokenRes = await fetch(`${WS}/api/workstation/hosts`, { headers: { authorization: `Bearer ${bob.accessToken}` } })
    assert.equal(oldTokenRes.status, 401, '撤销授权后旧令牌应立即失效')
    const bobTokens = await json(WS, '/api/workstation/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: bob.refreshToken }),
    })
    assert.deepEqual(await json(WS, '/api/workstation/hosts', {}, bobTokens.accessToken), [], '刷新后不应再看到被撤销的主机')

    await runDebugAccountCheck(base)
    await runInstallCheck(base)
  } finally {
    ws.child.kill('SIGTERM')
    h1.child.kill('SIGTERM')
    h2.child.kill('SIGTERM')
    mock.close()
  }
}
