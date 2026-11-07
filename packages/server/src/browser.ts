// 浏览器操作：每个会话一个 Playwright 上下文，空闲 10 分钟关闭。
// 安全边界：默认只允许 localhost / 127.0.0.0/8 / [::1] 与 file://；其它域名必须在设置白名单内。
/// <reference lib="dom" />
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BrowserSettings, BrowserState, BrowserStatus } from '@tandem/protocol';
import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright';
import { readJson, writePrivateFile } from './config.js';
import { matchGlob } from './util/glob.js';

const SETTINGS_FILE = 'browser.json';
const IDLE_MS = 10 * 60_000;
const MAX_SHOTS = 40;
const MAX_CONSOLE = 120;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: false,
  allowedHosts: [],
  headless: true,
};

export function loadBrowserSettings(home: string): BrowserSettings {
  const raw = readJson<Partial<BrowserSettings>>(path.join(home, SETTINGS_FILE));
  return sanitizeBrowserSettings(raw ?? DEFAULT_BROWSER_SETTINGS);
}

export function saveBrowserSettings(home: string, settings: BrowserSettings): void {
  writePrivateFile(path.join(home, SETTINGS_FILE), JSON.stringify(settings, null, 2));
}

export function sanitizeBrowserSettings(input: Partial<BrowserSettings>): BrowserSettings {
  const allowedHosts = Array.isArray(input.allowedHosts)
    ? Array.from(
        new Set(
          input.allowedHosts
            .map((item) => normalizeHostPattern(String(item ?? '')))
            .filter((item): item is string => !!item),
        ),
      ).slice(0, 100)
    : [];
  return {
    enabled: input.enabled === true,
    allowedHosts,
    headless: input.headless !== false,
  };
}

/** 去掉协议/路径/端口，留下小写域名或内网网段模式；非法的（如单独的 *）返回 undefined。 */
export function normalizeHostPattern(raw: string): string | undefined {
  let value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return undefined;
    }
  } else {
    value = value.replace(/^\/\//, '');
    const slash = value.indexOf('/');
    if (slash >= 0) value = value.slice(0, slash);
    // IPv6 带多个冒号，不按端口截断
    if ((value.match(/:/g) ?? []).length === 1) value = value.slice(0, value.indexOf(':'));
  }
  value = value.replace(/\.$/, '');
  if (!value || value === '*' || value === '*.' || value.includes(' ')) return undefined;
  return value;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export function isLocalHost(host: string): boolean {
  const value = normalizeHost(host);
  return (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '[::1]' ||
    value === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
  );
}

/** 域名是否匹配设置里的模式：精确、*.example.com、10.*、192.168.* 等。 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const value = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (!value || !p) return false;
  if (value === p) return true;
  // IPv6 只做精确匹配，避免把 [::1] 当成 glob 字符类
  if (p.includes(':')) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return value.endsWith(suffix) || value === p.slice(2);
  }
  if (p.includes('*') || p.includes('?') || p.includes('[') || p.includes('{')) {
    return matchGlob(value, p);
  }
  return false;
}

export interface TargetCheck {
  ok: boolean;
  url?: URL;
  host?: string;
  local?: boolean;
  error?: string;
}

/** 解析并检查 URL：协议只允许 http/https/file；域名必须本机或白名单。 */
export function parseTargetUrl(raw: string, settings: BrowserSettings): TargetCheck {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'url 不能为空' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { ok: false, error: `不是合法的 URL：${text}` };
  }
  if (url.protocol === 'file:') {
    if (!url.pathname || url.pathname === '/') return { ok: false, error: 'file:// 需要指向具体文件' };
    return { ok: true, url, host: '', local: true };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `不支持的协议：${url.protocol}（只允许 http/https/file）` };
  }
  const host = normalizeHost(url.hostname);
  const local = isLocalHost(host);
  if (!local && !settings.allowedHosts.some((pattern) => hostMatchesPattern(host, pattern))) {
    return {
      ok: false,
      error: `域名 ${host} 不在浏览器允许列表。默认只允许本机地址；确需访问请在设置 → 浏览器中加入允许列表。`,
    };
  }
  return { ok: true, url, host, local };
}

export class BrowserUnavailableError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.hint = hint;
  }
}

interface ConsoleEntry {
  level: string;
  text: string;
  at: number;
}

interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  consoleLog: ConsoleEntry[];
  blockedRequests: string[];
}

interface Shot {
  sessionId: string;
  data: Buffer;
  at: number;
}

export interface BrowserManagerOptions {
  /** 会话级已批准的域名（allow_always 记录在会话 allowedTools 里）。 */
  isSessionHostAllowed?: (sessionId: string, host: string) => boolean;
  /** 状态变化时向会话广播（Host 注入）。 */
  onState?: (state: BrowserState) => void;
}

/** key=sessionId。 */
export class BrowserManager {
  readonly home: string;
  settings: BrowserSettings;
  private readonly options: BrowserManagerOptions;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private sessions = new Map<string, BrowserSession>();
  private shots = new Map<string, Shot>();
  private shotSeq = 0;
  private states = new Map<string, BrowserState>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(home: string, options: BrowserManagerOptions = {}) {
    this.home = home;
    this.options = options;
    this.settings = loadBrowserSettings(home);
    this.idleTimer = setInterval(() => void this.closeIdle(), 60_000);
    this.idleTimer.unref();
  }

  updateSettings(input: Partial<BrowserSettings>): BrowserSettings {
    const next = sanitizeBrowserSettings({ ...this.settings, ...input });
    const headlessChanged = next.headless !== this.settings.headless;
    const disabled = this.settings.enabled && !next.enabled;
    this.settings = next;
    saveBrowserSettings(this.home, next);
    if (headlessChanged || disabled) {
      // 模式切换后旧上下文参数不再可靠，统一关闭，下个工具调用重建
      void this.closeAll();
    }
    return next;
  }

  async status(): Promise<BrowserStatus> {
    try {
      const pw = await import('playwright');
      const executable = pw.chromium.executablePath();
      if (!existsSync(executable)) {
        return {
          available: false,
          error: `未找到 Chromium（${executable}）。在 Host 上运行：npx playwright install chromium`,
        };
      }
      return { available: true, browser: executable };
    } catch {
      return {
        available: false,
        error:
          '未安装浏览器组件（Playwright）。在 Host 上运行：npm i playwright && npx playwright install chromium',
      };
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      let pw: typeof import('playwright');
      try {
        pw = await import('playwright');
      } catch {
        throw new BrowserUnavailableError(
          '未安装浏览器组件（Playwright）',
          '在 Host 上运行：npm i playwright && npx playwright install chromium',
        );
      }
      try {
        const browser = await pw.chromium.launch({ headless: this.settings.headless });
        this.browser = browser;
        return browser;
      } catch (err) {
        const message = (err as Error).message;
        throw new BrowserUnavailableError(
          `无法启动 Chromium：${message}`,
          '在 Host 上运行：npx playwright install chromium（Linux 可能还需要 npx playwright install-deps chromium）',
        );
      }
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  async ensureSession(sessionId: string): Promise<BrowserSession> {
    if (!this.settings.enabled) {
      throw new BrowserUnavailableError(
        '浏览器工具已禁用',
        '请在设置 → 浏览器中打开“启用浏览器操作”',
      );
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      acceptDownloads: false,
    });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (this.networkAllowed(url, sessionId)) {
        await route.continue().catch(() => undefined);
        return;
      }
      const session = this.sessions.get(sessionId);
      if (session) {
        session.blockedRequests.push(url);
        session.consoleLog.push({
          level: 'blocked',
          text: `已拦截未授权请求：${url}`,
          at: Date.now(),
        });
        if (session.consoleLog.length > MAX_CONSOLE) {
          session.consoleLog.splice(0, session.consoleLog.length - MAX_CONSOLE);
        }
      }
      await route.abort('blockedbyclient').catch(() => undefined);
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const session: BrowserSession = {
      id: sessionId,
      context,
      page,
      lastUsed: Date.now(),
      consoleLog: [],
      blockedRequests: [],
    };
    const pushLog = (level: string, text: string) => {
      session.consoleLog.push({ level, text: text.slice(0, 4000), at: Date.now() });
      if (session.consoleLog.length > MAX_CONSOLE) {
        session.consoleLog.splice(0, session.consoleLog.length - MAX_CONSOLE);
      }
    };
    page.on('console', (msg: ConsoleMessage) => pushLog(msg.type(), msg.text()));
    page.on('pageerror', (err) => pushLog('pageerror', err.message));
    context.on('close', () => {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  private networkAllowed(rawUrl: string, sessionId: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol === 'file:' || url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:') {
      return true;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return false;
    }
    const host = normalizeHost(url.hostname);
    if (isLocalHost(host)) return true;
    if (this.settings.allowedHosts.some((pattern) => hostMatchesPattern(host, pattern))) {
      // 白名单是可达边界；会话审批只约束 agent 主动 navigate，不重复拦页面自身的资源请求
      return true;
    }
    return this.options.isSessionHostAllowed?.(sessionId, host) === true;
  }

  /** 供权限判定：navigate 用入参 url，其余工具用当前页面地址。 */
  hostFor(toolName: string, input: unknown, sessionId: string): string | undefined {
    const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (toolName === 'browser_navigate' && typeof args.url === 'string') {
      const raw = args.url.trim();
      try {
        return normalizeHost(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname);
      } catch {
        return undefined;
      }
    }
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    try {
      return normalizeHost(new URL(session.page.url()).hostname);
    } catch {
      return undefined;
    }
  }

  checkNavigation(raw: string): TargetCheck {
    return parseTargetUrl(raw, this.settings);
  }

  async navigate(sessionId: string, rawUrl: string): Promise<{ url: string; title: string; status?: number }> {
    const check = this.checkNavigation(rawUrl);
    if (!check.ok || !check.url) throw new Error(check.error ?? '不允许访问该地址');
    const session = await this.ensureSession(sessionId);
    session.lastUsed = Date.now();
    try {
      const response = await session.page.goto(check.url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      await session.page.waitForTimeout(150);
      const title = await session.page.title().catch(() => '');
      return {
        url: session.page.url(),
        title,
        ...(response ? { status: response.status() } : {}),
      };
    } catch (err) {
      const message = (err as Error).message;
      if (/ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED/i.test(message)) {
        throw new Error(`导航被拦截：目标地址不在允许列表（${check.url.toString()}）`);
      }
      if (/Timeout/i.test(message)) {
        const title = await session.page.title().catch(() => '');
        return { url: session.page.url() || check.url.toString(), title };
      }
      throw new Error(`打开页面失败：${message}`);
    }
  }

  async snapshot(sessionId: string): Promise<{ text: string }> {
    const session = await this.ensureSession(sessionId);
    session.lastUsed = Date.now();
    const result = await session.page.evaluate(() => {
      const MAX_LINES = 400;
      document.querySelectorAll('[data-tandem-ref]').forEach((el) => el.removeAttribute('data-tandem-ref'));
      const lines: string[] = [];
      let refCount = 0;
      const norm = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const visible = (el: Element) => {
        const he = el as HTMLElement;
        if (he.hidden) return false;
        const style = getComputedStyle(he);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = he.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelOf = (el: Element) => {
        const aria = norm(el.getAttribute('aria-label'));
        if (aria) return aria;
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = norm(
            labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join(' '),
          );
          if (text) return text;
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          const labels = Array.from(el.labels ?? []).map((label) => norm(label.textContent)).filter(Boolean);
          if (labels.length) return labels.join(' ');
          const placeholder = norm(el.getAttribute('placeholder'));
          if (placeholder) return placeholder;
          if (el instanceof HTMLInputElement && el.type === 'password') return '密码';
          return norm(el.value) || norm(el.getAttribute('name'));
        }
        return (
          norm((el as HTMLElement).innerText) ||
          norm(el.getAttribute('title')) ||
          norm(el.getAttribute('alt')) ||
          norm(el.getAttribute('placeholder'))
        );
      };
      const roleOf = (el: Element): string | undefined => {
        const explicit = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        if (explicit && /^(button|link|textbox|searchbox|combobox|checkbox|radio|tab|menuitem|switch|slider|option|heading|img|list|listitem|navigation|main|banner|contentinfo|dialog|alert|status)$/.test(explicit)) {
          return explicit;
        }
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'input') {
          const type = (el as HTMLInputElement).type;
          if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'search') return 'searchbox';
          if (type === 'range') return 'slider';
          if (type === 'hidden') return undefined;
          return 'textbox';
        }
        if ((el as HTMLElement).isContentEditable) return 'textbox';
        return undefined;
      };
      const emit = (el: Element, role: string, extra?: string) => {
        const ref = `e${++refCount}`;
        el.setAttribute('data-tandem-ref', ref);
        const name = labelOf(el);
        lines.push(`- ${role}${name ? ` "${name}"` : ''} [ref=${ref}]${extra ? ` ${extra}` : ''}`);
      };
      const addText = (text: string) => {
        const value = norm(text);
        if (value.length > 1) lines.push(value.slice(0, 200));
      };
      const walk = (el: Element) => {
        if (lines.length >= MAX_LINES) return;
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template', 'svg', 'canvas'].includes(tag)) return;
        if (!visible(el)) return;
        const role = roleOf(el);
        if (role) {
          if (role === 'checkbox' || role === 'radio' || role === 'switch') {
            emit(el, role, (el as HTMLInputElement).checked ? '[checked]' : '[unchecked]');
          } else if (role === 'link') {
            const href = (el as HTMLAnchorElement).getAttribute('href') ?? '';
            emit(el, role, href ? `href=${href.slice(0, 120)}` : '');
          } else if (role === 'slider') {
            emit(el, role, `value=${(el as HTMLInputElement).value}`);
          } else {
            emit(el, role);
          }
          return;
        }
        if (/^h[1-6]$/.test(tag)) {
          const name = labelOf(el);
          if (name) lines.push(`- heading level=${tag[1]} "${name}"`);
          return;
        }
        if (tag === 'img' && el.getAttribute('alt')) {
          emit(el, 'img');
          return;
        }
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE) addText(node.textContent ?? '');
        }
        for (const child of Array.from(el.children)) walk(child);
      };
      walk(document.body);
      return { lines, truncated: lines.length >= MAX_LINES };
    });
    const header = `页面：${session.page.url()}\n标题：${await session.page.title().catch(() => '')}\n\n`;
    const body = result.lines.length ? result.lines.join('\n') : '(页面没有可见内容)';
    return {
      text: header + body + (result.truncated ? '\n\n…（已截断，只显示前 400 行）' : ''),
    };
  }

  private async locatorFor(session: BrowserSession, ref: string) {
    const value = String(ref ?? '').trim();
    if (!/^e\d+$/.test(value)) throw new Error('ref 无效：请先调用 browser_snapshot 获取元素 ref（形如 e3）');
    const locator = session.page.locator(`[data-tandem-ref="${value}"]`);
    if ((await locator.count()) === 0) {
      throw new Error(`找不到元素 ${value}：页面可能已变化，请重新调用 browser_snapshot`);
    }
    return locator.first();
  }

  private async describeElement(session: BrowserSession, ref: string): Promise<{ role: string; name: string }> {
    const locator = await this.locatorFor(session, ref);
    return locator.evaluate((el) => {
      const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag);
      const name =
        norm(el.getAttribute('aria-label')) ||
        norm((el as HTMLElement).innerText) ||
        norm(el.getAttribute('placeholder')) ||
        norm(el.getAttribute('title')) ||
        norm((el as HTMLInputElement).value);
      return { role, name };
    });
  }

  async click(sessionId: string, ref: string): Promise<{ label: string; role: string; url: string; title: string }> {
    const session = await this.ensureSession(sessionId);
    session.lastUsed = Date.now();
    const info = await this.describeElement(session, ref);
    const locator = await this.locatorFor(session, ref);
    try {
      await locator.click({ timeout: 8000 });
    } catch (err) {
      throw new Error(`点击失败：${(err as Error).message.split('\n')[0]}`);
    }
    await session.page.waitForTimeout(250);
    const title = await session.page.title().catch(() => '');
    return { label: info.name || ref, role: info.role, url: session.page.url(), title };
  }

  async type(
    sessionId: string,
    ref: string,
    text: string,
    submit = false,
  ): Promise<{ label: string; password: boolean; submitted: boolean; url: string; title: string }> {
    const session = await this.ensureSession(sessionId);
    session.lastUsed = Date.now();
    const info = await this.describeElement(session, ref);
    const locator = await this.locatorFor(session, ref);
    const password = await locator
      .evaluate((el) => el instanceof HTMLInputElement && el.type === 'password')
      .catch(() => false);
    try {
      await locator.fill(text, { timeout: 8000 });
      if (submit) await locator.press('Enter', { timeout: 8000 });
    } catch (err) {
      throw new Error(`输入失败：${(err as Error).message.split('\n')[0]}`);
    }
    await session.page.waitForTimeout(submit ? 400 : 150);
    const title = await session.page.title().catch(() => '');
    return {
      label: info.name || ref,
      password,
      submitted: submit,
      url: session.page.url(),
      title,
    };
  }

  async consoleLog(sessionId: string): Promise<string> {
    const session = await this.ensureSession(sessionId);
    session.lastUsed = Date.now();
    if (session.consoleLog.length === 0) return '最近没有 console 输出或页面报错。';
    return session.consoleLog
      .slice(-80)
      .map((entry) => `[${entry.level}] ${entry.text}`)
      .join('\n');
  }

  async screenshot(
    sessionId: string,
    fullPage = false,
  ): Promise<{ id: string; data: Buffer; width: number; height: number; url: string; title: string }> {
    const session = await this.ensureSession(sessionId);
    session.lastUsed = Date.now();
    return this.capture(session, fullPage);
  }

  private async capture(session: BrowserSession, fullPage = false) {
    const data = await session.page.screenshot({
      type: 'jpeg',
      quality: 78,
      fullPage,
      timeout: 15_000,
    });
    const id = `shot_${++this.shotSeq}`;
    this.shots.set(id, { sessionId: session.id, data, at: Date.now() });
    while (this.shots.size > MAX_SHOTS) {
      const oldest = this.shots.keys().next().value;
      if (!oldest) break;
      this.shots.delete(oldest);
    }
    const viewport = session.page.viewportSize() ?? { width: 1280, height: 800 };
    const height = fullPage
      ? await session.page
          .evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0))
          .catch(() => viewport.height)
      : viewport.height;
    return {
      id,
      data,
      width: viewport.width,
      height: Math.max(1, Math.round(height)),
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
    };
  }

  shot(sessionId: string, shotId?: string): { data: Buffer } | undefined {
    if (shotId) {
      const exact = this.shots.get(shotId);
      return exact && exact.sessionId === sessionId ? { data: exact.data } : undefined;
    }
    const state = this.states.get(sessionId);
    if (!state?.screenshotId) return undefined;
    const latest = this.shots.get(state.screenshotId);
    return latest && latest.sessionId === sessionId ? { data: latest.data } : undefined;
  }

  /** 抓一张最新截图并广播状态；工具每次调用后都会刷新面板。 */
  async publish(
    sessionId: string,
    opts: { capture?: boolean; screenshotId?: string; error?: string } = {},
  ): Promise<BrowserState> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const state: BrowserState = {
        sessionId,
        active: false,
        updatedAt: Date.now(),
        ...(opts.error ? { error: opts.error } : {}),
      };
      this.states.set(sessionId, state);
      this.options.onState?.(state);
      return state;
    }
    session.lastUsed = Date.now();
    let screenshotId: string | undefined = opts.screenshotId;
    if (!screenshotId && opts.capture !== false) {
      const shot = await this.capture(session).catch(() => undefined);
      screenshotId = shot?.id;
    }
    const previous = this.states.get(sessionId);
    const state: BrowserState = {
      sessionId,
      active: true,
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
      ...(screenshotId ?? previous?.screenshotId ? { screenshotId: screenshotId ?? previous?.screenshotId } : {}),
      updatedAt: Date.now(),
      ...(opts.error ? { error: opts.error } : {}),
    };
    this.states.set(sessionId, state);
    this.options.onState?.(state);
    return state;
  }

  stateOf(sessionId: string): BrowserState {
    return (
      this.states.get(sessionId) ?? {
        sessionId,
        active: this.sessions.has(sessionId),
        updatedAt: 0,
      }
    );
  }

  async closeSession(sessionId: string, announce = true): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.context.close().catch(() => undefined);
    if (announce) {
      const previous = this.states.get(sessionId);
      const state: BrowserState = {
        sessionId,
        active: false,
        ...(previous?.screenshotId ? { screenshotId: previous.screenshotId } : {}),
        updatedAt: Date.now(),
      };
      this.states.set(sessionId, state);
      this.options.onState?.(state);
    }
  }

  private async closeIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, session] of [...this.sessions]) {
      if (session.lastUsed < cutoff) await this.closeSession(id);
    }
    if (this.sessions.size === 0 && this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    await this.closeAll();
  }
}
