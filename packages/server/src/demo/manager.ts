// 演示工作区：独立 demo git 仓库 + 隐藏演示账号 + 预置场景；可一键创建/重播/清除。
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DemoScenarioInfo, DemoState } from '@tandem/protocol';
import type { Host } from '../host.js';
import { readJson } from '../config.js';
import { demoNetworkRequests } from './provider.js';
import { DEMO_SCENARIOS, demoScenario, type DemoScenarioId } from './scenarios.js';
import {
  applyDemoChanges,
  demoProjectFiles,
  seedDemoScenario,
  type DemoSeedRefs,
} from './seed.js';

interface DemoStateFile {
  version: 1;
  createdAt: number;
  profileId: string;
  project: string;
  previewPort: number;
  scenarios: Record<string, DemoSeedRefs>;
}

const PROFILE_NAME = '演示模型';
const PROFILE_MODELS = ['demo-model', 'demo-backup'];

function demoProfileInput() {
  return {
    name: PROFILE_NAME,
    kind: 'demo' as const,
    baseUrl: 'http://127.0.0.1:1',
    // Key 只用于通过「分组是否有可用 Key」检查；演示 provider 不会使用它，也不会发起请求。
    apiKey: 'demo-key',
    models: PROFILE_MODELS,
    defaultModel: PROFILE_MODELS[0]!,
    modelCapabilities: {
      'demo-model': { contextWindow: 32_000, efforts: [] },
      'demo-backup': { contextWindow: 32_000, efforts: [] },
    },
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeStateFile(file: string, state: DemoStateFile): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows 上 chmod 可能无效
  }
  renameSync(tmp, file);
}

export class DemoManager {
  readonly root: string;
  readonly project: string;
  private readonly stateFile: string;
  private state: DemoStateFile | null = null;
  private server: http.Server | null = null;
  private starting: Promise<DemoState> | null = null;

  constructor(private readonly host: Host) {
    this.root = path.join(host.home, 'demo');
    this.project = path.join(this.root, 'project');
    this.stateFile = path.join(this.root, 'state.json');
    const loaded = readJson<DemoStateFile>(this.stateFile);
    if (loaded && loaded.version === 1 && loaded.project === this.project && existsSync(this.project)) {
      this.state = loaded;
      this.ensureProfile();
    } else if (loaded) {
      // 工程目录被手动删过：不保留悬空状态。
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  /** 当前状态（供 REST/WS 下发）。 */
  get(): DemoState {
    if (!this.state) {
      return { active: false, scenarios: [], networkRequests: demoNetworkRequests };
    }
    const profile = this.host.profiles.get(this.state.profileId);
    const scenarios: DemoScenarioInfo[] = DEMO_SCENARIOS.map((scenario) => {
      const refs = this.state?.scenarios[scenario.id] ?? {};
      const sessionIds = (refs.sessionIds ?? []).filter((id) => this.host.store.get(id));
      const boardId = refs.boardId && this.host.boards.get(refs.boardId) ? refs.boardId : undefined;
      const evalRunId = refs.evalRunId && this.host.evals.getRun(refs.evalRunId) ? refs.evalRunId : undefined;
      return {
        ...scenario,
        ...(sessionIds.length ? { sessionIds } : {}),
        ...(boardId ? { boardId } : {}),
        ...(evalRunId ? { evalRunId } : {}),
        ...(scenario.kind === 'wiki' || scenario.kind === 'preview' ? { project: this.project } : {}),
      };
    });
    return {
      active: true,
      root: this.root,
      project: this.project,
      createdAt: this.state.createdAt,
      ...(profile ? { profile: this.host.profiles.toPublic(profile) } : {}),
      scenarios,
      networkRequests: demoNetworkRequests,
    };
  }

  isDemoPath(target: string): boolean {
    const resolved = path.resolve(target);
    return resolved === this.project || resolved.startsWith(`${this.project}${path.sep}`);
  }

  private persist(): void {
    if (this.state) writeStateFile(this.stateFile, this.state);
  }

  private broadcast(): void {
    this.host.hub.broadcastAll({ type: 'demo_updated', state: this.get() });
  }

  private ensureProfile(): void {
    if (!this.state) return;
    let profile = this.host.profiles.get(this.state.profileId);
    if (!profile || profile.kind !== 'demo') {
      profile = this.host.profiles
        .list()
        .find((item) => item.kind === 'demo' && item.name === PROFILE_NAME);
    }
    if (!profile) {
      profile = this.host.profiles.create(demoProfileInput());
    }
    if (!profile.apiKey) {
      profile = this.host.profiles.update(profile.id, demoProfileInput()) ?? profile;
    }
    if (profile.id !== this.state.profileId) {
      this.state.profileId = profile.id;
      for (const rec of this.host.store.list()) {
        if (!rec.demo) continue;
        rec.profileId = profile.id;
        this.host.store.markDirty(rec.id, false);
        this.host.broadcastSummary(rec);
      }
      this.persist();
    }
  }

  private async startStaticServer(preferredPort?: number): Promise<number | undefined> {
    await this.stopStaticServer();
    if (!existsSync(path.join(this.root, 'site'))) return undefined;
    const root = path.resolve(this.root, 'site');
    const server = http.createServer((req, res) => {
      let urlPath = '/';
      try {
        urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400);
        res.end('bad url');
        return;
      }
      const file = path.resolve(root, `.${urlPath === '/' ? '/index.html' : urlPath}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      let target = file;
      try {
        if (!existsSync(target) || !readFileSync(target)) {
          target = path.join(root, 'index.html');
        }
      } catch {
        target = path.join(root, 'index.html');
      }
      try {
        const body = readFileSync(target);
        res.writeHead(200, {
          'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve((server.address() as { port: number }).port);
        });
      });
    try {
      const port = preferredPort && preferredPort > 0 ? await listen(preferredPort) : await listen(0);
      this.server = server;
      return port;
    } catch {
      try {
        const port = await listen(0);
        this.server = server;
        return port;
      } catch {
        return undefined;
      }
    }
  }

  private async stopStaticServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 300);
    });
  }

  /** 创建演示工作区并预置全部场景；已存在时直接返回。 */
  async create(): Promise<DemoState> {
    if (this.state) return this.get();
    if (this.starting) return this.starting;
    this.starting = this.doCreate().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doCreate(): Promise<DemoState> {
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.project, { recursive: true });
    const siteDir = path.join(this.root, 'site');
    mkdirSync(siteDir, { recursive: true });

    // 先起静态服务拿到端口，package.json 里的 dev 脚本端口才能被应用预览识别。
    const files = demoProjectFiles(0);
    for (const [name, content] of Object.entries(files)) {
      if (name.startsWith('site/')) continue;
      const file = path.join(this.project, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    const siteFiles = demoProjectFiles(0);
    for (const [name, content] of Object.entries(siteFiles)) {
      if (!name.startsWith('site/')) continue;
      const file = path.join(this.root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    const port = await this.startStaticServer(0);
    const previewPort = port ?? 0;
    const withPort = demoProjectFiles(previewPort);
    for (const name of ['README.md', 'package.json', '.gitignore', 'src/app.js', 'src/utils.js', 'docs/notes.md']) {
      const file = path.join(this.project, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, withPort[name] ?? '', 'utf8');
    }

    try {
      git(this.project, ['init', '-b', 'demo']);
    } catch {
      git(this.project, ['init']);
      git(this.project, ['checkout', '-b', 'demo']);
    }
    git(this.project, ['config', 'user.name', 'Tandem Demo']);
    git(this.project, ['config', 'user.email', 'demo@tandem.local']);
    git(this.project, ['add', '-A']);
    git(this.project, ['commit', '-m', '演示项目初始提交']);
    const commit = git(this.project, ['rev-parse', '--short', 'HEAD']);
    applyDemoChanges(this.project);

    const profile = this.profileForSeed();
    this.state = {
      version: 1,
      createdAt: Date.now(),
      profileId: profile.id,
      project: this.project,
      previewPort,
      scenarios: {},
    };
    this.ensureProfile();
    this.persist();

    // inbox 场景依赖前面场景的会话/看板/交接，放在最后。
    const ordered = [...DEMO_SCENARIOS].sort((a, b) =>
      a.id === 'inbox' ? 1 : b.id === 'inbox' ? -1 : 0,
    );
    let fallbackSessionId: string | undefined;
    for (const scenario of ordered) {
      const refs = await seedDemoScenario(
        {
          host: this.host,
          scenario: scenario.id as DemoScenarioId,
          project: this.project,
          profileId: profile.id,
          commit,
          previewUrl: `http://127.0.0.1:${previewPort}/`,
        },
        fallbackSessionId,
      );
      this.state.scenarios[scenario.id] = refs;
      fallbackSessionId = fallbackSessionId ?? refs.sessionIds?.[0];
    }
    this.persist();
    this.broadcast();
    return this.get();
  }

  private profileForSeed() {
    const existing = this.host.profiles.get(this.state?.profileId ?? '');
    if (existing?.kind === 'demo') return existing;
    const found = this.host.profiles.list().find((item) => item.kind === 'demo' && item.name === PROFILE_NAME);
    if (found) return found;
    return this.host.profiles.create(demoProfileInput());
  }

  /** 重新播放单个场景：只替换该场景的会话/看板/评测等对象。 */
  async replay(id: string): Promise<DemoState> {
    if (!this.state) return this.get();
    const scenario = demoScenario(id);
    if (!scenario) throw new Error('演示场景不存在');
    const refs = this.state.scenarios[id];
    await this.removeRefs(refs);
    const state = this.get();
    const profile = this.host.profiles.get(this.state.profileId);
    if (!profile) throw new Error('演示账号缺失，请清除后重新创建演示工作区');
    const sessionId = state.scenarios.find((item) => item.id !== id && item.sessionIds?.length)?.sessionIds?.[0];
    const info = this.host.store
      .list()
      .find((rec) => rec.demo && rec.demoScenario !== id);
    const commit = this.commitOf();
    const seeded = await seedDemoScenario(
      {
        host: this.host,
        scenario: id as DemoScenarioId,
        project: this.project,
        profileId: this.state.profileId,
        commit,
        previewUrl: `http://127.0.0.1:${this.state.previewPort}/`,
      },
      sessionId ?? info?.id,
    );
    this.state.scenarios[id] = seeded;
    this.persist();
    this.broadcast();
    return this.get();
  }

  private commitOf(): string {
    try {
      return git(this.project, ['rev-parse', '--short', 'HEAD']);
    } catch {
      return '';
    }
  }

  /** 打开场景后的动态步骤（目前用于 Hook 出错提示）。 */
  play(id: string): boolean {
    if (!this.state) return false;
    const scenario = demoScenario(id);
    if (!scenario?.playable) return true;
    const sessionId = this.state.scenarios[id]?.sessionIds?.[0];
    if (!sessionId) return false;
    const rec = this.host.store.get(sessionId);
    if (!rec) return false;
    const send = (name: string, message: string, delay: number) => {
      setTimeout(() => {
        if (!this.host.store.get(sessionId)) return;
        this.host.hub.broadcastSession(sessionId, {
          type: 'hook_event',
          sessionId,
          event: 'PreToolUse',
          name,
          ok: false,
          durationMs: 1240,
          message,
        });
      }, delay);
    };
    if (id === 'hooks') {
      send('demo-lint.sh', 'Exit code 2\nsrc/app.js:2  discount 没有上界校验', 0);
      send('demo-typecheck.sh', 'error TS7031: Binding element implicitly has an \'any\' type.', 900);
    }
    return true;
  }

  private async removeRefs(refs: DemoSeedRefs | undefined): Promise<void> {
    if (!refs) return;
    for (const sessionId of refs.sessionIds ?? []) {
      await this.host.deleteSession(sessionId, true).catch(() => false);
    }
    if (refs.boardId) {
      const board = this.host.boards.get(refs.boardId);
      for (const card of board?.cards ?? []) {
        if (card.sessionId) await this.host.deleteSession(card.sessionId, true).catch(() => false);
      }
      this.host.boards.removeDemo(refs.boardId);
    }
    if (refs.evalRunId) this.host.evals.removeDemoRuns([refs.evalRunId], 'demo');
    if (refs.reviewIds?.length) this.host.aiReviews.removeDemoRuns(refs.reviewIds);
    if (refs.taskIds?.length) await this.host.tasks.removeDemo(refs.taskIds);
  }

  /** 一键清除：会话、检查点、记忆、看板、评测、Wiki、索引、演示账号与目录全部移除。 */
  async clear(): Promise<void> {
    if (!this.state) {
      rmSync(this.root, { recursive: true, force: true });
      return;
    }
    const state = this.state;
    for (const refs of Object.values(state.scenarios)) {
      await this.removeRefs(refs);
    }
    const boardIds = new Set(
      Object.values(state.scenarios)
        .map((refs) => refs.boardId)
        .filter((id): id is string => !!id),
    );
    const demoSessionIds = this.host.store
      .list()
      .filter((rec) => rec.demo || (rec.board && boardIds.has(rec.board.boardId)))
      .map((rec) => rec.id);
    for (const sessionId of demoSessionIds) {
      await this.host.deleteSession(sessionId, true).catch(() => false);
    }

    // 收件箱只移除演示事件；保留真实事件与 seq。
    this.host.inbox.removeDemo();
    this.host.hub.broadcastAll({ type: 'inbox_snapshot', snapshot: this.host.inbox.snapshot() });

    // Wiki / 记忆 / 检查点。
    try {
      this.host.wiki.store.writeMeta(this.project, {
        version: 1,
        project: this.project,
        name: 'demo',
        createdAt: 0,
        updatedAt: 0,
        pages: [],
      });
    } catch {
      // 目录可能已不存在
    }
    rmSync(this.host.wiki.store.dirOf(this.project), { recursive: true, force: true });
    this.host.hub.broadcastAll({ type: 'wiki_updated', project: this.project });
    this.host.memory.remove('project', this.project);
    const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const sessionId of demoSessionIds) {
      rmSync(path.join(this.host.home, 'checkpoints', safe(sessionId)), { recursive: true, force: true });
    }

    // 演示评测套件（用例文件）与演示账号。
    this.host.evals.removeDemoRuns([], 'demo');
    const profile = this.host.profiles.get(state.profileId);
    if (profile?.kind === 'demo') this.host.profiles.delete(state.profileId);
    for (const item of this.host.profiles.list()) {
      if (item.kind === 'demo') this.host.profiles.delete(item.id);
    }

    await this.stopStaticServer();
    this.state = null;
    rmSync(this.root, { recursive: true, force: true });
    this.host.hub.broadcastAll({ type: 'demo_updated', state: this.get() });
  }

  /** Host 重启后恢复静态服务（state 已加载时调用）。 */
  async restore(): Promise<void> {
    if (!this.state) return;
    this.ensureProfile();
    const port = await this.startStaticServer(this.state.previewPort);
    if (port && port !== this.state.previewPort) {
      this.state.previewPort = port;
      // 端口被占用时换一个，同时更新 package.json，应用预览才能自动识别。
      try {
        const file = path.join(this.project, 'package.json');
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
        pkg.scripts = { ...(pkg.scripts ?? {}), dev: `node tools/serve.mjs --port ${port}` };
        writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      } catch {
        // 包文件异常不影响状态
      }
      this.persist();
    }
  }

  dispose(): void {
    void this.stopStaticServer();
  }
}
