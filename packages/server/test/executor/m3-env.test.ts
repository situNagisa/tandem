// M3：Write、Edit、Bash 与后台任务经 ctx.env 执行。Linux 远端与本机 bash 对照；
// Windows 远端（经 WSL 互操作运行 windows-amd64.exe）的 Bash 与 cmd.exe 命令行直接执行的结果对照。
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { localHostEnv, type HostEnv } from '../../src/host-env.js';
import { ExecutorConn } from '../../src/executor/conn.js';
import { RemoteHostEnv } from '../../src/executor/remote-env.js';
import { BackgroundTaskManager } from '../../src/tasks.js';
import { decodeProcessOutput } from '../../src/util/encoding.js';
import type { ToolContext } from '../../src/types.js';
import { definition as writeDef, run as runWrite } from '../../src/tools/write.js';
import { definition as editDef, run as runEdit } from '../../src/tools/edit.js';
import { definition as bashDef, run as runBash } from '../../src/tools/bash.js';
import { definition as bashOutputDef, run as runBashOutput } from '../../src/tools/bash-output.js';
import { definition as killBashDef, run as runKillBash } from '../../src/tools/kill-bash.js';
import { startAcceptor } from './acceptor.js';
import {
  CMD_EXE,
  createSandbox,
  forEachTarget,
  isAlive,
  runCleanups,
  startExecutor,
  waitUntil,
  WINDOWS_AVAILABLE,
  type Sandbox,
} from './harness.js';
import os from 'node:os';

const SANDBOX_PROFILE = { engine: 'bwrap' as const, binary: 'bwrap', network: 'host' as const };

function ctxFor(env: HostEnv, cwd: string, extra: Record<string, unknown> = {}): ToolContext {
  return {
    cwd,
    session: { id: 'm3-test' } as ToolContext['session'],
    signal: new AbortController().signal,
    updateTodos: () => {},
    env,
    ...extra,
  } as ToolContext;
}

/** 与 Bash 工具的输出格式一致：stdout、[stderr]、退出码。 */
function formatResult(stdout: string, stderr: string, exit: number): string {
  const parts: string[] = [];
  const out = stdout.replace(/\s+$/, '');
  const err = stderr.replace(/\s+$/, '');
  if (out) parts.push(out);
  if (err) parts.push(`[stderr]\n${err}`);
  if (parts.length === 0) parts.push('(无输出)');
  let text = parts.join('\n');
  if (exit !== 0) text += `\n[退出码: ${exit}]`;
  return text;
}

/** Windows 本机分支的调用方式：把命令交给 cmd.exe 的命令行，输出用同一套解码。 */
function cmdReference(command: string, cwd: string) {
  const res = spawnSync(CMD_EXE, ['/d', '/s', '/c', `chcp 65001 >NUL & ${command}`], { cwd, windowsHide: true });
  return {
    stdout: decodeProcessOutput(res.stdout),
    stderr: decodeProcessOutput(res.stderr),
    exit: res.status ?? -1,
  };
}

/** 修改时间永远过期的 fs.stat，用来模拟读取之后被别人改过。 */
function staleEnv(env: HostEnv): HostEnv {
  const fs = {
    ...env.fs,
    stat: async (p: string) => ({ ...(await env.fs.stat(p)), mtimeMs: -1 }),
  };
  return Object.create(env, { fs: { value: fs } }) as HostEnv;
}

forEachTarget('M3 写与执行 Local/Remote 对照', (target) => {
  const linux = target === 'linux';
  let sb: Sandbox;
  let acceptor: Awaited<ReturnType<typeof startAcceptor>>;
  let conn: ExecutorConn;
  let remote: HostEnv;
  let repoLocal: string;
  let repoNative: string;
  let tasksHome: string;

  const norm = (text: string): string => {
    let out = text.replaceAll('\\', '/');
    for (const root of [repoLocal, repoNative]) out = out.split(root.replaceAll('\\', '/')).join('<ROOT>');
    return out;
  };

  beforeAll(async () => {
    sb = createSandbox(target);
    acceptor = await startAcceptor();
    startExecutor({ target, sandbox: sb, home: sb.home('home'), server: acceptor.url, token: acceptor.issueToken() });
    conn = await acceptor.nextConn();
    remote = await RemoteHostEnv.open(conn);
    repoLocal = sb.loc('repo');
    repoNative = sb.nat('repo');
    mkdirSync(repoLocal);
    tasksHome = mkdtempSync(path.join(os.tmpdir(), 'tandem-m3-tasks-'));
  }, 60_000);

  afterAll(async () => {
    conn?.close();
    await acceptor?.close();
    rmSync(tasksHome, { recursive: true, force: true });
    await runCleanups();
  });

  // ---------- Write / Edit ----------

  test('Write：中文目录与空格文件名，本机与远端结果与磁盘内容一致', async () => {
    const rel = path.join('中文 目录', '新 文件.txt');
    const content = '第一行\n第二行 with space\n';
    const l = await runWrite(
      { file_path: path.join(repoLocal, 'local', rel), content },
      ctxFor(localHostEnv, repoLocal),
    );
    const r = await runWrite(
      { file_path: remote.path.join(repoNative, 'remote', rel), content },
      ctxFor(remote, repoNative),
    );
    expect(l.isError).toBeFalsy();
    expect(r.isError).toBeFalsy();
    expect(norm(r.content)).toBe(norm(l.content).replace('/local/', '/remote/'));
    expect(readFileSync(path.join(repoLocal, 'remote', rel), 'utf8')).toBe(content);
    expect(readFileSync(path.join(repoLocal, 'local', rel), 'utf8')).toBe(content);
  });

  test('Write 覆盖已有文件：检查点拿到改写前的原文，新文件则为 undefined', async () => {
    const file = path.join(repoLocal, 'snap', 'old.txt');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '旧内容');
    const snaps: Array<{ p: string; before: Buffer | undefined }> = [];
    const ctx = ctxFor(remote, repoNative, {
      snapshot: (p: string, before: Buffer | undefined) => snaps.push({ p, before: before && Buffer.from(before) }),
    });
    const native = remote.path.join(repoNative, 'snap', 'old.txt');
    const res = await runWrite({ file_path: native, content: '新内容' }, ctx);
    const created = await runWrite({ file_path: remote.path.join(repoNative, 'snap', 'new.txt'), content: 'x' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(created.isError).toBeFalsy();
    expect(snaps[0].before?.toString('utf8')).toBe('旧内容');
    expect(snaps[1].before).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe('新内容');
  });

  test('Write 发现 mtime 与读取时不一致：返回冲突且不写入', async () => {
    const file = path.join(repoLocal, 'conflict.txt');
    writeFileSync(file, '原文');
    const env = staleEnv(remote);
    const res = await runWrite(
      { file_path: remote.path.join(repoNative, 'conflict.txt'), content: '覆盖' },
      ctxFor(env, repoNative),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('文件已被修改');
    expect(readFileSync(file, 'utf8')).toBe('原文');
  });

  test('Edit：唯一匹配替换、多处匹配与未找到的文案与本机一致', async () => {
    const text = '第一段 hello\n第二段 hello\n';
    for (const dir of ['local', 'remote']) mkdirSync(path.join(repoLocal, dir), { recursive: true });
    writeFileSync(path.join(repoLocal, 'local', 'e.txt'), '唯一 abc 结尾\n');
    writeFileSync(path.join(repoLocal, 'remote', 'e.txt'), '唯一 abc 结尾\n');
    writeFileSync(path.join(repoLocal, 'local', 'm.txt'), text);
    writeFileSync(path.join(repoLocal, 'remote', 'm.txt'), text);
    const cases: Array<Record<string, unknown>> = [
      { file_path: 'e.txt', old_string: 'abc', new_string: '中文 替换' },
      { file_path: 'm.txt', old_string: 'hello', new_string: 'hi' },
      { file_path: 'm.txt', old_string: 'missing', new_string: 'x' },
    ];
    for (const c of cases) {
      const l = await runEdit(
        { ...c, file_path: path.join(repoLocal, 'local', c.file_path as string) },
        ctxFor(localHostEnv, repoLocal),
      );
      const r = await runEdit(
        { ...c, file_path: remote.path.join(repoNative, 'remote', c.file_path as string) },
        ctxFor(remote, repoNative),
      );
      expect(r.isError === true).toBe(l.isError === true);
      expect(norm(r.content)).toBe(norm(l.content).replace('/local/', '/remote/'));
    }
    expect(readFileSync(path.join(repoLocal, 'remote', 'e.txt'), 'utf8')).toBe('唯一 中文 替换 结尾\n');
    expect(readFileSync(path.join(repoLocal, 'local', 'e.txt'), 'utf8')).toBe('唯一 中文 替换 结尾\n');
  });

  test('Edit 发现 mtime 与读取时不一致：返回冲突且不写入', async () => {
    const file = path.join(repoLocal, 'edit-conflict.txt');
    writeFileSync(file, 'keep me');
    const res = await runEdit(
      { file_path: remote.path.join(repoNative, 'edit-conflict.txt'), old_string: 'keep', new_string: 'drop' },
      ctxFor(staleEnv(remote), repoNative),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('文件已被修改');
    expect(readFileSync(file, 'utf8')).toBe('keep me');
  });

  (linux ? test : test.skip)('Write 写入符号链接：改写链接指向的文件，链接本身保留', async () => {
    const real = path.join(repoLocal, 'real.txt');
    const link = path.join(repoLocal, 'link.txt');
    writeFileSync(real, 'before');
    symlinkSync(real, link);
    const res = await runWrite({ file_path: path.join(repoNative, 'link.txt'), content: 'after' }, ctxFor(remote, repoNative));
    expect(res.isError).toBeFalsy();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('after');
  });

  // ---------- Bash ----------

  const CASES: Array<{ name: string; linux: string; windows: string }> = [
    { name: '标准输出、stderr 与退出码', linux: "printf 'out\\n'; printf 'err\\n' >&2; exit 3", windows: 'echo out & echo err 1>&2 & exit 3' },
    { name: '中文输出', linux: 'echo 中文', windows: 'echo 中文' },
    { name: '百分号原样输出', linux: 'echo 100%', windows: 'echo 100%' },
    { name: '管道与重定向', linux: 'echo a | grep a > out.txt && cat out.txt', windows: 'echo a|findstr a > out.txt & type out.txt' },
  ];

  for (const c of CASES) {
    test(`Bash ${c.name}：本机与远端输出一致`, async () => {
      const command = linux ? c.linux : c.windows;
      const r = await runBash({ command }, ctxFor(remote, repoNative));
      if (linux) {
        const l = await runBash({ command }, ctxFor(localHostEnv, repoLocal));
        expect(r.content).toBe(l.content);
        expect(r.isError === true).toBe(l.isError === true);
      } else {
        const ref = cmdReference(command, repoLocal);
        expect(r.content).toBe(formatResult(ref.stdout, ref.stderr, ref.exit));
        expect(r.isError === true).toBe(ref.exit !== 0);
      }
    });
  }

  // 非 ASCII 路径不能经 WSL 互操作作为 cmd 命令行参数传入（参数会被打乱），这里直接断言结果。
  test('Bash 中文与空格路径：创建、写入、读回', async () => {
    const command = linux
      ? 'mkdir -p "中文 目录" && echo hi > "中文 目录/x.txt" && cat "中文 目录/x.txt"'
      : 'if not exist "中文 目录" mkdir "中文 目录" & echo hi > "中文 目录\\x.txt" & type "中文 目录\\x.txt"';
    const r = await runBash({ command }, ctxFor(remote, repoNative));
    expect(r.content).toBe('hi');
    if (linux) expect((await runBash({ command }, ctxFor(localHostEnv, repoLocal))).content).toBe('hi');
  });

  (linux ? test : test.skip)('Bash 不继承 stdin：读取标准输入的命令立刻结束', async () => {
    const r = await runBash({ command: 'cat; echo done' }, ctxFor(remote, repoNative));
    expect(r.content).toBe('done');
  });

  (!linux ? test : test.skip)('Windows：%NAME% 展开、%% 与 %1 按命令行语义输出', async () => {
    for (const command of ['echo %USERNAME%', 'echo 50%%', 'echo %1 and %*']) {
      const r = await runBash({ command }, ctxFor(remote, repoNative));
      const ref = cmdReference(command, repoLocal);
      expect(r.content).toBe(formatResult(ref.stdout, ref.stderr, ref.exit));
    }
  });

  test('Bash 注入的 secrets 环境变量在远端生效', async () => {
    const name = 'M3_SECRET_VALUE';
    const command = linux ? `echo $${name}` : `echo %${name}%`;
    const r = await runBash({ command }, ctxFor(remote, repoNative, { secretEnv: { [name]: 'v-123' } }));
    expect(r.content).toBe('v-123');
  });

  test('Bash 超时：终止并标注，本机与远端一致', async () => {
    const command = linux ? 'sleep 30' : 'ping -n 30 127.0.0.1 >nul';
    const r = await runBash({ command, timeout: 1000 }, ctxFor(remote, repoNative));
    expect(r.content).toBe('(无输出)\n[命令超时（1000ms），已终止]');
    expect(r.isError).toBe(true);
    if (linux) {
      const l = await runBash({ command, timeout: 1000 }, ctxFor(localHostEnv, repoLocal));
      expect(l.content).toBe(r.content);
    }
  }, 30_000);

  test('用户中断：杀掉整棵进程树', async () => {
    const ac = new AbortController();
    if (linux) {
      const pidFile = path.join(repoLocal, 'pid.txt');
      const p = runBash(
        { command: 'sleep 60 & echo $! > pid.txt; wait' },
        ctxFor(remote, repoNative, { signal: ac.signal }),
      );
      const pid = Number(await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim(), 10_000, 'pid 文件'));
      ac.abort();
      expect((await p).content).toBe('用户中断');
      await waitUntil(() => !isAlive(pid), 5_000, 'sleep 进程已结束');
    } else {
      const marker = `TANDEM_M3_${Math.random().toString(16).slice(2, 10)}`;
      const count = () => {
        const script = `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const res = spawnSync(CMD_EXE, ['/d', '/s', '/c', `chcp 65001 >NUL & powershell -NoProfile -EncodedCommand ${encoded}`], { windowsHide: true });
        return Number(decodeProcessOutput(res.stdout).trim());
      };
      const p = runBash(
        { command: `powershell -NoProfile -Command "Start-Sleep -Seconds 60; echo ${marker}"` },
        ctxFor(remote, repoNative, { signal: ac.signal }),
      );
      await waitUntil(() => count() >= 1, 20_000, 'powershell 进程已启动');
      ac.abort();
      expect((await p).content).toBe('用户中断');
      await waitUntil(() => count() === 0, 20_000, 'powershell 进程树已结束');
    }
  }, 60_000);

  (linux ? test : test.skip)('沙箱（bwrap）：工作目录可写，目录外只读', async () => {
    const ctx = ctxFor(remote, repoNative, { sandbox: SANDBOX_PROFILE });
    const r = await runBash(
      { command: 'echo ok > inside.txt && (touch /usr/tandem-m3-denied 2>/dev/null; echo denied=$?)' },
      ctx,
    );
    expect(r.content).toBe('denied=1');
    expect(readFileSync(path.join(repoLocal, 'inside.txt'), 'utf8')).toBe('ok\n');
  });

  (linux ? test : test.skip)('沙箱不可用时不包装，并在输出开头提示', async () => {
    const noEngine = Object.create(remote, { sandboxEngine: { value: async () => undefined } }) as HostEnv;
    const r = await runBash({ command: 'echo plain' }, ctxFor(noEngine, repoNative, { sandbox: SANDBOX_PROFILE }));
    expect(r.content.startsWith('[未检测到 bwrap，本次命令未在沙箱中运行')).toBe(true);
    expect(r.content.endsWith('plain')).toBe(true);
  });

  // ---------- 后台任务 ----------

  test('后台任务：启动、读取增量输出、正常结束', async () => {
    const manager = new BackgroundTaskManager(tasksHome, () => {});
    const ctx = ctxFor(remote, repoNative, { backgroundTasks: manager });
    const started = await runBash(
      {
        command: linux ? 'echo bg-a; sleep 0.3; echo bg-b' : 'echo bg-a & ping -n 2 127.0.0.1 >nul & echo bg-b',
        run_in_background: true,
      },
      ctx,
    );
    const id = /ID: (\S+)/.exec(started.content)?.[1] ?? '';
    expect(id).not.toBe('');
    await waitUntil(() => manager.get(id)?.status !== 'running' && manager.get(id), 20_000, '后台任务结束');
    const read = await runBashOutput({ bash_id: id }, ctx);
    expect(read.content).toContain('bg-a');
    expect(read.content).toContain('bg-b');
    expect(read.content).toContain('已结束（退出码 0）');
    manager.dispose();
  }, 30_000);

  test('后台任务：KillBash 杀掉远端进程', async () => {
    const manager = new BackgroundTaskManager(tasksHome, () => {});
    const ctx = ctxFor(remote, repoNative, { backgroundTasks: manager });
    const started = await runBash(
      { command: linux ? 'sleep 60' : 'ping -n 60 127.0.0.1 >nul', run_in_background: true },
      ctx,
    );
    const id = /ID: (\S+)/.exec(started.content)?.[1] ?? '';
    const killed = await runKillBash({ shell_id: id }, ctx);
    expect(killed.content).toBe(`已终止后台任务 ${id}（状态：killed）`);
    await waitUntil(() => manager.get(id)?.endedAt, 10_000, '后台任务结束');
    manager.dispose();
  }, 30_000);

  test('审批标记：Write、Edit、Bash 仍需审批，BashOutput、KillBash 不需要', () => {
    expect(writeDef.requiresApproval).toBe(true);
    expect(editDef.requiresApproval).toBe(true);
    expect(bashDef.requiresApproval).toBe(true);
    expect(bashOutputDef.requiresApproval).toBe(false);
    expect(killBashDef.requiresApproval).toBe(false);
  });

  test('执行器断线：后台任务结束并标注，不做断线续跑', async () => {
    const manager = new BackgroundTaskManager(tasksHome, () => {});
    const ctx = ctxFor(remote, repoNative, { backgroundTasks: manager });
    const started = await runBash(
      { command: linux ? 'sleep 60' : 'ping -n 60 127.0.0.1 >nul', run_in_background: true },
      ctx,
    );
    const id = /ID: (\S+)/.exec(started.content)?.[1] ?? '';
    conn.close();
    await waitUntil(() => manager.get(id)?.status !== 'running' && manager.get(id), 10_000, '断线后任务结束');
    const task = manager.get(id)!;
    expect(task.status).toBe('exited');
    expect(task.exitCode).toBe(-1);
    const read = await runBashOutput({ bash_id: id }, ctx);
    expect(read.content).toContain('执行失败');
    expect(read.content).toContain('执行器连接已断开');
    manager.dispose();
  }, 30_000);
});

// Windows 临时目录含空格与非 ASCII（模拟「用户名含空格」的 %TEMP%）：.cmd 文件建在这里；另有超长的工作目录。
describe.skipIf(!WINDOWS_AVAILABLE)('M3 Windows .cmd：临时目录含空格与非 ASCII、超长工作目录', () => {
  let sb: Sandbox;
  let acceptor: Awaited<ReturnType<typeof startAcceptor>>;
  let conn: ExecutorConn;
  let remote: HostEnv;
  let tempLocal: string;
  let longLocal: string;
  let longNative: string;

  beforeAll(async () => {
    sb = createSandbox('windows');
    tempLocal = sb.loc('Temp With Space 中文');
    mkdirSync(tempLocal);
    const tempNative = execFileSync('wslpath', ['-w', tempLocal], { encoding: 'utf8' }).trim();
    acceptor = await startAcceptor();
    startExecutor({
      target: 'windows',
      sandbox: sb,
      home: sb.home('home'),
      server: acceptor.url,
      token: acceptor.issueToken(),
      env: { TEMP: tempNative, TMP: tempNative },
    });
    conn = await acceptor.nextConn();
    remote = await RemoteHostEnv.open(conn);
    const segs = Array.from({ length: 3 }, (_, i) => `long-segment-${'x'.repeat(36)}-${i}`);
    longLocal = sb.loc('repo', ...segs);
    longNative = sb.nat('repo', ...segs);
    mkdirSync(longLocal, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    conn?.close();
    await acceptor?.close();
    await runCleanups();
  });

  test('临时目录含空格与中文：.cmd 建在该目录并执行，退出码与输出正确', async () => {
    const r = await runBash({ command: 'echo a & exit 2' }, ctxFor(remote, sb.nat('repo')));
    expect(r.content).toBe('a\n[退出码: 2]');
    expect(r.isError).toBe(true);
    expect(readdirLeftovers(tempLocal)).toEqual([]);
  });

  // CreateProcess 的当前目录上限是 MAX_PATH（260），超过时本机与远端都无法启动，这里取接近上限的长度。
  test('超长工作目录（接近 MAX_PATH）：写文件、重定向与读回', async () => {
    expect(longNative.length).toBeGreaterThan(200);
    expect(longNative.length).toBeLessThan(260);
    const r = await runBash({ command: 'echo long > f.txt & type f.txt' }, ctxFor(remote, longNative));
    expect(r.content).toBe('long');
    expect(readFileSync(path.join(longLocal, 'f.txt'), 'utf8').trim()).toBe('long');
  });
});

function readdirLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.cmd'));
}
