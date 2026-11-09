// 串口权限与占用检测：列表阶段只做只读探测（不打开端口），
// 深度检测（用户点「重新检测」）才短暂打开端口，避免每次刷新重置设备 DTR。
import { accessSync, constants, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { DeviceAccess } from '@tandem/protocol';

type Platform = NodeJS.Platform;

const BUILTIN_RE = /^ttyS\d+$|^tty(?:AMA|PS|MSM|SAC|XR)\d+$|^tty\d+$/;

/** 板载/虚拟串口（Linux 的 /dev/ttyS0 等），默认折叠。COM 口与 USB 串口不算。 */
export function isBuiltinSerialPort(portPath: string): boolean {
  const raw = portPath.trim().replace(/\\/g, '/');
  const mock = raw.startsWith('mock://');
  if (!mock && !raw.startsWith('/dev/')) return false;
  const bare = mock ? raw.slice('mock://'.length) : raw.slice('/dev/'.length);
  return BUILTIN_RE.test(bare);
}

function groupName(gid: number): string | undefined {
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const parts = line.split(':');
      if (Number(parts[2]) === gid && parts[0]) return parts[0];
    }
  } catch {
    // 没有 /etc/group：只能给通用说明
  }
  return undefined;
}

function inGroup(gid: number): boolean {
  if (typeof process.getgroups !== 'function') return true;
  const groups = process.getgroups();
  return groups.includes(gid) || process.getegid?.() === gid;
}

/** 权限修复说明与命令；Windows/macOS/Linux 各自给出平台化的做法。 */
export function serialAccessFix(
  platform: Platform,
  portPath: string,
  group?: string,
): Pick<DeviceAccess, 'fix' | 'commands'> {
  if (platform === 'win32') {
    return {
      fix: 'Windows 上打不开 COM 口几乎都是被其他程序占用。关闭串口监视器、Arduino IDE、另一个终端后重新检测。',
      commands: [],
    };
  }
  if (platform === 'darwin') {
    return {
      fix: 'macOS 一般不需要额外权限；打开失败多半是端口被其他程序占用。仍被拒绝时可以临时放开该端口的权限。',
      commands: [`sudo chmod a+rw ${portPath}`],
    };
  }
  const g = group && group !== 'root' ? group : 'dialout';
  const arch = g === 'uucp' ? '' : '（Arch 用 uucp 组：sudo usermod -aG uucp $USER）';
  // udev 规则按端口家族给（板载 ttyS 与 USB 串口内核名不同）。
  const kernel = /ttyS\d+$/.test(portPath) ? 'ttyS*' : 'ttyUSB*';
  return {
    fix: `把当前用户加入串口组后重新登录；或临时放开该端口；或用 udev 规则让设备插入时自动放开。${arch}`,
    commands: [
      `sudo usermod -aG ${g} $USER`,
      `sudo chmod a+rw ${portPath}`,
      `echo 'KERNEL=="${kernel}", GROUP="${g}", MODE="0660"' | sudo tee /etc/udev/rules.d/99-tandem-serial.rules`,
      'sudo udevadm control --reload-rules && sudo udevadm trigger',
    ],
  };
}

/** 把打开端口的异常归一成「无权限 / 被占用 / 未知」，并附带该平台的修复命令。 */
export function classifySerialAccessError(
  err: { code?: string; message?: string },
  platform: Platform,
  portPath: string,
  holder?: string,
): DeviceAccess {
  const code = (err.code ?? '').toUpperCase();
  const message = err.message ?? '';
  if (code === 'EACCES' || code === 'EPERM' || /permission denied|access denied|没有权限|权限不足/i.test(message)) {
    // Windows 打开 COM 口返回 Access denied 通常是独占占用，不是组权限问题。
    if (platform === 'win32') return occupiedAccess(platform, portPath, holder);
    return { state: 'denied', reason: '当前用户没有该串口的读写权限', ...serialAccessFix(platform, portPath) };
  }
  if (code === 'EBUSY' || /ebusy|resource busy|cannot lock|already open|被占用|正在使用/i.test(message)) {
    return occupiedAccess(platform, portPath, holder);
  }
  if (code === 'ENOENT' || code === 'ENODEV' || /no such file|不存在/i.test(message)) {
    return { state: 'unknown', reason: '端口不存在或已拔出' };
  }
  return { state: 'unknown', reason: message.slice(0, 160) || '无法判断端口状态' };
}

export function occupiedAccess(platform: Platform, portPath: string, holder?: string): DeviceAccess {
  return {
    state: 'occupied',
    reason: holder ? `被 ${holder} 占用` : '端口被其他程序占用',
    fix:
      platform === 'win32'
        ? '关闭占用该 COM 口的程序（串口监视器、Arduino IDE、另一个终端）后重新检测。'
        : '关闭占用该串口的程序后重新检测；下面的命令可以查看占用进程。',
    commands:
      platform === 'win32'
        ? []
        : platform === 'darwin'
          ? [`lsof ${portPath}`]
          : [`sudo fuser -v ${portPath}`],
    ...(holder ? { holder } : {}),
  };
}

/** 只读探测：不打开端口，因此不会重置 DTR / 打断正在通信的设备。 */
export function probeSerialPath(portPath: string, platform: Platform = process.platform): DeviceAccess {
  const mock = portPath.startsWith('mock://');
  if (mock) return { state: 'ok' };
  if (platform === 'win32') return { state: 'unknown' };
  try {
    accessSync(portPath, constants.R_OK | constants.W_OK);
    return { state: 'ok' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'unknown', reason: '端口不存在或已拔出' };
    if (code === 'EACCES' || code === 'EPERM') {
      let group: string | undefined;
      let reason = '当前用户没有该串口的读写权限';
      try {
        const gid = statSync(portPath).gid;
        group = groupName(gid);
        if (group && !inGroup(gid)) reason = `当前用户不在 ${group} 组`;
        else if (group) reason = `串口属于 ${group} 组，但当前用户没有读写权限`;
      } catch {
        // 读不到属组就用通用说明
      }
      return {
        state: 'denied',
        reason,
        ...serialAccessFix(platform, portPath, group),
      };
    }
    return classifySerialAccessError(err as NodeJS.ErrnoException, platform, portPath);
  }
}

/** Linux 下从 /proc 找占用串口的进程；找不到返回 undefined（权限不足时也查不到）。 */
export function findSerialHolder(portPath: string): string | undefined {
  if (process.platform !== 'linux') return undefined;
  let target = portPath;
  try {
    target = realpathSync(portPath);
  } catch {
    // 端口不存在时按原路径比较
  }
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (link !== target && link !== portPath) continue;
      let comm = '';
      try {
        comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      } catch {
        // 进程刚好退出
      }
      return `${comm || '进程'} (pid ${pid})`;
    }
  }
  return undefined;
}
