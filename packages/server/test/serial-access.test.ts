import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifySerialAccessError,
  isBuiltinSerialPort,
  probeSerialPath,
  serialAccessFix,
} from '../src/devices/serialAccess.js';

test('板载串口识别：ttyS/ttyAMA 折叠，USB 串口与 COM 口不折叠', () => {
  assert.equal(isBuiltinSerialPort('/dev/ttyS0'), true);
  assert.equal(isBuiltinSerialPort('/dev/ttyS31'), true);
  assert.equal(isBuiltinSerialPort('/dev/ttyAMA0'), true);
  assert.equal(isBuiltinSerialPort('mock://ttyS2'), true);
  assert.equal(isBuiltinSerialPort('/dev/ttyUSB0'), false);
  assert.equal(isBuiltinSerialPort('/dev/ttyACM0'), false);
  assert.equal(isBuiltinSerialPort('/dev/tty.usbserial-1410'), false);
  assert.equal(isBuiltinSerialPort('COM3'), false);
  assert.equal(isBuiltinSerialPort('/dev/serial/by-id/usb-FTDI'), false);
});

test('Linux 权限不足：归为无权限，给 dialout 组与 chmod 命令', () => {
  const access = classifySerialAccessError(
    Object.assign(new Error('Error: Permission denied, cannot open /dev/ttyUSB0'), { code: 'EACCES' }),
    'linux',
    '/dev/ttyUSB0',
  );
  assert.equal(access.state, 'denied');
  assert.ok(access.commands?.includes('sudo usermod -aG dialout $USER'));
  assert.ok(access.commands?.includes('sudo chmod a+rw /dev/ttyUSB0'));
  assert.ok(access.commands?.some((command) => command.includes('/etc/udev/rules.d/99-tandem-serial.rules')));
  assert.match(access.fix ?? '', /重新登录/);
});

test('Linux 用 uucp 组时命令跟着换组名', () => {
  const fix = serialAccessFix('linux', '/dev/ttyUSB1', 'uucp');
  assert.deepEqual(fix.commands?.[0], 'sudo usermod -aG uucp $USER');
});

test('Windows 的 Access denied 是被占用而不是权限', () => {
  const access = classifySerialAccessError(
    Object.assign(new Error('Opening COM5: Access denied'), { code: 'EACCES' }),
    'win32',
    'COM5',
  );
  assert.equal(access.state, 'occupied');
  assert.deepEqual(access.commands, []);
  assert.match(access.fix ?? '', /关闭占用/);
});

test('EBUSY / 正在使用：归为被占用，带上占用进程', () => {
  const access = classifySerialAccessError(
    Object.assign(new Error('Device or resource busy'), { code: 'EBUSY' }),
    'linux',
    '/dev/ttyUSB0',
    'minicom (pid 4242)',
  );
  assert.equal(access.state, 'occupied');
  assert.equal(access.holder, 'minicom (pid 4242)');
  assert.match(access.reason ?? '', /minicom/);
  assert.deepEqual(access.commands, ['sudo fuser -v /dev/ttyUSB0']);
});

test('macOS 权限不足：只给 chmod，不误导成 dialout', () => {
  const access = classifySerialAccessError(
    Object.assign(new Error('Permission denied'), { code: 'EPERM' }),
    'darwin',
    '/dev/tty.usbserial-1410',
  );
  assert.equal(access.state, 'denied');
  assert.deepEqual(access.commands, ['sudo chmod a+rw /dev/tty.usbserial-1410']);
});

test('未知错误不误判成权限问题', () => {
  const access = classifySerialAccessError({ message: 'boom' }, 'linux', '/dev/ttyUSB0');
  assert.equal(access.state, 'unknown');
});

test('只读探测：不可读写时返回无权限，放开后恢复可访问', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root 不受文件权限限制');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'tandem-serial-access-'));
  const port = path.join(dir, 'ttyUSB9');
  try {
    writeFileSync(port, '');
    chmodSync(port, 0o000);
    const denied = probeSerialPath(port, 'linux');
    assert.equal(denied.state, 'denied');
    assert.ok(denied.commands?.some((command) => command.includes(port)));
    chmodSync(port, 0o600);
    assert.equal(probeSerialPath(port, 'linux').state, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('虚拟串口与 Windows 列表阶段不打开端口', () => {
  assert.equal(probeSerialPath('mock://ttyUSB0', 'linux').state, 'ok');
  assert.equal(probeSerialPath('COM3', 'win32').state, 'unknown');
});
