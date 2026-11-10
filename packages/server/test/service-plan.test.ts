// 开机自启计划：三平台内容、路径转义、命令与令牌脱敏（不执行任何命令）。
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildServicePlan, redactToken } from '../src/service/install.js';

const base = {
  nodePath: '/opt/Tandem Node/bin/node',
  cliPath: '/home/张三/Tandem 数据/app/dist/cli.js',
  home: '/home/张三/Tandem 数据/home',
  logFile: '/home/张三/Tandem 数据/home/host.log',
  userHome: '/home/张三',
};

test('Linux：systemd --user 单元（随机回环端口）、重启策略与命令', () => {
  const plan = buildServicePlan({ ...base, platform: 'linux' });
  assert.equal(plan.files.length, 1);
  const unit = plan.files[0]!;
  assert.ok(unit.path.endsWith(path.join('.config', 'systemd', 'user', 'tandem-host.service')));
  const text = unit.content;
  assert.match(text, /Restart=always/);
  assert.match(text, /RestartSec=5/);
  assert.match(text, /Environment="TANDEM_HOME=\/home\/张三\/Tandem 数据\/home"/);
  assert.match(text, /ExecStart="\/opt\/Tandem Node\/bin\/node" "\/home\/张三\/Tandem 数据\/app\/dist\/cli\.js" --port 0 --host 127\.0\.0\.1/);
  assert.match(text, /WantedBy=default\.target/);
  assert.match(text, /StandardOutput="append:\/home\/张三\/Tandem 数据\/home\/host\.log"/);
  const cmds = plan.commands.map((step) => [step.cmd, ...step.args].join(' '));
  assert.deepEqual(cmds.slice(0, 2), ['systemctl --user daemon-reload', 'systemctl --user enable tandem-host']);
  assert.ok(cmds.includes('loginctl enable-linger'));
  assert.equal(plan.commands.find((step) => step.cmd === 'loginctl')?.optional, true, '登录 linger 应尽力而为');
  assert.match(plan.note ?? '', /systemd --user/);
});

test('macOS：LaunchAgent plist（RunAtLoad/KeepAlive/日志），写文件即可，不立即加载', () => {
  const plan = buildServicePlan({ ...base, platform: 'darwin', userHome: '/Users/张 三' });
  assert.equal(plan.files.length, 1);
  const plist = plan.files[0]!;
  assert.ok(plist.path.startsWith(path.join('/Users/张 三', 'Library', 'LaunchAgents')));
  assert.match(plist.content, /<string>dev\.tandem\.host<\/string>/);
  assert.match(plist.content, /<string>--port<\/string>\s*\n\s*<string>0<\/string>/);
  assert.match(plist.content, /<key>RunAtLoad<\/key>\s*\n\s*<true\/>/);
  assert.match(plist.content, /<key>KeepAlive<\/key>\s*\n\s*<true\/>/);
  assert.match(plist.content, /<key>TANDEM_HOME<\/key>/);
  assert.deepEqual(plan.commands, [], '不在安装时 launchctl 加载，下次登录由 launchd 加载');
});

test('Windows：启动项脚本（隐藏窗口、UTF-8、崩溃重启）与 HKCU 启动项', () => {
  const plan = buildServicePlan({
    ...base,
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\Users\\张 三\\Tandem\\app\\dist\\cli.js',
    home: 'C:\\Users\\张 三\\Tandem 数据',
    logFile: 'C:\\Users\\张 三\\Tandem 数据\\host.log',
    userHome: 'C:\\Users\\张 三',
    localAppData: 'C:\\Users\\张 三\\AppData\\Local',
  });
  assert.equal(plan.files.length, 2);
  const cmdFile = plan.files.find((file) => file.path.endsWith('tandem-host-run.cmd'))!;
  const vbsFile = plan.files.find((file) => file.path.endsWith('tandem-host-run.vbs'))!;
  assert.ok(cmdFile.path.startsWith('C:\\Users\\张 三\\AppData\\Local\\Tandem'));
  assert.match(cmdFile.content, /set "TANDEM_HOME=C:\\Users\\张 三\\Tandem 数据"/);
  assert.match(cmdFile.content, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\张 三\\Tandem\\app\\dist\\cli\.js" --port 0 --host 127\.0\.0\.1/);
  assert.match(cmdFile.content, /^@echo off\r\nchcp 65001 >nul\r\n/, '中文路径需要 UTF-8 代码页');
  assert.match(cmdFile.content, /:run/);
  assert.match(cmdFile.content, /goto run/);
  assert.match(cmdFile.content, /ping -n 6 127\.0\.0\.1 >nul/, '崩溃后 5 秒重启（不受输入重定向影响）');
  assert.equal(vbsFile.encoding, 'utf16le', 'VBS 需 UTF-16LE 才能读中文路径');
  assert.ok(vbsFile.content.startsWith('\ufeff'), 'VBS 需 BOM');
  assert.match(cmdFile.content, />> "C:\\Users\\张 三\\Tandem 数据\\host\.log" 2>&1/);
  // 0 = 隐藏窗口（wscript 启动时不出黑框）
  assert.match(vbsFile.content, /sh\.Run """C:\\Users\\张 三\\AppData\\Local\\Tandem\\tandem-host-run\.cmd""", 0, False/);
  const cmds = plan.commands.map((step) => [step.cmd, ...step.args].join(' '));
  assert.equal(plan.commands.length, 1);
  // Windows 11 非管理员会话里 schtasks /SC ONLOGON 会「拒绝访问」，改用 HKCU 启动项（登录自启、无需管理员）。
  assert.ok(cmds[0]!.startsWith('reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v TandemHost'));
  assert.ok(cmds[0]!.includes('wscript.exe //B "C:\\Users\\张 三\\AppData\\Local\\Tandem\\tandem-host-run.vbs"'));
});

test('XML 转义与令牌脱敏', () => {
  const plan = buildServicePlan({ ...base, platform: 'darwin', userHome: '/Users/a&b', home: '/Users/a&b/<tandem>' });
  assert.ok(!plan.files[0]!.content.includes('<tandem>'));
  assert.ok(plan.files[0]!.content.includes('/Users/a&amp;b/&lt;tandem&gt;'));
  assert.equal(redactToken('绑定码 ach_abcdefghijklmnop 已使用'), '绑定码 ach_**** 已使用');
  assert.equal(redactToken('acw_token123456'), 'acw_****');
  assert.equal(redactToken('没有令牌'), '没有令牌');
  assert.ok(!redactToken('ach_abcdefghijkl').includes('abcdef'));
});
