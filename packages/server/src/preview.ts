// 应用预览：在 Host 上用 Playwright 打开本地开发地址，把截图推给客户端；
// 点选元素返回选择器/可访问名称/React 组件位置；Write/Edit 完成后自动刷新。
// 安全边界与浏览器工具一致：默认只允许本机地址，其余域名必须在设置 → 浏览器白名单里。
/// <reference lib="dom" />
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  BackgroundTask,
  BrowserSettings,
  PreviewCandidate,
  PreviewComponentSource,
  PreviewMount,
  PreviewSelection,
  PreviewSnapshot,
  PreviewState,
} from '@tandem/protocol';
import type { Browser, BrowserContext, Page } from 'playwright';
import { BrowserUnavailableError, hostMatchesPattern, isLocalHost, parseTargetUrl } from './browser.js';

const IDLE_MS = 15 * 60_000;
const MAX_SHOTS = 80;
const MAX_SNAPSHOTS = 8;
const REFRESH_DEBOUNCE_MS = 700;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const COMMON_PORTS = [5173, 5174, 3000, 4173, 4321, 8080, 8000];
/** 只匹配本机地址，避免把日志里的公网链接当成候选。 */
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[^\s"'<>`]*)/gi;

interface Shot {
  sessionId: string;
  data: Buffer;
  at: number;
}

interface PreviewSession {
  id: string;
  context: BrowserContext;
  page: Page;
  width: number;
  height: number;
  lastUsed: number;
  /** 累计等待自动刷新的 Write/Edit 次数。 */
  pendingChanges: number;
  changedFiles: Set<string>;
  refreshTimer: NodeJS.Timeout | null;
  snapshots: PreviewSnapshot[];
}

export interface PreviewManagerOptions {
  /** 实时读取设置 → 浏览器的允许列表（预览本身不依赖“启用浏览器操作”）。 */
  getSettings: () => BrowserSettings;
  getSessionCwd?: (sessionId: string) => string | undefined;
  listTasks?: (sessionId: string) => BackgroundTask[];
  readTaskOutput?: (taskId: string) => string;
  onState?: (state: PreviewState) => void;
}

export function previewError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 从 dev/start 脚本或依赖推断端口；返回 undefined 表示没有线索。 */
export function scriptPort(script: string, pkg: Record<string, unknown>): number | undefined {
  const patterns = [
    /--port(?:=|\s+)(\d{2,5})/i,
    /(?:^|\s)-p(?:=|\s+)(\d{2,5})/i,
    /PORT=(\d{2,5})/,
  ];
  for (const pattern of patterns) {
    const match = script.match(pattern);
    if (match) {
      const port = Number(match[1]);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  const deps = {
    ...((pkg.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown> | undefined) ?? {}),
    ...((pkg.peerDependencies as Record<string, unknown> | undefined) ?? {}),
  };
  if (typeof deps.next === 'string') return 3000;
  if (typeof deps.vite === 'string') return 5173;
  if (typeof deps['react-scripts'] === 'string') return 3000;
  if (typeof deps.nuxt === 'string') return 3000;
  return undefined;
}

/** 从后台任务输出里提取本机地址（保留首次出现的路径）。 */
export function urlsFromOutput(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LOCAL_URL_RE)) {
    const raw = match[0].replace(/[),.;，。；]+$/, '');
    if (raw) out.push(raw);
  }
  return out;
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin + '/';
  } catch {
    return raw;
  }
}

/** 探测本机端口是否有 HTTP 服务；不碰任何非本机地址。 */
export function probeLocal(raw: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      resolve(false);
      return;
    }
    if (!isLocalHost(url.hostname)) {
      resolve(false);
      return;
    }
    const req = http.get(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname || '/',
        timeout: timeoutMs,
        headers: { connection: 'close' },
      },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function isLoopbackAddress(raw?: string): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return (
    value === '::1' ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:127.') ||
    value === '[::1]'
  );
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split('\n')[0] ?? '未知错误';
}

/** 把 React 的 fileName 归一化成会话 cwd 下的相对路径。 */
export function relativizeSource(fileName: string, cwd?: string): string {
  let value = fileName.trim().replace(/^file:\/\//, '');
  // Vite 的调用栈是 http://host/src/App.tsx:12；只取路径部分再尝试映射到 cwd。
  if (/^https?:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      /* 保留原值 */
    }
  }
  value = value.split('?')[0] ?? value;
  if (!value) return '';
  if (cwd) {
    const normalized = path.normalize(value);
    const rel = path.relative(cwd, normalized);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    const slash = value.replace(/\\/g, '/');
    const marker = '/' + path.basename(cwd) + '/';
    const idx = slash.lastIndexOf(marker);
    if (idx >= 0) return slash.slice(idx + marker.length);
  }
  if (cwd && !path.isAbsolute(value) && existsSync(path.join(cwd, value))) return value.replace(/\\/g, '/');
  if (cwd && value.startsWith('/') && existsSync(path.join(cwd, value.slice(1)))) return value.slice(1);
  return value;
}

/** key=sessionId。 */
export class PreviewManager {
  private readonly options: PreviewManagerOptions;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private sessions = new Map<string, PreviewSession>();
  private shots = new Map<string, Shot>();
  private states = new Map<string, PreviewState>();
  private shotSeq = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: PreviewManagerOptions) {
    this.options = options;
    this.idleTimer = setInterval(() => void this.closeIdle(), 60_000);
    this.idleTimer.unref();
  }

  private settings(): BrowserSettings {
    return this.options.getSettings();
  }

  private check(raw: string) {
    return parseTargetUrl(raw, this.settings());
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
        const browser = await pw.chromium.launch({ headless: true });
        this.browser = browser;
        return browser;
      } catch (err) {
        throw new BrowserUnavailableError(
          `无法启动 Chromium：${firstLine(err)}`,
          '在 Host 上运行：npx playwright install chromium',
        );
      }
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private networkAllowed(rawUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (
      url.protocol === 'file:' ||
      url.protocol === 'about:' ||
      url.protocol === 'data:' ||
      url.protocol === 'blob:'
    ) {
      return true;
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (isLocalHost(host)) return true;
    return this.settings().allowedHosts.some((pattern) => hostMatchesPattern(host, pattern));
  }

  private async ensureSession(
    sessionId: string,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
  ): Promise<PreviewSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      acceptDownloads: false,
    });
    // 任何子资源也先过白名单：未授权地址在离开 Host 前就被中止。
    await context.route('**/*', async (route) => {
      if (this.networkAllowed(route.request().url())) {
        await route.continue().catch(() => undefined);
      } else {
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const session: PreviewSession = {
      id: sessionId,
      context,
      page,
      width,
      height,
      lastUsed: Date.now(),
      pendingChanges: 0,
      changedFiles: new Set(),
      refreshTimer: null,
      snapshots: [],
    };
    context.on('close', () => {
      if (this.sessions.get(sessionId) === session) {
        if (session.refreshTimer) clearTimeout(session.refreshTimer);
        this.sessions.delete(sessionId);
      }
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  private async capture(
    session: PreviewSession,
    opts: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {},
  ): Promise<{ id: string; data: Buffer }> {
    const data = await session.page.screenshot({
      type: 'jpeg',
      quality: 80,
      ...(opts.fullPage ? { fullPage: true } : {}),
      ...(opts.clip ? { clip: opts.clip } : {}),
      timeout: 15_000,
    });
    const id = `pshot_${++this.shotSeq}`;
    this.shots.set(id, { sessionId: session.id, data, at: Date.now() });
    while (this.shots.size > MAX_SHOTS) {
      const oldest = this.shots.keys().next().value;
      if (!oldest) break;
      this.shots.delete(oldest);
    }
    return { id, data };
  }

  private async historyFlags(page: Page): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    try {
      return await page.evaluate(() => {
        const nav = (window as unknown as { navigation?: { canGoBack?: boolean; canGoForward?: boolean } })
          .navigation;
        if (nav && typeof nav.canGoBack === 'boolean') {
          return {
            canGoBack: nav.canGoBack,
            canGoForward: nav.canGoForward === true,
          };
        }
        return { canGoBack: history.length > 1, canGoForward: false };
      });
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  }

  private async publish(
    sessionId: string,
    opts: {
      capture?: boolean;
      error?: string;
      autoRefresh?: PreviewState['autoRefresh'];
      urlOverride?: string;
    } = {},
  ): Promise<PreviewState> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const state: PreviewState = {
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
    let screenshotId: string | undefined;
    if (opts.capture !== false) {
      screenshotId = (await this.capture(session).catch(() => undefined))?.id;
    }
    const previous = this.states.get(sessionId);
    const history = await this.historyFlags(session.page);
    const state: PreviewState = {
      sessionId,
      active: true,
      url: opts.urlOverride || session.page.url(),
      title: await session.page.title().catch(() => ''),
      width: session.width,
      height: session.height,
      ...(screenshotId ?? previous?.screenshotId
        ? { screenshotId: screenshotId ?? previous?.screenshotId }
        : {}),
      canGoBack: history.canGoBack,
      canGoForward: history.canGoForward,
      snapshotCount: session.snapshots.length,
      ...((opts.autoRefresh ?? previous?.autoRefresh)
        ? { autoRefresh: opts.autoRefresh ?? previous?.autoRefresh }
        : {}),
      updatedAt: Date.now(),
      ...(opts.error ? { error: opts.error } : {}),
    };
    this.states.set(sessionId, state);
    this.options.onState?.(state);
    return state;
  }

  stateOf(sessionId: string): PreviewState {
    return (
      this.states.get(sessionId) ?? {
        sessionId,
        active: this.sessions.has(sessionId),
        updatedAt: 0,
      }
    );
  }

  async open(
    sessionId: string,
    rawUrl: string,
    viewport?: { width?: number; height?: number },
  ): Promise<PreviewState> {
    const check = this.check(rawUrl);
    if (!check.ok || !check.url) throw previewError(check.error ?? '不允许访问该地址');
    const width = clamp(viewport?.width ?? DEFAULT_WIDTH, 240, 3840);
    const height = clamp(viewport?.height ?? DEFAULT_HEIGHT, 240, 3840);
    const session = await this.ensureSession(sessionId, width, height);
    if (session.width !== width || session.height !== height) {
      session.width = width;
      session.height = height;
      await session.page.setViewportSize({ width, height }).catch(() => undefined);
    }
    try {
      await session.page.goto(check.url.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await session.page.waitForTimeout(350);
    } catch (err) {
      const message = firstLine(err);
      if (/ERR_BLOCKED_BY_CLIENT/i.test(message)) {
        throw previewError(`地址被拦截：${check.url.toString()} 不在允许列表`);
      }
      return this.publish(sessionId, {
        capture: false,
        error: `打开页面失败：${message}`,
        urlOverride: check.url.toString(),
      });
    }
    return this.publish(sessionId, { capture: true });
  }

  async reload(sessionId: string): Promise<PreviewState> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.stateOf(sessionId);
    session.lastUsed = Date.now();
    try {
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await session.page.waitForTimeout(300);
    } catch (err) {
      return this.publish(sessionId, { capture: false, error: `刷新失败：${firstLine(err)}` });
    }
    return this.publish(sessionId, { capture: true });
  }

  async back(sessionId: string): Promise<PreviewState> {
    return this.travel(sessionId, 'back');
  }

  async forward(sessionId: string): Promise<PreviewState> {
    return this.travel(sessionId, 'forward');
  }

  private async travel(sessionId: string, direction: 'back' | 'forward'): Promise<PreviewState> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.stateOf(sessionId);
    session.lastUsed = Date.now();
    try {
      if (direction === 'back') {
        await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      } else {
        await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      }
      await session.page.waitForTimeout(250);
    } catch {
      /* 没有历史记录时 goBack/goForward 返回 null，保持当前画面 */
    }
    return this.publish(sessionId, { capture: true });
  }

  async resize(sessionId: string, width: number, height: number): Promise<PreviewState> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.stateOf(sessionId);
    session.width = clamp(width, 240, 3840);
    session.height = clamp(height, 240, 3840);
    session.lastUsed = Date.now();
    await session.page.setViewportSize({ width: session.width, height: session.height }).catch(() => undefined);
    return this.publish(sessionId, { capture: true });
  }

  /** 自动识别：后台任务输出 → package.json dev 端口 → Vite/Next 常见端口。 */
  async detect(sessionId: string): Promise<PreviewCandidate[]> {
    const cwd = this.options.getSessionCwd?.(sessionId);
    const candidates = new Map<string, PreviewCandidate>();
    const add = (url: string, source: PreviewCandidate['source'], label?: string) => {
      let origin: string;
      try {
        origin = new URL(url).origin + '/';
      } catch {
        return;
      }
      if (!candidates.has(origin)) candidates.set(origin, { url: origin, source, reachable: false, ...(label ? { label } : {}) });
    };

    for (const task of this.options.listTasks?.(sessionId) ?? []) {
      const output = this.options.readTaskOutput?.(task.id) ?? '';
      for (const url of urlsFromOutput(output)) add(url, 'task', task.description || '后台任务');
    }

    let pkg: Record<string, unknown> = {};
    if (cwd) {
      try {
        pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
        const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
        const script = [scripts.dev, scripts.start, scripts.serve, scripts.preview].filter(Boolean).join(' ');
        const port = scriptPort(script, pkg);
        if (port) add(`http://localhost:${port}/`, 'package', 'package.json dev 脚本');
      } catch {
        /* 没有 package.json 或格式错误时只靠端口探测 */
      }
    }

    for (const port of COMMON_PORTS) add(`http://localhost:${port}/`, 'port', '常见开发端口');

    const list = [...candidates.values()].slice(0, 16);
    await Promise.all(
      list.map(async (candidate) => {
        candidate.reachable = await probeLocal(candidate.url);
      }),
    );
    return list.sort((a, b) => {
      if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
      const order = { task: 0, package: 1, port: 2 } as const;
      return order[a.source] - order[b.source];
    });
  }

  async select(sessionId: string, x: number, y: number): Promise<PreviewSelection> {
    const session = this.sessions.get(sessionId);
    if (!session) throw previewError('预览尚未打开');
    const px = clamp(x, 0, session.width - 1);
    const py = clamp(y, 0, session.height - 1);
    session.lastUsed = Date.now();
    const raw = await session.page.evaluate(
      ({ px, py }: { px: number; py: number }) => {
        const norm = (value: string | null | undefined) =>
          (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const cssEscape = (value: string) =>
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(value)
            : value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

        const selectorOf = (node: Element): string => {
          const parts: string[] = [];
          let current: Element | null = node;
          let depth = 0;
          while (current && current.nodeType === 1 && depth < 6) {
            if (current.id) {
              parts.unshift(`#${cssEscape(current.id)}`);
              break;
            }
            let part = current.tagName.toLowerCase();
            const classes = Array.from(current.classList)
              .filter((name) => /^[a-zA-Z][\w-]*$/.test(name))
              .slice(0, 2);
            if (classes.length) part += `.${classes.map(cssEscape).join('.')}`;
            const parent: Element | null = current.parentElement;
            if (parent) {
              const same = Array.from(parent.children).filter(
                (child) => child.tagName === current!.tagName,
              );
              if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
            }
            parts.unshift(part);
            current = parent;
            depth += 1;
          }
          return parts.join(' > ');
        };

        const roleOf = (el: Element): string => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === 'button') return 'button';
          if (tag === 'a') return 'link';
          if (tag === 'select') return 'combobox';
          if (tag === 'textarea') return 'textbox';
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'img') return 'img';
          if (tag === 'input') {
            const type = (el as HTMLInputElement).type;
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'range') return 'slider';
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
            return 'textbox';
          }
          if ((el as HTMLElement).isContentEditable) return 'textbox';
          return tag;
        };

        const nameOf = (el: Element): string => {
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
          if (
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement
          ) {
            const labels = Array.from(el.labels ?? [])
              .map((label) => norm(label.textContent))
              .filter(Boolean);
            if (labels.length) return labels.join(' ');
            const placeholder = norm(el.getAttribute('placeholder'));
            if (placeholder) return placeholder;
            return norm(el.getAttribute('value')) || norm(el.getAttribute('name'));
          }
          return (
            norm((el as HTMLElement).innerText) ||
            norm(el.getAttribute('title')) ||
            norm(el.getAttribute('alt')) ||
            norm(el.getAttribute('placeholder'))
          );
        };

        type DebugSource = { fileName?: string; lineNumber?: number; columnNumber?: number };
        type SourceInfo = { file?: string; line?: number; column?: number };
        type FiberLike = {
          type?: unknown;
          elementType?: unknown;
          return?: FiberLike | null;
          _debugSource?: DebugSource;
          _debugOwner?: { type?: unknown; _debugSource?: DebugSource } | null;
          _debugStack?: unknown;
        };
        // React 19 不再稳定提供 _debugSource，但开发模式下 _debugStack 的调用栈里有源码位置。
        const sourceFromStack = (stack: unknown): SourceInfo => {
          const text = stack instanceof Error ? stack.stack : typeof stack === 'string' ? stack : '';
          if (!text) return {};
          for (const line of text.split('\n').slice(1)) {
            if (/node_modules|jsx-dev-runtime|react-dom/.test(line)) continue;
            const match = line.match(/((?:https?:\/\/|file:\/\/|\/)[^\s()]+):(\d+):(\d+)/);
            if (!match) continue;
            return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
          }
          return {};
        };
        const componentOf = (el: Element): { name: string; file?: string; line?: number; column?: number } | undefined => {
          const key = Object.keys(el).find(
            (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
          );
          if (!key) return undefined;
          let fiber = (el as unknown as Record<string, FiberLike | undefined>)[key];
          let fallback: { name: string; file?: string; line?: number; column?: number } | undefined;
          let stackSource: SourceInfo | undefined;
          for (let i = 0; fiber && i < 40; i += 1) {
            if (!stackSource?.file) stackSource = sourceFromStack(fiber._debugStack);
            const type = fiber.type ?? fiber.elementType;
            let name = '';
            if (typeof type === 'function') {
              const fn = type as { displayName?: string; name?: string };
              name = fn.displayName || fn.name || '';
            } else if (type && typeof type === 'object') {
              const obj = type as { displayName?: string; render?: { displayName?: string; name?: string } };
              name = obj.displayName || obj.render?.displayName || obj.render?.name || '';
            }
            if (name && !/^(Fragment|StrictMode|Suspense|Profiler|Provider|Consumer)$/.test(name)) {
              const source = fiber._debugSource ?? fiber._debugOwner?._debugSource;
              const info = {
                name,
                ...(source?.fileName
                  ? { file: source.fileName, line: source.lineNumber, column: source.columnNumber }
                  : stackSource?.file
                    ? stackSource
                    : {}),
              };
              if (!fallback) fallback = info;
              if (source?.fileName) return info;
            }
            fiber = fiber.return ?? undefined;
          }
          return fallback;
        };

        const hit = document.elementFromPoint(px, py);
        if (!hit) return null;
        if (['html', 'body'].includes(hit.tagName.toLowerCase())) return null;
        const actionable = hit.closest(
          'button, a[href], input, select, textarea, label, [role], [tabindex]',
        );
        const target = (actionable ?? hit) as HTMLElement;
        const rect = target.getBoundingClientRect();
        return {
          selector: selectorOf(target),
          tag: target.tagName.toLowerCase(),
          role: roleOf(target),
          name: nameOf(target),
          text: norm(target.innerText).slice(0, 200) || undefined,
          component: componentOf(target),
          rect: {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
        };
      },
      { px, py },
    );
    if (!raw) throw previewError('这个位置没有可选择的元素');
    const cwd = this.options.getSessionCwd?.(sessionId);
    const component: PreviewComponentSource | undefined = raw.component
      ? {
          name: raw.component.name,
          ...(raw.component.file
            ? { file: relativizeSource(raw.component.file, cwd) }
            : {}),
          ...(raw.component.line ? { line: raw.component.line } : {}),
          ...(raw.component.column ? { column: raw.component.column } : {}),
        }
      : undefined;
    let shotId: string | undefined;
    const pad = 4;
    const clip = {
      x: Math.max(0, raw.rect.x - pad),
      y: Math.max(0, raw.rect.y - pad),
      width: Math.min(session.width, raw.rect.width + pad * 2),
      height: Math.min(session.height, raw.rect.height + pad * 2),
    };
    if (clip.x + clip.width > session.width) clip.width = session.width - clip.x;
    if (clip.y + clip.height > session.height) clip.height = session.height - clip.y;
    if (clip.width >= 4 && clip.height >= 4) {
      shotId = (
        await this.capture(session, { clip }).catch(() => undefined)
      )?.id;
    }
    return {
      id: `sel_${randomUUID()}`,
      url: session.page.url(),
      selector: raw.selector,
      tag: raw.tag,
      role: raw.role,
      name: raw.name || raw.text || raw.tag,
      ...(raw.text ? { text: raw.text } : {}),
      ...(component ? { component } : {}),
      rect: raw.rect,
      ...(shotId ? { shotId } : {}),
      createdAt: Date.now(),
    };
  }

  async snapshot(sessionId: string, label?: string): Promise<PreviewSnapshot> {
    const session = this.sessions.get(sessionId);
    if (!session) throw previewError('预览尚未打开');
    session.lastUsed = Date.now();
    const shot = await this.capture(session);
    const snapshot: PreviewSnapshot = {
      id: `snap_${++this.shotSeq}`,
      label: label?.trim().slice(0, 60) || `改前 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      url: session.page.url(),
      width: session.width,
      height: session.height,
      shotId: shot.id,
      createdAt: Date.now(),
    };
    session.snapshots.unshift(snapshot);
    while (session.snapshots.length > MAX_SNAPSHOTS) {
      const removed = session.snapshots.pop();
      if (removed) this.shots.delete(removed.shotId);
    }
    await this.publish(sessionId, { capture: false });
    return snapshot;
  }

  snapshots(sessionId: string): PreviewSnapshot[] {
    return [...(this.sessions.get(sessionId)?.snapshots ?? [])];
  }

  deleteSnapshot(sessionId: string, snapshotId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const index = session.snapshots.findIndex((item) => item.id === snapshotId);
    if (index < 0) return false;
    const [removed] = session.snapshots.splice(index, 1);
    if (removed) this.shots.delete(removed.shotId);
    void this.publish(sessionId, { capture: false });
    return true;
  }

  shot(sessionId: string, shotId?: string): { data: Buffer } | undefined {
    const id = shotId || this.states.get(sessionId)?.screenshotId;
    if (!id) return undefined;
    const shot = this.shots.get(id);
    return shot && shot.sessionId === sessionId ? { data: shot.data } : undefined;
  }

  /** agent 的 Write/Edit 完成后调用；合并短时间内的多次改动后刷新。 */
  noteFileChange(sessionId: string, filePath?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingChanges += 1;
    if (filePath) session.changedFiles.add(filePath);
    if (session.refreshTimer) clearTimeout(session.refreshTimer);
    session.refreshTimer = setTimeout(() => {
      session.refreshTimer = null;
      void this.refreshAfterChanges(sessionId);
    }, REFRESH_DEBOUNCE_MS);
    session.refreshTimer.unref?.();
  }

  private async refreshAfterChanges(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.pendingChanges === 0) return;
    const count = session.pendingChanges;
    session.pendingChanges = 0;
    session.changedFiles.clear();
    session.lastUsed = Date.now();
    try {
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      // 给 dev server 一点时间完成重新编译；HMR 页面通常已经是最新内容。
      await session.page.waitForTimeout(450);
    } catch (err) {
      await this.publish(sessionId, { capture: false, error: `改完自动刷新失败：${firstLine(err)}` });
      return;
    }
    await this.publish(sessionId, {
      capture: true,
      autoRefresh: { count, at: Date.now(), reason: 'edit' },
    });
  }

  mount(sessionId: string, remoteAddress?: string): PreviewMount {
    const state = this.stateOf(sessionId);
    if (!state.active || !state.url) return { embeddable: false, reason: '预览尚未打开' };
    let url: URL;
    try {
      url = new URL(state.url);
    } catch {
      return { embeddable: false, reason: '预览地址无效' };
    }
    if (!isLocalHost(url.hostname)) {
      return { embeddable: false, reason: '只有本机地址可以直接嵌入；白名单地址请用截图模式' };
    }
    if (!isLoopbackAddress(remoteAddress)) {
      return { embeddable: false, reason: '当前客户端不在 Host 本机，无法直接嵌入 localhost' };
    }
    return { embeddable: true, url: state.url };
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

  async closeSession(sessionId: string, announce = true): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.refreshTimer) clearTimeout(session.refreshTimer);
    session.refreshTimer = null;
    this.sessions.delete(sessionId);
    await session.context.close().catch(() => undefined);
    if (announce) {
      const previous = this.states.get(sessionId);
      const state: PreviewState = {
        sessionId,
        active: false,
        ...(previous?.screenshotId ? { screenshotId: previous.screenshotId } : {}),
        updatedAt: Date.now(),
      };
      this.states.set(sessionId, state);
      this.options.onState?.(state);
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
