#!/usr/bin/env node
/**
 * 工作站、主机与登录门（设备、执行器、添加主机）。
 *
 * 用例由 e2e/regression.mjs 统一调度（同一临时 Host、同一组浏览器上下文）；
 * 夹具与页面助手见 ./lib/。用例顺序按拆分前的全局顺序排列。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import WebSocket from 'ws'
import { DESKTOP, HOST_ENTRY, MOBILE, ROOT, SMALL, listen, sleep } from './lib/common.mjs'
import { createMockProvider } from './lib/mock-provider.mjs'
import {
  api,
  auditA11y,
  assertNoOverflow,
  freeTcpPort,
  importSeededProfiles,
  seedData,
  seedEvals,
  seedPreviewApp,
  seedRepo,
  seedWiki,
  startHost,
  startWorkstation,
  waitAnimations,
  waitForValue,
  withinViewport,
  writeJson,
  wsInboxSnapshot,
  wsSessionSnapshot,
} from './lib/seeds.mjs'
import { runWorkstationCheck } from '../workstation-check.mjs'
import { killExecutorsUnder, runExecutorCheck } from '../executor-check.mjs'

export const feature = 'workstation'
// 拆分前的全局用例序号：入口据此排序，保证全量执行顺序与拆分前完全一致。
export const order = [208, 209, 210, 211, 213, 214, 215, 216, 217, 222, 223]

export function register(checks, ctx) {
  const {
    desktop,
    mobile,
    small,
    fb2102,
    fbAdjust,
    fbAdjustMobile,
    newPage,
    openSession,
    gotoSession,
    withNonGitSession,
    openExternal,
    waitOnline,
    waitModelReady,
    openSettings,
    closeSettings,
    openWorkstationPanel,
    withViewport,
    setTheme,
    clientHostIdOf,
    fix1323Shots,
    shot1323,
    useLightTheme,
    shotDir,
    boardCall,
    waitUntil,
    openBoardPage,
    boardColumn,
    boardCardIn,
    home,
    wsHome,
    configDir,
    repo,
    shots,
    hostId,
    token,
    wsBase,
    provider,
    mockPort,
    previewApp,
    today,
    dayString,
    browser,
    base,
    appUrl,
    seeded,
    host,
  } = ctx

desktop('工作站：跨主机 ADB/串口挂载、审批与终端', async (page) => {
      const hostIdA = randomUUID()
      const hostA = startHost({
        home: path.join(home, 'host-a'),
        token: randomUUID(),
        hostId: hostIdA,
        extraEnv: { FAKE_ADB_SERIAL: 'REG_A_01', FAKE_ADB_DEVICE: 'RegBoard' },
      })
      let sessionId
      let logTask
      try {
        const accountA = await hostA.session
        const baseA = accountA.base
        const tokenA = accountA.token
        let devicesA
        for (let i = 0; i < 20; i += 1) {
          devicesA = await api(baseA, tokenA, '/api/devices')
          if (devicesA.devices.some((device) => device.id === 'adb:REG_A_01')) break
          await sleep(200)
        }
        assert.ok(devicesA.devices.some((device) => device.id === 'adb:REG_A_01'), '设备 Host A 未发现假 ADB 设备')
        assert.ok(devicesA.devices.some((device) => device.id === 'serial:mock://ttyUSB0'), '设备 Host A 未发现虚拟串口')
        assert.equal(devicesA.serial.mock, true, '串口 mock 未启用')

        const issued = await api(baseA, tokenA, '/api/devices/peer-tokens', {
          method: 'POST',
          body: JSON.stringify({ label: '回归设备代理' }),
        })
        assert.ok(issued.token.startsWith('dvt_'), '设备令牌格式错误')
        // 设备令牌只能访问设备服务，不能读会话。
        const denied = await fetch(`${baseA}/api/sessions`, {
          headers: { authorization: `Bearer ${issued.token}` },
        })
        assert.equal(denied.status, 403, '设备令牌越权访问了会话列表')
        // 明文只出现一次。
        const tokenList = await api(baseA, tokenA, '/api/devices/peer-tokens')
        assert.ok(tokenList.every((item) => !('token' in item)), '设备令牌列表泄露明文')

        const cwd = path.join(home, 'device-workspace')
        mkdirSync(cwd, { recursive: true })
        const created = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ cwd, profileId: 'p-main', groupId: 'g1', model: 'mock-1' }),
        })
        sessionId = created.id
        for (const deviceId of ['adb:REG_A_01', 'serial:mock://ttyUSB0']) {
          const mount = await api(base, token, `/api/sessions/${sessionId}/devices/mount`, {
            method: 'POST',
            body: JSON.stringify({ deviceId, peerUrl: baseA, peerToken: issued.token }),
          })
          assert.equal(mount.source.kind, 'peer', `设备 ${deviceId} 未记录为跨主机来源`)
          assert.equal(mount.source.hostId, hostIdA, `设备 ${deviceId} 的来源 Host 不正确`)
        }
        const mounted = await api(base, token, `/api/sessions/${sessionId}/devices`)
        assert.equal(mounted.mounts.length, 2, '会话挂载数量不正确')
        const serialMount = mounted.mounts.find((item) => item.kind === 'serial')
        const opened = await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/open`, {
          method: 'POST',
          body: JSON.stringify({ baud: 115200 }),
        })
        assert.equal(opened.writable, true, '首个串口租约应可写')
        const first = await api(
          base,
          token,
          `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=0`,
        )
        assert.ok(first.data.includes('Tandem virtual serial ready'), '跨主机串口未读到启动日志')
        await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/write`, {
          method: 'POST',
          body: JSON.stringify({ data: 'hello from regression\n' }),
        })
        await sleep(900)
        const echoed = await api(
          base,
          token,
          `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=0`,
        )
        assert.ok(echoed.data.includes('[echo] hello from regression'), '跨主机串口写入未回显')

        // 另一个会话独占同一串口应被拒绝，共享只读租约不能写。
        const second = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ cwd, profileId: 'p-main', groupId: 'g1', model: 'mock-1' }),
        })
        const secondMount = await api(base, token, `/api/sessions/${second.id}/devices/mount`, {
          method: 'POST',
          body: JSON.stringify({ deviceId: 'serial:mock://ttyUSB0', peerUrl: baseA, peerToken: issued.token }),
        })
        const exclusive = await fetch(`${base}/api/sessions/${second.id}/devices/${secondMount.id}/serial/open`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ baud: 115200 }),
        })
        assert.equal(exclusive.status, 400, '串口独占锁未生效')
        const shared = await api(base, token, `/api/sessions/${second.id}/devices/${secondMount.id}/serial/open`, {
          method: 'POST',
          body: JSON.stringify({ baud: 115200, shared: true }),
        })
        assert.equal(shared.writable, false, '共享串口租约不应可写')
        const sharedWrite = await fetch(`${base}/api/sessions/${second.id}/devices/${secondMount.id}/serial/write`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ data: 'blocked' }),
        })
        assert.equal(sharedWrite.status, 400, '只读共享租约写入了串口')
        const deleted = await fetch(`${base}/api/sessions/${second.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
        assert.ok(deleted.ok, `清理第二个会话失败：${deleted.status}`)

        // 让 agent 走完 7 个设备工具；WS 自动允许审批并记录审批数。
        const approvals = []
        const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`)
        await new Promise((resolve, reject) => {
          ws.on('open', resolve)
          ws.on('error', reject)
        })
        ws.send(JSON.stringify({ type: 'subscribe', sessionId }))
        const turnDone = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('设备 agent 回合超时')), 60_000)
          ws.on('message', (raw) => {
            let msg
            try {
              msg = JSON.parse(String(raw))
            } catch {
              return
            }
            if (msg.type === 'permission_request') {
              approvals.push(msg.request.toolName)
              ws.send(JSON.stringify({ type: 'permission', requestId: msg.request.id, decision: 'allow' }))
            }
            if (msg.type === 'turn_end') {
              clearTimeout(timer)
              resolve(msg)
            }
          })
        })
        ws.send(
          JSON.stringify({
            type: 'send',
            sessionId,
            content: [{ type: 'text', text: 'DEVICE_E2E 开始设备回归' }],
          }),
        )
        const ended = await turnDone
        ws.close()
        assert.equal(ended.reason, 'done', `设备回合未正常结束：${ended.reason}`)
        assert.ok(approvals.length >= 7, `设备工具审批不足：${approvals.join(',')}`)
        const tasks = await api(base, token, `/api/tasks?sessionId=${sessionId}`)
        logTask = tasks.find((task) => task.command.includes('logcat'))
        assert.ok(logTask && logTask.status === 'running', 'logcat 未复用后台任务')
        const full = await api(base, token, `/api/sessions/${sessionId}`)
        const allText = JSON.stringify(full.messages)
        assert.ok(allText.includes('RegBoard'), 'AdbShell 未通过设备 Host 返回型号')
        assert.ok(allText.includes('FakeApp'), 'AdbLogcat 未返回日志')
        assert.ok(allText.includes('Tandem virtual serial ready'), 'SerialRead 未读到串口启动日志')
        assert.ok(allText.includes('已发送 6 字符'), 'SerialWrite 未写入串口')

        // 工作站视图：把设备 Host 也加进客户端，确认两台主机的设备同屏可见。
        await page.evaluate(
          ({ url, token: hostToken, accountUrl, hostId, hostFingerprint }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            if (!hosts.some((item) => item.url === url)) {
              hosts.push({ id: 'reg-host-a', accountId: 'reg-account', name: '设备主机 A', url, token: hostToken, addedAt: Date.now(), mode: 'relay', relayUrl: accountUrl, hostId: hostId, fingerprint: hostFingerprint })
              localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
            }
          },
          { url: baseA, token: tokenA, accountUrl: accountA.wsBase, hostId: accountA.hostId, hostFingerprint: accountA.fingerprint },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openSession(page, sessionId)
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        await dialog.getByText('设备主机 A', { exact: true }).waitFor({ timeout: 10_000 })
        await dialog.getByText(/REG_A_01/).first().waitFor({ timeout: 10_000 })
        await waitForValue(
          async () => ((await dialog.getByText(/Tandem Mock/).count()) >= 2 ? true : null),
          15_000,
          '两台主机的串口未同时列出',
        )
        await dialog.getByRole('button', { name: '完成' }).click()
      } finally {
        if (logTask) {
          await api(base, token, `/api/tasks/${logTask.id}/kill`, { method: 'POST' }).catch(() => {})
        }
        hostA.child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => hostA.child.once('exit', resolve)),
          sleep(3000).then(() => hostA.child.kill('SIGKILL')),
        ])
      }
    })

desktop('工作站：主机没装 adb 时显示说明而不报错', async (page) => {
      const hostIdA = randomUUID()
      const hostA = startHost({
        home: path.join(home, 'host-noadb'),
        token: randomUUID(),
        hostId: hostIdA,
        extraEnv: { TANDEM_ADB_BIN: path.join(home, 'no-such-adb') },
      })
      try {
        const accountA = await hostA.session
        const baseA = accountA.base
        const tokenA = accountA.token
        const devicesA = await api(baseA, tokenA, '/api/devices')
        assert.equal(devicesA.adb.available, false, '不存在的 adb 不应被当作可用')
        assert.equal(devicesA.adb.missing, true, '缺少 adb 时应返回结构化 missing 状态')
        assert.ok(!/spawn adb ENOENT/.test(devicesA.adb.hint ?? ''), '给用户的说明里不应出现原始 ENOENT')
        assert.equal(devicesA.serial.available, true, '串口不应受 adb 缺失影响')

        await page.evaluate(
          ({ url, token: hostToken, accountUrl, hostId, hostFingerprint }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            if (!hosts.some((item) => item.url === url)) {
              hosts.push({ id: 'reg-host-noadb', accountId: 'reg-account', name: '无 adb 主机', url, token: hostToken, addedAt: Date.now(), mode: 'relay', relayUrl: accountUrl, hostId: hostId, fingerprint: hostFingerprint })
              localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
            }
          },
          { url: baseA, token: tokenA, accountUrl: accountA.wsBase, hostId: accountA.hostId, hostFingerprint: accountA.fingerprint },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openSession(page, 'long')
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        const section = dialog.locator('section', { hasText: baseA }).first()
        await section.waitFor({ timeout: 10_000 })
        await section.getByText('未检测到 adb', { exact: true }).waitFor({ timeout: 10_000 })
        assert.equal(await section.getByText('如何安装 / 设置路径').count(), 1, '缺少 adb 时应给安装说明入口')
        assert.equal(await section.locator('.text-danger').count(), 0, '缺少 adb 不应显示为错误')
        assert.equal(await section.getByText(/spawn adb ENOENT/).count(), 0, '界面上不应出现原始 adb 异常')
        await section.getByText('如何安装 / 设置路径').click()
        await section.getByText(/devices\.adbPath/).first().waitFor({ timeout: 5_000 })
        // 反馈9#02：顶部横向系统分段（默认 Host 平台）+ 编号步骤 + 可复制代码块。
        for (const label of ['Windows', 'macOS', 'Linux']) {
          assert.equal(
            await section.getByRole('button', { name: label, exact: true }).count(),
            1,
            `安装说明缺少 ${label} 分段`,
          )
        }
        await section.getByText('安装 adb 与 udev 规则', { exact: true }).waitFor({ timeout: 5_000 })
        await section.getByText(/apt install adb android-sdk-platform-tools-common/).waitFor({ timeout: 5_000 })
        assert.ok(
          await section.getByRole('button', { name: '复制代码' }).count(),
          '代码块缺少复制按钮',
        )
        // Linux 发行版二级分段：Arch / Fedora 命令随之切换。
        await section.getByRole('button', { name: 'Arch', exact: true }).click()
        await section.getByText('sudo pacman -S android-tools', { exact: true }).waitFor({ timeout: 5_000 })
        await section.getByRole('button', { name: 'Fedora', exact: true }).click()
        await section.getByText('sudo dnf install android-tools', { exact: true }).waitFor({ timeout: 5_000 })
        // 顶部系统分段可切换；路径与命令都用等宽字体。
        await section.getByRole('button', { name: 'Windows', exact: true }).click()
        await section.getByText('winget install --id Google.PlatformTools -e', { exact: true }).waitFor({ timeout: 5_000 })
        assert.ok(
          await section.locator('code', { hasText: 'devices.adbPath' }).count(),
          '设置路径没有用等宽字体',
        )
        await section.getByRole('button', { name: 'macOS', exact: true }).click()
        await section.getByText('brew install --cask android-platform-tools', { exact: true }).waitFor({ timeout: 5_000 })
        await dialog.getByRole('button', { name: '完成' }).click()
        await page.evaluate((url) => {
          const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
          localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts.filter((item) => item.url !== url)))
        }, baseA)
      } finally {
        hostA.child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => hostA.child.once('exit', resolve)),
          sleep(3000).then(() => hostA.child.kill('SIGKILL')),
        ])
      }
    })

desktop('工作站：设备单行密度、板载串口折叠、无权限修复说明', async (page) => {
      const hostIdB = randomUUID()
      const hostB = startHost({
        home: path.join(home, 'host-serial-access'),
        token: randomUUID(),
        hostId: hostIdB,
        extraEnv: {
          TANDEM_MOCK_SERIAL_BUILTIN: '1',
          TANDEM_MOCK_SERIAL_DENIED: 'mock://ttyUSB0',
        },
      })
      try {
        const accountB = await hostB.session
        const baseB = accountB.base
        const tokenB = accountB.token
        let list
        for (let i = 0; i < 20; i += 1) {
          list = await api(baseB, tokenB, '/api/devices')
          if ((list.devices ?? []).filter((device) => device.kind === 'serial').length >= 5) break
          await sleep(200)
        }
        const usb = list.devices.find((device) => device.id === 'serial:mock://ttyUSB0')
        assert.equal(usb?.access?.state, 'denied', '串口无权限状态没有返回给客户端')
        assert.ok((usb?.access?.commands ?? []).includes('sudo usermod -aG dialout $USER'), '缺少修复命令')
        assert.equal(list.devices.filter((device) => device.builtin).length, 4, '板载串口未标记 builtin')
        const deep = await api(
          baseB,
          tokenB,
          `/api/devices/${encodeURIComponent('serial:mock://ttyUSB0')}/access-check`,
          { method: 'POST', body: JSON.stringify({}) },
        )
        assert.equal(deep.state, 'denied', '重新检测应保持无权限结论')

        await page.evaluate(
          ({ url, token: hostToken, accountUrl, hostId, hostFingerprint }) => {
            const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
            if (!hosts.some((item) => item.url === url)) {
              hosts.push({ id: 'reg-host-serial', accountId: 'reg-account', name: '串口权限主机', url, token: hostToken, addedAt: Date.now(), mode: 'relay', relayUrl: accountUrl, hostId: hostId, fingerprint: hostFingerprint })
              localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts))
            }
          },
          { url: baseB, token: tokenB, accountUrl: accountB.wsBase, hostId: accountB.hostId, hostFingerprint: accountB.fingerprint },
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        const section = dialog.locator('section[data-host-section]').filter({ hasText: baseB }).first()
        await section.getByText('Tandem Mock').waitFor({ timeout: 10_000 })

        // 单行：真实设备只占一行（与侧栏列表行同为 32px），不再两行。
        const usbRow = section.locator('[data-device-row="serial:mock://ttyUSB0"]')
        const box = await usbRow.boundingBox()
        assert.ok(box && box.height <= 34, `设备行不够紧凑：${box?.height}px`)
        assert.equal(await section.getByText(/^SERIAL$/).count(), 1, '类型应是行内小标签')

        // 板载串口默认折叠；名称与路径相同时不重复显示路径。
        assert.equal(await section.getByText('mock://ttyS0').count(), 0, '板载串口不应默认展开')
        const builtinToggle = section.getByRole('button', { name: /另有 4 个板载串口/ })
        await builtinToggle.waitFor({ timeout: 5_000 })
        await builtinToggle.click()
        const builtinRow = section.locator('[data-device-row="serial:mock://ttyS0"]')
        await builtinRow.waitFor({ timeout: 5_000 })
        const builtinText = await builtinRow.innerText()
        assert.equal((builtinText.match(/mock:\/\/ttyS0/g) ?? []).length, 1, '名称与路径相同时重复显示了路径')

        // 无权限：标签 + 修复说明（命令可复制、Host 不自动执行 sudo、可重新检测）。
        assert.equal(await usbRow.getByText('无权限', { exact: true }).count(), 1, '缺少无权限标签')
        await usbRow.getByRole('button', { name: '修复权限' }).click()
        await section.getByText('sudo usermod -aG dialout $USER', { exact: true }).waitFor({ timeout: 5_000 })
        assert.ok(await section.getByRole('button', { name: '复制命令' }).count(), '缺少一键复制命令')
        assert.equal(
          await section.getByText('Host 不会自动执行 sudo，请在终端里执行上面的命令。', { exact: true }).count(),
          1,
          '应说明 Host 不会自动执行 sudo',
        )
        assert.equal(await section.getByRole('button', { name: '我已处理，重新检测' }).count(), 1, '缺少重新检测入口')

        // 没打开会话时挂载按钮禁用，并在 tooltip 说明原因。
        const mountBtn = usbRow.getByRole('button', { name: '挂到当前会话' })
        assert.equal(await mountBtn.isDisabled(), true, '未打开会话时挂载按钮应禁用')
        assert.equal(
          await usbRow.getByText('先打开一个会话，再挂载设备', { exact: true }).count(),
          1,
          '禁用时应说明原因',
        )

        await dialog.getByRole('button', { name: '完成' }).click()
        await openSession(page, 'long')
        await openWorkstationPanel(page)
        const dialog2 = page.getByRole('dialog', { name: '设备' })
        await dialog2.waitFor({ state: 'visible' })
        const section2 = dialog2.locator('section[data-host-section]').filter({ hasText: baseB }).first()
        await section2.getByText('Tandem Mock').waitFor({ timeout: 10_000 })
        assert.equal(
          await section2.locator('[data-device-row="serial:mock://ttyUSB0"]').getByRole('button', { name: '挂到当前会话' }).isDisabled(),
          false,
          '打开会话后应能挂载',
        )
        await dialog2.getByRole('button', { name: '完成' }).click()
        await page.evaluate((url) => {
          const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
          localStorage.setItem('tandem.hosts.v1', JSON.stringify(hosts.filter((item) => item.url !== url)))
        }, baseB)
      } finally {
        hostB.child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => hostB.child.once('exit', resolve)),
          sleep(3000).then(() => hostB.child.kill('SIGKILL')),
        ])
      }
    })

desktop('演示设备：演示工作区提供可挂载的安卓/串口设备', async (page) => {
      const before = await api(base, token, '/api/demo')
      const createdHere = !before.active
      let sessionId
      try {
        const state = createdHere
          ? await api(base, token, '/api/demo', { method: 'POST', body: JSON.stringify({}) })
          : before
        sessionId = state.scenarios.find((item) => item.id === 'chat-tools')?.sessionIds?.[0]
        assert.ok(sessionId, '演示场景没有会话')

        let list
        for (let i = 0; i < 20; i += 1) {
          list = await api(base, token, '/api/devices')
          if (list.devices.some((device) => device.id === 'adb:demo-pixel-8')) break
          await sleep(200)
        }
        const demoAdb = list.devices.find((device) => device.id === 'adb:demo-pixel-8')
        const demoSerial = list.devices.find((device) => device.id === 'serial:demo-board')
        assert.ok(demoAdb?.demo, '缺少演示安卓设备')
        assert.ok(demoSerial?.demo, '缺少演示串口设备')

        const serialMount = await api(base, token, `/api/sessions/${sessionId}/devices/mount`, {
          method: 'POST',
          body: JSON.stringify({ deviceId: 'serial:demo-board', name: demoSerial.name }),
        })
        await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/open`, {
          method: 'POST',
          body: JSON.stringify({ baud: 115200 }),
        })
        await sleep(700)
        const boot = await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=0`)
        assert.ok(boot.data.includes('[board] ESP32 demo board'), `演示串口没有启动日志：${boot.data}`)
        await api(base, token, `/api/sessions/${sessionId}/devices/${serialMount.id}/serial/write`, {
          method: 'POST',
          body: JSON.stringify({ data: 'help\n' }),
        })
        await sleep(200)
        const echoed = await api(
          base,
          token,
          `/api/sessions/${sessionId}/devices/${serialMount.id}/serial?since=${boot.cursor}`,
        )
        assert.ok(echoed.data.includes('[board] commands: help'), `演示串口没有回显 help：${echoed.data}`)

        const adbMount = await api(base, token, `/api/sessions/${sessionId}/devices/mount`, {
          method: 'POST',
          body: JSON.stringify({ deviceId: 'adb:demo-pixel-8', name: demoAdb.name }),
        })
        assert.equal(adbMount.deviceId, 'adb:demo-pixel-8', '演示安卓设备未挂载')
        const shell = await api(base, token, `/api/devices/${encodeURIComponent('adb:demo-pixel-8')}/exec`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'shell', command: 'getprop ro.product.model' }),
        })
        assert.equal(shell.ok, true, '演示 adb shell 失败')
        assert.ok(shell.output.includes('Pixel 8'), `演示 adb 返回异常：${shell.output}`)

        // 反馈 #7-01：挂载后在会话里能看到演示画面（安卓模拟画面 + 串口滚动日志）。
        await openSession(page, sessionId)
        const stage = page.locator('[data-demo-stage]')
        await stage.waitFor({ state: 'visible', timeout: 15_000 })
        assert.match(await stage.innerText(), /演示画面/, '会话里没有演示画面卡片')
        assert.match(await stage.innerText(), /Pixel 8（演示）/, '演示画面缺少安卓设备')
        await stage.locator('[data-demo-phone]').waitFor({ timeout: 5_000 })
        const serialBox = stage.locator('[data-demo-serial]')
        await serialBox.waitFor({ timeout: 5_000 })
        const serialBefore = (await serialBox.innerText()).length
        await page.waitForTimeout(1800)
        const serialAfter = (await serialBox.innerText()).length
        assert.ok(serialAfter > serialBefore, '演示串口日志没有自动滚动')

        // 工作站界面标注「演示设备」。
        await openWorkstationPanel(page)
        const dialog = page.getByRole('dialog', { name: '设备' })
        await dialog.waitFor({ state: 'visible' })
        await dialog.getByText('演示设备', { exact: true }).first().waitFor({ timeout: 10_000 })
        assert.ok((await dialog.getByText('演示设备', { exact: true }).count()) >= 2, '演示设备没有全部标注')
        await dialog.getByRole('button', { name: '完成' }).click()
      } finally {
        // 本用例是最后一条：无论演示工作区是否由本用例创建，都清干净，
        // 避免残留设备影响后续轮次与真实数据。
        const nowState = await api(base, token, '/api/demo').catch(() => null)
        if (nowState?.active) await api(base, token, '/api/demo', { method: 'DELETE', body: '{}' }).catch(() => {})
      }
      const after = await api(base, token, '/api/devices')
      assert.equal(
        after.devices.some((device) => device.demo),
        false,
        '清除演示数据后仍残留演示设备',
      )
    })

checks.push({
      name: '登录门：未登录先登录、无主机空状态、添加这台电脑后可开会话',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        // 程序即工作站：页面由工作站自己托管，登录门在页面上创建工作站。
        const station = startWorkstation({ home: path.join(home, 'gate-station') })
        const gateHostId = randomUUID()
        try {
          const port = await station.ready
          const base = `http://127.0.0.1:${port}`
          await page.goto(`${base}/#/h/${gateHostId}`, { waitUntil: 'domcontentloaded' })
          await page.locator('[data-testid="login-gate"]').waitFor({ state: 'visible', timeout: 60_000 })
          // 深链保留在地址栏：登录前不处理路由，登录后回到原地址。
          assert.match(page.url(), /#\/h\/[0-9a-f-]+/, '登录前不应清掉深链')
          assert.equal(await page.locator('[data-testid="no-hosts"]').count(), 0, '未登录不应显示无主机空状态')
          assert.equal(await page.locator('[aria-label="消息输入框"]').count(), 0, '未登录不应进入会话界面')

          // 页面本身就是工作站：首次使用是「创建工作站」。
          const name = page.locator('[data-testid="login-workspace-name"]')
          await name.waitFor({ state: 'visible', timeout: 60_000 })
          await name.fill('回归登录门工作站')
          await page.locator('[data-testid="login-username"]').fill('gate-admin')
          await page.locator('[data-testid="login-password"]').fill('gate-pass-123')
          await page.locator('[data-testid="login-submit"]').click()

          // 登录后账号下没有主机：空状态引导添加主机，新会话入口禁用。
          await page.locator('[data-testid="no-hosts"]').waitFor({ state: 'visible', timeout: 30_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '登录后不应再显示登录页')
          assert.equal(
            await page.locator('[data-testid="sidebar-new-session"]').isDisabled(),
            true,
            '没有主机时新会话入口应禁用',
          )

          // 唯一的「添加主机」对话框里有「添加这台电脑」，直接在页面上登记本机。
          await page.locator('[data-testid="no-hosts-add"]').click()
          const addDialog = page.getByRole('dialog', { name: '添加主机' })
          await addDialog.waitFor({ state: 'visible', timeout: 15_000 })
          await addDialog.locator('[data-testid="addhost-local"]').click()
          // 登记成功后对话框显示「已连接」；关掉后回到工作台，空状态消失。
          await addDialog
            .locator('[data-testid="addhost-status"]')
            .filter({ hasText: '已连接' })
            .waitFor({ state: 'visible', timeout: 60_000 })
          await addDialog.getByRole('button', { name: /关闭|完成/ }).first().click()
          await addDialog.waitFor({ state: 'hidden', timeout: 10_000 })
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="no-hosts"]').count(), 0, '添加主机后空状态应消失')
          assert.equal(
            await page.locator('[data-testid="sidebar-new-session"]').isDisabled(),
            false,
            '有主机后新会话入口应可用',
          )
        } finally {
          station.child.kill('SIGTERM')
        }
      },
    })

checks.push({
      name: '主机管理：唯一主机列表与详情抽屉、唯一添加入口、工作站页仅管理员',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const station = startWorkstation({ home: path.join(home, 'host-ia-station') })
        let ownContext
        try {
          const stationPort = await station.ready
          const stationUrl = `http://127.0.0.1:${stationPort}`
          const setup = await (
            await fetch(`${stationUrl}/api/workstation/setup`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: '回归工作站', username: 'ia-admin', password: 'ia-pass-123' }),
            })
          ).json()
          assert.ok(setup.accessToken, '工作站管理员创建失败')
          // 程序即工作站：本机作为进程内主机上下文登记（「添加这台电脑」）。
          const local = await api(stationUrl, setup.accessToken, '/api/workstation/hosts/local', { method: 'POST' })
          assert.ok(local.id, '登记本机失败')
          const hostName = local.name
          await waitForValue(async () => {
            const res = await fetch(`${stationUrl}/api/workstation/hosts`, {
              headers: { authorization: `Bearer ${setup.accessToken}` },
            })
            const list = await res.json()
            return list.some((item) => item.id === local.id && item.online) ? list : null
          }, 60_000, '本机主机应登记上线')

          // 独立上下文：页面由工作站托管，登录门直接登录。
          ownContext = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 })
          const p = await ownContext.newPage()
          p.setDefaultTimeout(15_000)
          await p.goto(`${stationUrl}/#/h/${local.id}`, { waitUntil: 'domcontentloaded' })
          await p.locator('[data-testid="login-gate"]').waitFor({ state: 'visible', timeout: 60_000 })
          await p.locator('[data-testid="login-username"]').waitFor({ state: 'visible', timeout: 30_000 })
          await p.locator('[data-testid="login-username"]').fill('ia-admin')
          await p.locator('[data-testid="login-password"]').fill('ia-pass-123')
          await p.locator('[data-testid="login-submit"]').click()
          await p.locator('[data-sidebar-footer]').waitFor({ timeout: 30_000 })

          // 唯一主机列表：我的徽标、行点击打开详情。
          const dialog = await openSettings(p, '主机', 'desktop')
          const rows = dialog.locator('[data-host-row]')
          await rows.first().waitFor({ timeout: 30_000 })
          assert.equal(await rows.count(), 1, '主机列表应只有登记的那一台')
          assert.ok((await rows.first().innerText()).includes(hostName), '主机列表缺少登记的主机')
          assert.ok((await rows.first().getByText('我的', { exact: true }).count()) >= 1, '主机列表缺少归属徽标')

          // 设置页的添加按钮打开唯一对话框。
          await dialog.getByRole('button', { name: '添加主机', exact: true }).click()
          const addDialog = p.getByRole('dialog', { name: '添加主机' })
          await addDialog.waitFor({ state: 'visible', timeout: 10_000 })
          await addDialog.getByRole('button', { name: /关闭|完成/ }).first().click()
          await addDialog.waitFor({ state: 'hidden', timeout: 5_000 })

          // 点行打开详情：改名、设备、诊断、授权都在这里。
          await rows.first().click()
          const detail = p.getByRole('dialog', { name: '主机详情' })
          await detail.waitFor({ state: 'visible', timeout: 10_000 })
          for (const action of ['设备', '诊断', '重新连接', '授权']) {
            assert.equal(
              await detail.getByRole('button', { name: action, exact: true }).count(),
              1,
              `主机详情缺少「${action}」`,
            )
          }
          await detail.locator('input').first().fill(`${hostName}-改名`)
          await detail.getByRole('button', { name: '保存', exact: true }).click()
          await detail.getByRole('button', { name: '授权', exact: true }).click()
          const grant = p.getByRole('dialog', { name: new RegExp(`^授权「${hostName}`) })
          await grant.waitFor({ state: 'visible', timeout: 10_000 })
          assert.ok(await grant.getByText('账号', { exact: true }).count(), '授权弹层缺少账号选择')
          await grant.getByRole('button', { name: '取消', exact: true }).click()
          await grant.waitFor({ state: 'hidden', timeout: 5_000 })
          await detail.getByRole('button', { name: '完成', exact: true }).click()
          await detail.waitFor({ state: 'hidden', timeout: 5_000 })
          await rows.first().waitFor({ timeout: 5_000 })
          assert.ok((await rows.first().innerText()).includes(`${hostName}-改名`), '改名后列表没有立即更新')
          await closeSettings(p)

          // 环境条主机菜单：固定两项「管理主机…」「添加主机…」，后者打开同一对话框。
          await p.locator('[data-env-bar-row] button[aria-haspopup="menu"]').first().click()
          const hostMenu = p.getByRole('menu').filter({ hasText: '管理主机' }).first()
          await hostMenu.waitFor({ timeout: 5_000 })
          assert.ok(await hostMenu.getByRole('menuitem', { name: '管理主机…', exact: true }).count(), '主机菜单缺少管理主机')
          await hostMenu.getByRole('menuitem', { name: '添加主机…', exact: true }).click()
          const addFromEnv = p.getByRole('dialog', { name: '添加主机' })
          await addFromEnv.waitFor({ state: 'visible', timeout: 10_000 })
          await addFromEnv.getByRole('button', { name: /关闭|完成/ }).first().click()
          await addFromEnv.waitFor({ state: 'hidden', timeout: 5_000 })

          // 命令面板只有一条「添加主机…」，打开的是同一个对话框。
          await p.keyboard.press('Control+k')
          const palette = p.getByRole('dialog', { name: '命令面板' })
          await palette.waitFor({ state: 'visible', timeout: 10_000 })
          await palette.getByPlaceholder(/命令|搜索/).first().fill('添加主机')
          await p.waitForTimeout(500)
          const addCommands = palette.getByText('添加主机…', { exact: true })
          assert.equal(await addCommands.count(), 1, '命令面板里「添加主机」应只有一条')
          await addCommands.first().click()
          const addFromPalette = p.getByRole('dialog', { name: '添加主机' })
          await addFromPalette.waitFor({ state: 'visible', timeout: 10_000 })
          await addFromPalette.getByRole('button', { name: /关闭|完成/ }).first().click()

          // 设置 → 工作站：管理员可见，只放工作站级设置，不再有主机列表。
          const workstation = await openSettings(p, '工作站', 'desktop')
          const wsText = await workstation.locator('[data-settings-page-content="workstation"]').innerText()
          assert.match(wsText, /工作站名称/, '工作站页缺少名称设置')
          assert.match(wsText, /注册与邀请/, '工作站页缺少注册与邀请')
          assert.match(wsText, /成员/, '工作站页缺少成员列表')
          assert.doesNotMatch(wsText, /我的主机|添加主机/, `工作站页仍出现主机管理：${wsText.slice(0, 120)}`)
          await closeSettings(p)

          // 非管理员：导航里没有「工作站」。
          await p.evaluate(() => {
            const raw = localStorage.getItem('tandem.account.v1')
            if (!raw) return
            const session = JSON.parse(raw)
            session.account = { ...session.account, role: 'member' }
            localStorage.setItem('tandem.account.v1', JSON.stringify(session))
          })
          await p.reload({ waitUntil: 'domcontentloaded' })
          await p.locator('[data-sidebar-footer]').waitFor({ timeout: 30_000 })
          await p.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
          const memberSettings = p.getByRole('dialog', { name: '设置' })
          await memberSettings.waitFor({ state: 'visible', timeout: 10_000 })
          assert.equal(
            await memberSettings.locator('[data-settings-page="workstation"]').count(),
            0,
            '非管理员不应看到设置 → 工作站',
          )
        } finally {
          await ownContext?.close().catch(() => undefined)
          station.child.kill('SIGTERM')
        }
      },
    })

checks.push({
      name: '登录门：调试版自动登录带演示主机，一行命令添加主机后显示已连接',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const gateToken = `gate-${randomUUID()}`
        const debugHome = path.join(home, 'gate-debug-host')
        // 不传 TANDEM_DEBUG_ACCOUNT（显式 undefined 让调试版默认值生效）：自动拉起工作站、登记本机与演示主机。
        const debugHost = startHost({
          home: debugHome,
          token: gateToken,
          hostId: randomUUID(),
          extraEnv: { TANDEM_DEBUG_ACCOUNT: undefined },
        })
        let installHome = ''
        let installer
        try {
          const port = await debugHost.ready
          const debugBase = `http://127.0.0.1:${port}`
          await page.goto(`${debugBase}/`, { waitUntil: 'domcontentloaded' })
          // 自动登录完成前不闪登录页；完成后直接进入主界面。
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '调试版回环地址应自动登录')
          const names = await waitForValue(async () => {
            const list = await page.evaluate(() => {
              try {
                return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
              } catch {
                return []
              }
            })
            return list.length >= 2 ? list : null
          }, 60_000, '调试账号应看到本机与演示主机')
          assert.ok(names.some((h) => h.name === '演示主机'), `主机列表缺少演示主机：${names.map((h) => h.name)}`)
          assert.ok(names.some((h) => h.name !== '演示主机'), '主机列表缺少本机')
          await page.getByText('演示主机', { exact: true }).first().waitFor({ timeout: 15_000 })

          // 打开「添加主机」：命令里是一次性令牌；在 WSL 里执行真实 install.sh 模拟目标机器。
          await page.keyboard.press('Control+K')
          const input = page.getByPlaceholder(/命令|搜索/).first()
          await input.waitFor({ state: 'visible' })
          await input.fill('添加主机')
          await page.waitForTimeout(500)
          // 命令面板里点结果（Enter 在搜索防抖未完成时可能选中别的分组）。
          await page.locator('[data-palette-kind]').filter({ hasText: '添加主机' }).first().click()
          const commandBox = page.locator('[data-testid="addhost-command"]')
          await commandBox.waitFor({ state: 'visible', timeout: 15_000 })
          const commandText = await commandBox.innerText()
          const token = commandText.match(/ach_[A-Za-z0-9_.-]+/)?.[0]
          assert.ok(token, `添加主机命令里没有注册令牌：${commandText}`)
          // 命令里的地址就是登录的工作站地址（回环时其他机器不可访问，但本机 WSL 可以）。
          const shareUrl = await page.evaluate(() => {
            try {
              return JSON.parse(localStorage.getItem('tandem.account.v1') ?? 'null')?.centerUrl ?? ''
            } catch {
              return ''
            }
          })
          assert.match(shareUrl, /^https?:\/\/[^/]+/, `宿主地址不对：${shareUrl}`)
          assert.ok(commandText.includes(shareUrl), `命令里的工作站地址与登录地址不一致：${commandText}`)

          installHome = path.join(home, 'gate-install', 'home')
          const env = {
            ...process.env,
            HOME: installHome,
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          }
          // 安装脚本前台连接工作站、不会自行退出：等输出出现「已登记并连接工作站」后再看对话框。
          installer = spawn('sh', ['-c', `curl -fsSL ${shareUrl}/install.sh | sh -s -- --token ${token}`], {
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let installOut = ''
          installer.stdout.setEncoding('utf8')
          installer.stdout.on('data', (chunk) => (installOut += chunk))
          installer.stderr.setEncoding('utf8')
          installer.stderr.on('data', (chunk) => (installOut += chunk))
          await waitForValue(
            () => (/已登记并连接工作站/.test(installOut) || installer.exitCode !== null ? true : null),
            120_000,
            '安装脚本应前台连接工作站',
          )
          assert.match(installOut, /已登记并连接工作站/, `安装脚本应完成登记并保持前台连接：${installOut}`)

          const status = page.locator('[data-testid="addhost-status"]')
          await page.waitForFunction(
            () => document.querySelector('[data-testid="addhost-status"]')?.textContent?.includes('已连接'),
            null,
            { timeout: 60_000 },
          )
          assert.match(await status.innerText(), /已连接/, '对话框应实时显示已连接')
        } finally {
          if (installer?.pid) {
            try {
              process.kill(-installer.pid, 'SIGTERM')
            } catch {
              // 安装脚本已退出
            }
          }
          killExecutorsUnder(installHome)
          debugHost.child.kill('SIGTERM')
        }
      },
    })

checks.push({
      name: '登录门：工作站重启后本机与演示主机仍在线、能开会话',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const debugHome = path.join(home, 'gate-restart-ws')
        const first = startHost({
          home: debugHome,
          token: `gate-${randomUUID()}`,
          hostId: randomUUID(),
        })
        const firstInfo = await first.session
        first.child.kill('SIGTERM')
        await new Promise((resolve) => first.child.once('exit', resolve))

        const second = startHost({
          home: debugHome,
          token: `gate-${randomUUID()}`,
          hostId: firstInfo.hostId,
        })
        try {
          const info = await second.session
          const hosts = await api(info.wsBase, info.token, '/api/workstation/hosts')
          const local = hosts.find((item) => item.id === info.hostId)
          const demo = hosts.find((item) => item.name === '演示主机')
          assert.ok(local?.online, '重启后本机主机应在线')
          assert.ok(demo?.online, '重启后演示主机应在线')

          await page.goto(`${info.wsBase}/`, { waitUntil: 'domcontentloaded' })
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '调试版回环地址应自动登录')

          const dialog = await openSettings(page, '主机', 'desktop')
          await dialog.getByText('在线', { exact: true }).first().waitFor({ timeout: 30_000 })
          await dialog.getByRole('button', { name: '关闭' }).click()
          await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
          assert.equal(
            await page.getByText('主机未连上工作站').filter({ visible: true }).count(),
            0,
            '主机被误报为未连上工作站',
          )
          assert.equal(
            await page.getByText('重新连接中…').filter({ visible: true }).count(),
            0,
            '主机在线时仍显示重新连接中',
          )

          await page.locator('[data-testid="sidebar-new-session"]').click()
          const textarea = page.locator('[aria-label="消息输入框"]')
          await textarea.waitFor({ state: 'visible', timeout: 10_000 })
          await textarea.fill('工作站重启后新建会话')
          const send = page.getByRole('button', { name: '发送消息' })
          await send.waitFor({ timeout: 10_000 })
          assert.equal(await send.isDisabled(), false, '新会话不能发送')
        } finally {
          second.child.kill('SIGTERM')
        }
      },
    })

checks.push({
      name: '登录门：调试版不带 token 打开回环地址自动进入，且不循环请求 401',
      viewport: 'desktop',
      gate: true,
      fn: async (page) => {
        const debugHome = path.join(home, 'gate-debug-bare-host')
        const debugHost = startHost({
          home: debugHome,
          token: `gate-${randomUUID()}`,
          hostId: randomUUID(),
          extraEnv: { TANDEM_DEBUG_ACCOUNT: undefined },
        })
        const statusCodes = []
        page.on('response', (res) => {
          if (res.url().includes('/api/workstation/status')) statusCodes.push(res.status())
        })
        try {
          const port = await debugHost.ready
          await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
          await page.locator('[aria-label="消息输入框"]').waitFor({ state: 'visible', timeout: 60_000 })
          assert.equal(await page.locator('[data-testid="login-gate"]').count(), 0, '打开调试版工作站地址应自动登录')
          const unauthorized = statusCodes.filter((code) => code === 401).length
          assert.equal(unauthorized, 0, `Host 页面不应反复请求工作站状态得到 401：${statusCodes.join(',')}`)
        } finally {
          debugHost.child.kill('SIGTERM')
        }
      },
    })

checks.push({
      name: '工作站客户端-服务（注册/添加主机/授权/E2E 流式）',
      viewport: 'desktop',
      fn: async () => {
        await runWorkstationCheck(home)
      },
    })

checks.push({
      name: '远端执行器：一行命令安装、主机在线、远端会话写入并读回文件',
      viewport: 'desktop',
      fn: async () => {
        await runExecutorCheck(home)
      },
    })
}
