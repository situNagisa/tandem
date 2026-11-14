/**
 * 页面助手：新页面、打开会话/设置、外部会话、设备面板，以及按截图尺寸/主题准备的上下文。
 * 需要每次回归运行的 appUrl/today/base/token，由 e2e/regression.mjs 构造后传入。
 */
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { api } from './seeds.mjs'
import { DESKTOP, sleep } from './common.mjs'

export function createPageHelpers({ appUrl, today, base, token }) {
    const newPage = async (ctx, viewport, opts = {}) => {
      const page = await ctx.newPage()
      page.setDefaultTimeout(15_000)
      // 登录门用例要从干净状态开始；其余用例靠调试账号在回环地址自动登录。
      if (opts.gate) {
        await page.addInitScript(() => {
          try {
            localStorage.removeItem('tandem.gate.skip')
            for (const key of [
              'tandem.account.v1',
              'tandem.hosts.v1',
              'tandem.localhosts.v1',
              'tandem.workstation.lastUrl.v1',
            ]) {
              localStorage.removeItem(key)
            }
          } catch {
            /* 忽略 */
          }
        })
      }
      // 所有页面统一固定在造数时刻：日期、相对时间、倒计时都以同一「今天」计算。
      // 登录门页面不固定时钟：调试版自动登录的重试以 Date.now() 计超时，冻结后永远不会结束。
      if (!opts.gate) await page.clock.setFixedTime(today)
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      if (opts.gate) {
        // 登录门用例自己打开目标工作站地址，并等登录页出现。
        page.__errors = pageErrors
        page.__viewport = viewport
        return page
      }
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
      // 手机首页默认可能是收件箱页签（有待审批时没有输入框），用「新会话」按钮兜底。
      await page
        .locator('[aria-label="消息输入框"], button:has-text("新会话")')
        .first()
        .waitFor({ timeout: 20_000 })
      // 升级导览卡固定在右下角；先关掉，避免遮挡后续用例的点击（专门的导览用例会重新触发）。
      await page
        .locator('[aria-label="暂时关闭新功能提示"]')
        .first()
        .waitFor({ state: 'visible', timeout: 1200 })
        .then(() => page.locator('[aria-label="暂时关闭新功能提示"]').first().click())
        .catch(() => {})
      page.__errors = pageErrors
      page.__viewport = viewport
      return page
    }

    const openSession = async (page, id) => {
      // 直接深链会被初始化流程重置回首页（Host 列表晚于路由到达），
      // 先等会话列表就绪，再用 hashchange 走真实路由。
      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      // 客户端用自己的 Host id（query token 首次连接时生成），与 Host 配置里的 hostId 不同。
      const clientHostId = await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        return hosts[0]?.id ?? null
      })
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/s/${id}`)
      await page.waitForFunction(
        (sessionId) => window.location.hash.includes(`/s/${sessionId}`),
        id,
        { timeout: 10_000 },
      )
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(350)
    }

    /** 打开一个可能还没有任何轮次的新会话（openSession 依赖 [data-turn-id]）。 */
    const gotoSession = async (page, id) => {      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      const clientHostId = await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        return hosts[0]?.id ?? null
      })
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/s/${id}`)
      await page.waitForFunction(
        (sessionId) => window.location.hash.includes(`/s/${sessionId}`),
        id,
        { timeout: 10_000 },
      )
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 15_000 })
      await page.waitForTimeout(300)
    }

    /** 造一个非 Git 目录的会话并打开，结束后删掉会话与临时目录。 */
    const withNonGitSession = async (page, fn) => {
      const nonGit = mkdtempSync(path.join(os.tmpdir(), 'tandem-reg-nogit-'))
      let created
      try {
        created = await api(base, token, '/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            cwd: nonGit,
            profileId: 'p-main',
            groupId: 'g1',
            model: 'mock-1',
            title: '非 Git 会话',
          }),
        })
        await gotoSession(page, created.id)
        await page.locator('[data-env-bar]').first().waitFor()
        await page.waitForTimeout(400)
        await fn()
      } finally {
        if (created) {
          await api(base, token, `/api/sessions/${created.id}?deleteWorktree=false`, { method: 'DELETE' }).catch(() => {})
        }
        rmSync(nonGit, { recursive: true, force: true })
      }
    }

    /** 打开外部会话只读预览（Claude Code / Codex）。 */
    const openExternal = async (page, source, id) => {
      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      const clientHostId = await page.evaluate(() => {
        const hosts = JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')
        return hosts[0]?.id ?? null
      })
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/x/${source}/${id}`)
      await page.waitForFunction(
        (externalId) => window.location.hash.includes(`/x/`) && window.location.hash.includes(`/${externalId}`),
        id,
        { timeout: 10_000 },
      )
      await page.locator('[data-turn-id]').first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(350)
    }

    const waitOnline = async (page) => {
      await page.getByText('在线', { exact: true }).first().waitFor({ timeout: 10_000 }).catch(() => {})
    }

    const waitModelReady = async (page) => {
      await page
        .waitForFunction(
          () => {
            const buttons = [...document.querySelectorAll('button[aria-label^="选择模型"]')]
            return buttons.some((b) => (b.textContent ?? '').trim() && !(b.textContent ?? '').includes('选择模型'))
          },
          null,
          { timeout: 10_000 },
        )
        .catch(() => {})
    }

    // 设置导航已分组：旧用例仍按页签名调用，这里映射到「分组页面 + 子页签」。
    const SETTINGS_PAGE_BY_TAB = {
      '通用': 'general',
      '主机': 'hosts',
      'Host 管理': 'hosts',
      '账号与模型': 'profiles',
      '自动路由': 'routing',
      '模型路由': 'routing',
      '用量': 'usage-budgets',
      '预算': 'usage-budgets',
      '用量与预算': 'usage-budgets',
      '权限': 'permissions',
      '权限与安全': 'permissions',
      'Secrets': 'secrets',
      '工作站': 'workstation',
      '分享': 'shares',
      '子代理': 'agent',
      'Skills': 'agent',
      '提示词': 'agent',
      'Agent 能力': 'agent',
      '定时任务': 'schedules',
      '记忆': 'memory',
      '评测': 'evals',
      '网关': 'gateway',
      '同步与备份': 'sync',
      '外观': 'appearance',
      '通知': 'notifications',
      '语音': 'voice',
      '浏览器': 'browser',
      'MCP': 'extensions',
      'Hooks': 'extensions',
      '扩展': 'extensions',
    }
    const ADVANCED_SETTING_PAGES = new Set(['extensions', 'evals', 'gateway', 'sync'])
    const openSettings = async (page, tab, viewport) => {
      const dialog = page.getByRole('dialog', { name: '设置' })
      if (!(await dialog.isVisible().catch(() => false))) {
        if (viewport === 'mobile') {
          await page.getByRole('button', { name: '打开侧栏' }).click()
          await page.waitForTimeout(350)
          await page.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
        } else {
          await page.locator('aside').getByRole('button', { name: '设置', exact: true }).click()
        }
      }
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      const pageId = SETTINGS_PAGE_BY_TAB[tab] ?? 'general'
      if (ADVANCED_SETTING_PAGES.has(pageId)) {
        const group = dialog.locator('[data-settings-group="advanced"] > button').first()
        if ((await group.getAttribute('aria-expanded')) === 'false') {
          await group.click()
          await page.waitForTimeout(120)
        }
      }
      await dialog.locator(`[data-settings-page="${pageId}"]`).click()
      await page.waitForTimeout(120)
      const subtab = dialog
        .locator('[data-settings-subtabs]')
        .getByRole('button', { name: tab, exact: true })
      if (await subtab.count()) {
        await subtab.click()
        await page.waitForTimeout(120)
      }
      await page.waitForTimeout(220)
      return dialog
    }

    const closeSettings = async (page) => {
      const dialog = page.getByRole('dialog', { name: '设置' })
      if (await dialog.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      }
    }

    /** 设备面板的唯一入口：设置 → 主机 → 主机行 → 设备。 */
    const openWorkstationPanel = async (page) => {
      const settings = await openSettings(page, '主机', 'desktop')
      await settings.locator('[data-host-row]').first().click()
      const detail = page.getByRole('dialog', { name: '主机详情' })
      await detail.waitFor({ state: 'visible', timeout: 10_000 })
      await detail.getByRole('button', { name: '设备', exact: true }).click()
      // 设备弹层在设置之上；直接把设置层关掉，后面只操作设备弹层。
      await settings.locator('button[aria-label="关闭"]').first().evaluate((el) => el.click())
      await page.getByRole('dialog', { name: '设备' }).waitFor({ state: 'visible', timeout: 10_000 })
    }


  // 以下助手原先夹在用例之间定义，统一放在这里。
    const withViewport = async (page, fn) => {
      await page.setViewportSize({ width: 1912, height: 914 })
      try {
        await fn()
      } finally {
        await page.setViewportSize(DESKTOP)
      }
    }
    const setTheme = async (page, theme) => {
      await page.evaluate((next) => localStorage.setItem('tandem.theme.v1', next), theme)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[aria-label="消息输入框"]').waitFor({ timeout: 20_000 })
    }
    const clientHostIdOf = (page) =>
      page.evaluate(() => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null)

    const fix1323Shots = '/tmp/fix-1323c'
    const shot1323 = (name) => path.join(fix1323Shots, name)
    /** 截图用：把页面切到浅色（主题由 root 的 dark 类控制）。 */
    const useLightTheme = async (page) => {
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark')
        document.documentElement.style.colorScheme = 'light'
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#faf9f5')
        localStorage.setItem('tandem.theme.v1', 'light')
      })
      await page.waitForTimeout(120)
    }


    // 截图/调试用的固定目录与看板 API 助手（原先夹在用例之间定义）。
    const shotDir = '/tmp/fix-2102b'
    const boardCall = (pathname, init = {}) =>
      api(base, token, `/api/boards${pathname}`, {
        ...init,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })

    const waitUntil = async (label, fn, timeout = 40_000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const value = await fn()
        if (value) return value
        await sleep(200)
      }
      throw new Error(`等待超时：${label}`)
    }

    const openBoardPage = async (page, boardId) => {
      await page.waitForFunction(
        () => {
          try {
            return JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]').length > 0
          } catch {
            return false
          }
        },
        null,
        { timeout: 20_000 },
      )
      const clientHostId = await page.evaluate(
        () => JSON.parse(localStorage.getItem('tandem.hosts.v1') ?? '[]')[0]?.id ?? null,
      )
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, `#/h/${clientHostId}/b/${boardId}`)
      await page.getByTestId('board-view').waitFor({ timeout: 15_000 })
    }

    const boardColumn = (page, status) => page.locator(`[data-column="${status}"]`)
    const boardCardIn = (page, status, title) =>
      boardColumn(page, status).locator('[data-card-id]').filter({ hasText: title })

  return {
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
  }
}
