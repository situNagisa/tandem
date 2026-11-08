// 工作站设备工具：ADB（本机或跨 Host 挂载）与串口。
// 全部默认需审批；安装与串口写入是独立的写操作审批。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

function manager(ctx: ToolContext) {
  const devices = ctx.devices;
  if (!devices) throw new Error('设备管理器不可用');
  return devices;
}

function mountFor(ctx: ToolContext, device: string) {
  const mount = manager(ctx).getMountByDevice(ctx.session.id, device);
  if (!mount) throw new Error(`设备 ${device} 未挂载到本会话；请先在「工作站」里挂载`);
  return mount;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  if (!value) throw new Error(`缺少 ${key} 参数`);
  return value;
}

export const listDefinition: ToolDefinition = {
  name: 'DeviceList',
  readOnly: true,
  requiresApproval: true,
  description:
    'List devices available to this session: devices mounted to the session (local or on another Tandem Host) ' +
    'and un-mounter devices on the local Host. Use before AdbShell/AdbInstall/SerialOpen.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runList(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const devices = manager(ctx);
  const session = await devices.sessionDevices(ctx.session.id);
  const lines: string[] = [];
  if (session.mounts.length === 0) {
    lines.push('本会话尚未挂载设备。');
  } else {
    lines.push('已挂载到本会话：');
    for (const mount of session.mounts) {
      lines.push(
        `- ${mount.deviceId}（${mount.kind} · ${mount.name}）来源：${mount.source.hostName}${mount.source.kind === 'peer' ? '（跨 Host）' : '（本机）'} · 状态：${mount.state}${mount.busy ? ` · ${mount.busy}` : ''}`,
      );
    }
  }
  if (session.local.length > 0) {
    lines.push('', '本机未挂载设备（需用户在工作站中挂载后可用）：');
    for (const device of session.local) {
      lines.push(`- ${device.id}（${device.kind} · ${device.name}）状态：${device.state}${device.detail ? ` · ${device.detail}` : ''}`);
    }
  }
  return { content: lines.join('\n') };
}

export const adbShellDefinition: ToolDefinition = {
  name: 'AdbShell',
  readOnly: false,
  requiresApproval: true,
  description:
    'Run `adb -s <device> shell <command>` on a mounted ADB device, even if the device is attached to another Host. ' +
    'Returns combined stdout/stderr. Every call needs approval; commands with side effects are not batched.',
  inputSchema: {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Device id from DeviceList, e.g. adb:R58M1234.' },
      command: { type: 'string', description: 'Shell command to run on the device.' },
      timeout: { type: 'number', description: 'Timeout in ms (default 120000, max 600000).' },
    },
    required: ['device', 'command'],
    additionalProperties: false,
  },
};

export async function runAdbShell(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = requireStr(input, 'device');
  const command = requireStr(input, 'command');
  const mount = mountFor(ctx, device);
  const result = await manager(ctx).execAdb(ctx.session.id, mount, device, 'shell', {
    command,
    ...(typeof input.timeout === 'number' ? { timeout: input.timeout } : {}),
  });
  return {
    content: `${result.output || '(无输出)'}${result.exitCode !== undefined ? `\n[退出码 ${result.exitCode}]` : ''}`,
    isError: !result.ok,
  };
}

export const adbInstallDefinition: ToolDefinition = {
  name: 'AdbInstall',
  readOnly: false,
  requiresApproval: true,
  description:
    'Install an APK on a mounted ADB device with `adb install -r`. The APK path must exist on the Host that owns the device ' +
    '(for cross-Host mounts this is the device Host, not the session Host). Requires a separate write approval.',
  inputSchema: {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Device id from DeviceList.' },
      apk_path: { type: 'string', description: 'Absolute APK path on the device-owning Host.' },
    },
    required: ['device', 'apk_path'],
    additionalProperties: false,
  },
};

export async function runAdbInstall(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = requireStr(input, 'device');
  const apkPath = requireStr(input, 'apk_path');
  const mount = mountFor(ctx, device);
  const result = await manager(ctx).execAdb(ctx.session.id, mount, device, 'install', { apkPath });
  return {
    content: `${result.output || '(无输出)'}\n[APK 需位于设备所在 Host：${mount.source.hostName}]`,
    isError: !result.ok,
  };
}

export const adbLogcatDefinition: ToolDefinition = {
  name: 'AdbLogcat',
  readOnly: false,
  requiresApproval: true,
  description:
    'Start a background logcat stream on a mounted ADB device, or read new lines from an existing stream. ' +
    'The stream appears in Background tasks and can be killed there. Without stream_id it starts and returns a stream id; ' +
    'with stream_id it returns output since the last tool read.',
  inputSchema: {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Device id from DeviceList.' },
      stream_id: { type: 'string', description: 'Existing logcat stream id (from a previous call).' },
      tags: { type: 'string', description: 'Optional logcat filter when starting, e.g. "ActivityManager:I *:S".' },
      filter: { type: 'string', description: 'Optional regular expression applied when reading new lines.' },
    },
    required: ['device'],
    additionalProperties: false,
  },
};

export async function runAdbLogcat(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = requireStr(input, 'device');
  const mount = mountFor(ctx, device);
  const streamId = typeof input.stream_id === 'string' ? input.stream_id.trim() : '';
  if (streamId) {
    const read = ctx.backgroundTasks?.readNew(
      streamId,
      typeof input.filter === 'string' && input.filter.trim() ? input.filter.trim() : undefined,
    );
    if (!read) return { content: `logcat 流 ${streamId} 不存在`, isError: true };
    return {
      content: `[${read.task.status}]\n${read.content || '(暂无新输出)'}`,
    };
  }
  const start = await manager(ctx).startSessionLogcat(
    ctx.session.id,
    mount.id,
    typeof input.tags === 'string' ? input.tags : undefined,
  );
  return {
    content:
      `logcat 已在后台启动，stream_id: ${start.streamId}\n` +
      (start.initial ? `[启动输出]\n${start.initial}\n` : '') +
      `用 AdbLogcat { device: "${device}", stream_id: "${start.streamId}" } 读取新增输出，或在后台任务面板终止。`,
  };
}

export const serialOpenDefinition: ToolDefinition = {
  name: 'SerialOpen',
  readOnly: false,
  requiresApproval: true,
  description:
    'Open a mounted serial device at the given baud rate. Serial ports are exclusive by default; use shared=true ' +
    'to attach as a read-only shared lease. The lease is released by SerialClose, session end, or 10 minutes without use.',
  inputSchema: {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Device id from DeviceList, e.g. serial:/dev/ttyUSB0.' },
      baud: { type: 'number', description: 'Baud rate, e.g. 115200.' },
      shared: { type: 'boolean', description: 'Attach read-only if another session holds the exclusive lease.' },
    },
    required: ['device', 'baud'],
    additionalProperties: false,
  },
};

export async function runSerialOpen(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = requireStr(input, 'device');
  const baud = Number(input.baud);
  if (!Number.isFinite(baud) || baud <= 0) return { content: 'baud 无效', isError: true };
  const mount = mountFor(ctx, device);
  const result = await manager(ctx).openSessionSerial(ctx.session.id, mount.id, Math.floor(baud), input.shared === true);
  return {
    content:
      `串口已打开：${device} @ ${result.baud}，租约 ${result.leaseId}` +
      `${result.writable ? '（可写）' : '（只读共享）'}。用 SerialRead 读取、SerialWrite 发送。`,
  };
}

export const serialReadDefinition: ToolDefinition = {
  name: 'SerialRead',
  readOnly: true,
  requiresApproval: true,
  description:
    'Read buffered output from an open serial device. `since` is the cursor returned by a previous read; without it ' +
    'you get the most recent window (default 30 seconds). `filter` is a case-insensitive regular expression.',
  inputSchema: {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Device id from DeviceList.' },
      since: { type: 'number', description: 'Cursor from a previous SerialRead.' },
      window_ms: { type: 'number', description: 'Only include data from the last N ms (default 30000).' },
      filter: { type: 'string', description: 'Case-insensitive regular expression.' },
      max_bytes: { type: 'number', description: 'Maximum characters to return (default 20000).' },
    },
    required: ['device'],
    additionalProperties: false,
  },
};

export async function runSerialRead(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = requireStr(input, 'device');
  const mount = mountFor(ctx, device);
  const since = typeof input.since === 'number' && input.since >= 0 ? input.since : 0;
  const result = await manager(ctx).readSessionSerial(ctx.session.id, mount.id, since, {
    windowMs: typeof input.window_ms === 'number' && input.window_ms > 0 ? input.window_ms : 30_000,
    ...(typeof input.filter === 'string' && input.filter.trim() ? { filter: input.filter.trim() } : {}),
    maxBytes: typeof input.max_bytes === 'number' ? input.max_bytes : 20_000,
  });
  if (!result.alive && !result.data) return { content: '串口未打开或已关闭，请先 SerialOpen', isError: true };
  return {
    content: `${result.data || '(时间窗内无输出)'}\n[cursor ${result.cursor}${result.truncated ? '，较早输出已丢弃' : ''}]`,
  };
}

export const serialWriteDefinition: ToolDefinition = {
  name: 'SerialWrite',
  readOnly: false,
  requiresApproval: true,
  description:
    'Write text to an open serial device owned by this session. Requires a separate write approval. ' +
    'Use "\\n" for a newline; raw text is sent as-is.',
  inputSchema: {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Device id from DeviceList.' },
      data: { type: 'string', description: 'Text to send (escape sequences are NOT interpreted; pass a real newline).' },
    },
    required: ['device', 'data'],
    additionalProperties: false,
  },
};

export async function runSerialWrite(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = requireStr(input, 'device');
  const data = typeof input.data === 'string' ? input.data : '';
  if (!data) return { content: '缺少 data', isError: true };
  const mount = mountFor(ctx, device);
  try {
    await manager(ctx).writeSessionSerial(ctx.session.id, mount.id, data);
    return { content: `已发送 ${data.length} 字符到 ${device}` };
  } catch (err) {
    return { content: (err as Error).message, isError: true };
  }
}
