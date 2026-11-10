// 安装脚本模板：默认地址替换、不含令牌、sh 语法、前台 join、--service 可选、PowerShell param 块。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildUnixInstallScript, buildWindowsInstallScript } from '../src/workstation/installScripts.js';

test('install.sh：默认地址取自工作站、不含令牌、sh -n 通过', () => {
  const script = buildUnixInstallScript({ server: 'http://10.1.2.3:8481/' });
  assert.ok(script.startsWith('#!/bin/sh'));
  assert.ok(script.includes("SERVER='http://10.1.2.3:8481'"), '地址应去掉尾部斜杠并写入脚本');
  assert.ok(script.includes('/dl/tandem-host.tgz'));
  assert.ok(script.includes('exec "$NODE_BIN" "$APP/dist/cli.js" "\\$@"'), '启动包装在写入时展开绝对路径、保留 "$@"');
  assert.ok(!script.includes('ach_abcdefgh'), '脚本不能嵌入具体令牌');
  assert.ok(!/[A-Za-z0-9_-]*ach_[A-Za-z0-9_-]{16,}/.test(script), '不应出现看起来像真实令牌的字符串');
  assert.match(script, /Node\.js 22/);
  assert.match(script, /--dry-run/);

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

test('install.sh：前台运行 join，数据目录独立，--service 才设置开机自启', () => {
  const script = buildUnixInstallScript({ server: 'http://10.1.2.3:8481' });
  assert.ok(script.includes('TANDEM_HOME="$DATA" "$NODE_BIN" "$APP/dist/cli.js" "$@"'), '前台运行时数据目录固定为安装目录下的 data');
  assert.ok(script.includes('DATA="$INSTALL_DIR/data"'));
  assert.ok(script.includes('set -- join "$SERVER" --token "$TOKEN" --name "$NAME"'), 'join 由工作站地址 + 运行时令牌组成');
  assert.ok(script.includes('set -- "$@" --service'));
});

test('install.sh --dry-run：只打印计划，不下载不改动', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-install-dry-'));
  const file = path.join(home, 'install.sh');
  try {
    writeFileSync(file, buildUnixInstallScript({ server: 'http://10.1.2.3:8481' }));
    const out = execFileSync('sh', [file, '--dry-run', '--token', 'ach_0123456789abcdef', '--name', 'box'], {
      env: { ...process.env, HOME: home, TANDEM_INSTALL_DIR: path.join(home, 'inst') },
      encoding: 'utf8',
    });
    assert.match(out, /--dry-run/);
    assert.match(out, /数据目录: .*data/);
    assert.match(out, /ach_\*\*\*\*/, '计划里令牌要脱敏');
    assert.ok(!out.includes('0123456789abcdef'));
    assert.ok(!out.includes('--service'), '默认不设置开机自启');
    const withService = execFileSync('sh', [file, '--dry-run', '--token', 'ach_0123456789abcdef', '--service'], {
      env: { ...process.env, HOME: home, TANDEM_INSTALL_DIR: path.join(home, 'inst') },
      encoding: 'utf8',
    });
    assert.match(withService, /--service/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install.ps1：param 块、默认地址、下载/解压方式、前台 join', () => {
  const script = buildWindowsInstallScript({ server: 'http://10.1.2.3:8481' });
  assert.match(script, /param\(/);
  for (const fragment of ['[string]$Token', '[string]$Server', '[string]$Name', '[switch]$Service', '[switch]$DryRun']) {
    assert.ok(script.includes(fragment), `缺少参数 ${fragment}`);
  }
  assert.ok(script.includes("$DefaultServer = 'http://10.1.2.3:8481'"));
  assert.ok(script.includes('$env:TANDEM_TOKEN'));
  assert.ok(script.includes('Invoke-WebRequest'));
  assert.ok(script.includes('/dl/tandem-host.zip'), 'Windows 下载 ZIP 安装包');
  assert.ok(script.includes('Expand-Archive'), 'Windows 用 Expand-Archive 解压（不依赖 tar）');
  assert.ok(!/tar -[a-z]*x/.test(script), 'Windows 脚本不能再调用 tar（中文路径会失败）');
  assert.ok(!/\bexit\s+\d/.test(script), '一行命令在用户 PowerShell 会话里执行，不能用 exit 关掉窗口');
  assert.match(script, /\$CliPath = Join-Path \$AppDir 'dist\\cli\.js'/);
  assert.match(script, /'join', \$Server, '--token', \$Token/);
  assert.match(script, /if \(\$Service\) \{ \$joinArgs \+= '--service' \}/);
  assert.match(script, /\$env:TANDEM_HOME = \$DataDir/, '数据目录只在前台进程期间设置，结束后还原');
  assert.match(script, /\$env:TANDEM_HOME = \$previousHome/);
  assert.match(script, /Node\.js 22/);
  assert.match(script, /winget install --id OpenJS\.NodeJS\.LTS/);
  assert.ok(!script.includes('ach_abcdefgh'), '脚本不能嵌入具体令牌');
  assert.ok(!/[A-Za-z0-9_-]*ach_[A-Za-z0-9_-]{16,}/.test(script));
});

test('install.ps1：node 输出按 UTF-8 显示', () => {
  const script = buildWindowsInstallScript({ server: 'http://10.1.2.3:8481' });
  assert.match(script, /\[Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\)/, 'node 输出是 UTF-8，PowerShell 默认代码页会乱码');
});
