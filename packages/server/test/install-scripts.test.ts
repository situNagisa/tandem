// 安装脚本模板：默认地址替换、不含令牌、sh 语法、PowerShell param 块。
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
  assert.ok(script.includes('--no-service'));
  assert.ok(script.includes('exec "$NODE_BIN" "$APP/dist/cli.js" "\\$@"'), '启动包装在写入时展开绝对路径、保留 "$@"');
  assert.ok(script.includes('join "$SERVER" --token "$TOKEN"'), 'join 由工作站地址 + 运行时令牌组成');
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

test('install.ps1：param 块、默认地址、下载/解压方式', () => {
  const script = buildWindowsInstallScript({ server: 'http://10.1.2.3:8481' });
  assert.match(script, /param\(/);
  for (const fragment of ['[string]$Token', '[string]$Server', '[string]$Name', '[switch]$NoService', '[switch]$DryRun', '[int]$Port']) {
    assert.ok(script.includes(fragment), `缺少参数 ${fragment}`);
  }
  assert.ok(script.includes("$DefaultServer = 'http://10.1.2.3:8481'"));
  assert.ok(script.includes('$env:TANDEM_TOKEN'));
  assert.ok(script.includes('Invoke-WebRequest'));
  assert.ok(script.includes('/dl/tandem-host.zip'), 'Windows 下载 ZIP 安装包');
  assert.ok(script.includes('Expand-Archive'), 'Windows 用 Expand-Archive 解压（不依赖 tar）');
  assert.ok(!/tar -[a-z]*x/.test(script), 'Windows 脚本不能再调用 tar（中文路径会失败）');
  assert.ok(!/\bexit\s+\d/.test(script), '一行命令在用户 PowerShell 会话里执行，不能用 exit 关掉窗口');
  assert.match(script, /手动安装步骤：/);
  assert.match(script, /dist\\cli\.js/);
  assert.ok(script.includes('--no-service'));
  assert.ok(script.includes('--service'));
  assert.ok(!script.includes('ach_abcdefgh'), '脚本不能嵌入具体令牌');
  assert.ok(!/[A-Za-z0-9_-]*ach_[A-Za-z0-9_-]{16,}/.test(script));
  assert.match(script, /Node\.js 22/);
  assert.match(script, /winget install --id OpenJS\.NodeJS\.LTS/, '没有合适 Node 时给出 winget 命令让用户自己装');
});

test('install.ps1：登记失败分三类（崩溃/令牌/网络），并写 install.log', () => {
  const script = buildWindowsInstallScript({ server: 'http://10.1.2.3:8481' });
  // 崩溃：负退出码（STATUS_* / 0xC0000409）单独提示，不能说成绑定码过期
  assert.match(script, /\$code -lt 0/, '负退出码按崩溃处理');
  assert.match(script, /0x\{0:X8\}/, '打印十六进制退出码，便于对照 STATUS_STACK_BUFFER_OVERRUN');
  assert.match(script, /异常崩溃，不是绑定码的问题/);
  assert.match(script, /Select-Object -Last 20/, '崩溃时打印 tandem-host 最后 20 行输出');
  // 令牌 / 网络各自提示
  assert.match(script, /\$joined -match '绑定码'/);
  assert.match(script, /连不上工作站/);
  // 日志路径与内容
  assert.match(script, /JoinLogFile = Join-Path \$InstallDir 'install\.log'/);
  assert.match(script, /Add-Content -LiteralPath \$JoinLogFile/);
  assert.match(script, /令牌:   \$\(Mask-Token \$Token\)/, '日志里令牌脱敏');
  // 输出要逐行收下来：崩溃时控制台缓冲会丢
  assert.match(script, /\$joinLines\.Add/);
  assert.match(script, /& \$NodePath @joinArgs \*>&1/);
  assert.match(script, /\[Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\)/, 'node 输出是 UTF-8，PowerShell 默认代码页会乱码');
  assert.match(script, /使用 Node: \$NodePath/, '打印实际使用的 node 路径与版本');
});

test('install.sh：崩溃（>=128）与普通失败分开提示', () => {
  const script = buildUnixInstallScript({ server: 'http://10.1.2.3:8481' });
  assert.match(script, /\[ "\$status" -ge 128 \]/);
  assert.match(script, /被信号终止（崩溃）/);
  assert.match(script, /日志：\$LOG_FILE/);
});
