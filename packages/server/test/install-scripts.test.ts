// 执行器安装脚本模板：默认地址替换、digests 嵌入、不含令牌、sh 语法、前台 join、--service 可选、PowerShell param 块。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildUnixInstallScript, buildWindowsInstallScript } from '../src/workstation/installScripts.js';

const DIGESTS: Record<string, string> = {
  'linux-amd64': 'a1'.repeat(32),
  'linux-arm64': 'b2'.repeat(32),
  'darwin-amd64': 'c3'.repeat(32),
  'darwin-arm64': 'd4'.repeat(32),
  'windows-amd64': 'e5'.repeat(32),
};

test('install.sh：默认地址取自工作站、嵌入各平台 sha256、不含令牌、sh -n 通过', () => {
  const script = buildUnixInstallScript({ server: 'http://10.1.2.3:8481/', digests: DIGESTS });
  assert.ok(script.startsWith('#!/bin/sh'));
  assert.ok(script.includes("SERVER='http://10.1.2.3:8481'"), '地址应去掉尾部斜杠并写入脚本');
  for (const target of ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64']) {
    assert.ok(script.includes(`${target}) printf`), `缺少 ${target} 的目标映射`);
    assert.ok(script.includes(DIGESTS[target]!), `${target} 的 sha256 应嵌入脚本`);
  }
  assert.ok(script.includes('/executor/$TARGET'), '下载地址是 <工作站>/executor/<target>');
  assert.ok(!script.includes('ach_abcdefgh'), '脚本不能嵌入具体令牌');
  assert.ok(!/[A-Za-z0-9_-]*ach_[A-Za-z0-9_-]{16,}/.test(script), '不应出现看起来像真实令牌的字符串');
  assert.match(script, /--dry-run/);
  assert.match(script, /--service/);
  assert.match(script, /sha256sum[\s\S]*shasum[\s\S]*openssl/, '校验工具依次回落');

  if (process.platform !== 'win32') {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tandem-install-sh-'));
    const file = path.join(dir, 'install.sh');
    try {
      writeFileSync(file, script);
      execFileSync('sh', ['-n', file], { stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('install.sh：前台运行 join，装到 ~/.tandem-executor/bin，--service 才设置开机自启', () => {
  const script = buildUnixInstallScript({ server: 'http://10.1.2.3:8481', digests: DIGESTS });
  assert.ok(script.includes('INSTALL_HOME="${HOME:-}/.tandem-executor"'));
  assert.ok(script.includes('BIN="$INSTALL_HOME/bin/tandem-exec"'));
  assert.ok(script.includes('set -- join --server "$SERVER" --token "$TOKEN"'), 'join 由工作站地址 + 运行时令牌组成');
  assert.ok(script.includes('set -- "$@" --service'));
  assert.ok(script.includes('"$BIN" "$@"'), '前台运行下载好的执行器');
  assert.ok(script.includes('mv "$BIN" "$BIN.old"'), '已有文件先改名挪开');
  assert.ok(script.includes('chmod 755 "$BIN"'));
});

test('install.sh --dry-run：只打印计划，不下载不改动', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-install-dry-'));
  const file = path.join(home, 'install.sh');
  try {
    writeFileSync(file, buildUnixInstallScript({ server: 'http://10.1.2.3:8481', digests: DIGESTS }));
    const out = execFileSync('sh', [file, '--dry-run', '--token', 'ach_0123456789abcdef'], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.match(out, /--dry-run/);
    assert.match(out, /安装路径: .*\.tandem-executor\/bin\/tandem-exec/);
    assert.match(out, /ach_\*\*\*\*/, '计划里令牌要脱敏');
    assert.ok(!out.includes('0123456789abcdef'));
    assert.ok(out.includes('/executor/'), '计划里列出下载地址');
    const hostTarget = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
    assert.ok(out.includes(DIGESTS[hostTarget]!.slice(0, 12)), '计划里列出 sha256 前 12 位');
    assert.ok(!out.includes('--service'), '默认不设置开机自启');
    assert.match(out, /不设置开机自启/);
    const withService = execFileSync('sh', [file, '--dry-run', '--token', 'ach_0123456789abcdef', '--service'], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.match(withService, /设置开机自启（下次登录后自动连接）/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install.ps1：param 块、默认地址、下载/校验方式、前台 join', () => {
  const script = buildWindowsInstallScript({ server: 'http://10.1.2.3:8481', digests: DIGESTS });
  assert.match(script, /param\(/);
  for (const fragment of ['[string]$Token', '[string]$Server', '[switch]$Service', '[switch]$DryRun']) {
    assert.ok(script.includes(fragment), `缺少参数 ${fragment}`);
  }
  assert.ok(script.includes("$DefaultServer = 'http://10.1.2.3:8481'"));
  assert.ok(script.includes('$env:TANDEM_TOKEN'));
  assert.ok(script.includes('$env:TANDEM_SERVER'));
  assert.match(script, /Net\.SecurityProtocolType\]::Tls12/, '启用 TLS 1.2');
  assert.ok(script.includes('Invoke-WebRequest'));
  assert.ok(script.includes('/executor/$Target'));
  assert.ok(script.includes("$Target = 'windows-amd64'"));
  assert.ok(script.includes(DIGESTS['windows-amd64']!), 'Windows 执行器的 sha256 应嵌入脚本');
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.ok(script.includes('Join-Path $HOME'), '安装到用户目录');
  assert.match(script, /\$JoinArgs = @\('join', '--server', \$Server, '--token', \$Token\)/);
  assert.match(script, /if \(\$Service\) \{ \$JoinArgs \+= '--service' \}/);
  assert.ok(!/\bexit\s+\d/.test(script), '一行命令在用户 PowerShell 会话里执行，不能用 exit 关掉窗口');
  assert.ok(!script.includes('ach_abcdefgh'), '脚本不能嵌入具体令牌');
  assert.ok(!/[A-Za-z0-9_-]*ach_[A-Za-z0-9_-]{16,}/.test(script));
});
