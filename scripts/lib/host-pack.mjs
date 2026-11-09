// 主机安装包的纯函数：运行所需文件过滤、路径断言、最小 ZIP 写入。
// 只放运行所需文件：测试夹具、文档、示例、源码映射不进包；路径必须是 ASCII
// （Windows 自带 tar 遇到非 ASCII/非法路径会失败，解压时也可能乱码），且必须有 dist/cli.js。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EXCLUDED_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'fixtures',
  'fixture',
  'example',
  'examples',
  'doc',
  'docs',
  'benchmark',
  'benchmarks',
  '.github',
]);

const EXCLUDED_EXT = new Set(['.md', '.markdown', '.map', '.ts', '.tsx', '.flow', '.coffee']);

/** 包内相对路径（`/` 分隔）是否属于运行时文件。 */
export function isRuntimeFile(relPath) {
  const parts = relPath.split('/');
  if (parts.some((part) => EXCLUDED_DIRS.has(part.toLowerCase()))) return false;
  return !EXCLUDED_EXT.has(path.extname(relPath).toLowerCase());
}

/** 递归收集目录下的文件（返回包内相对路径，`/` 分隔）。 */
export function collectFiles(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(root, '');
  return files;
}

/** 删除过滤掉的文件与空目录（在打包前的 stage 目录里执行）。 */
export function pruneRuntime(root) {
  let removed = 0;
  for (const rel of collectFiles(root)) {
    if (isRuntimeFile(rel)) continue;
    fs.rmSync(path.join(root, rel), { force: true });
    removed += 1;
  }
  const pruneDirs = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pruneDirs(path.join(dir, entry.name));
    }
    if (dir !== root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  pruneDirs(root);
  return removed;
}

/**
 * 打包目标 → 允许的原生预编译平台前缀。
 * Windows 包只留 win32-*；Unix 包（.tgz，安装脚本给 macOS/Linux 用）留 linux- / darwin-*。
 * pack-host 在 WSL 里打包，不按目标裁剪就会把 linux-x64 的 .node 塞进 Windows 包（R56 复发）。
 */
const NATIVE_PLATFORM_PREFIXES = { win32: ['win32'], unix: ['linux', 'darwin'] };

/** 原生预编译模块（.node）的目标平台，如 `win32-x64`、`linux-x64`；不在 prebuilds/<平台>/ 下返回 'unknown'；非 .node 返回 undefined。 */
export function nativeModulePlatform(relPath) {
  if (!relPath.toLowerCase().endsWith('.node')) return undefined;
  const match = relPath.match(/(?:^|\/)prebuilds\/([^/]+)\//);
  return match ? match[1] : 'unknown';
}

/** 按目标平台剔除非本平台的预编译模块（返回新数组，保持原顺序）。 */
export function filterNativeModules(entries, target) {
  const allowed = NATIVE_PLATFORM_PREFIXES[target];
  if (!allowed) throw new Error(`未知打包目标: ${target}`);
  return entries.filter((rel) => {
    const platform = nativeModulePlatform(rel);
    if (!platform) return true;
    return allowed.some((prefix) => platform.startsWith(prefix));
  });
}

/**
 * 打包前断言：路径为 ASCII、无控制字符、不是绝对路径/上级目录；必需文件存在。
 * 传了 target 时再断言原生模块平台与目标一致（Windows 包不混 Linux 的 .node，且要有 win32-x64 的 serialport）。
 * 任何一条不满足就抛错，避免把坏包发给工作站。
 */
export function assertPackable(entries, options = {}) {
  const problems = [];
  for (const rel of entries) {
    if (!/^[\x20-\x7e]+$/.test(rel)) problems.push(`路径不是 ASCII: ${JSON.stringify(rel)}`);
    if (rel.startsWith('/') || rel.includes('\\')) problems.push(`路径分隔符不合法: ${JSON.stringify(rel)}`);
    if (rel.split('/').some((part) => part === '..' || part === '')) problems.push(`路径包含空段或上级目录: ${JSON.stringify(rel)}`);
  }
  if (!entries.includes('dist/cli.js')) problems.push('缺少 dist/cli.js');
  if (!entries.includes('package.json')) problems.push('缺少 package.json');
  const target = options.target;
  if (target) {
    const allowed = NATIVE_PLATFORM_PREFIXES[target];
    if (!allowed) throw new Error(`未知打包目标: ${target}`);
    for (const rel of entries) {
      const platform = nativeModulePlatform(rel);
      if (!platform) continue;
      if (platform === 'unknown') problems.push(`原生模块不在 prebuilds/<平台>/ 下，无法判断平台: ${JSON.stringify(rel)}`);
      else if (!allowed.some((prefix) => platform.startsWith(prefix))) {
        problems.push(`${target} 安装包混入了 ${platform} 平台的原生模块: ${JSON.stringify(rel)}`);
      }
    }
    const hasSerialport = entries.some((rel) => rel.includes('@serialport/bindings-cpp/'));
    if (hasSerialport && target === 'win32' && !entries.some((rel) => /\/prebuilds\/win32-x64\/[^/]+\.node$/.test(rel))) {
      problems.push('Windows 安装包缺少 @serialport/bindings-cpp 的 win32-x64 预编译模块（串口设备不可用）');
    }
    if (hasSerialport && target === 'unix' && !entries.some((rel) => /\/prebuilds\/(linux|darwin)[^/]*\/[^/]+\.node$/.test(rel))) {
      problems.push('Unix 安装包缺少 @serialport/bindings-cpp 的 linux/darwin 预编译模块（串口设备不可用）');
    }
  }
  if (problems.length > 0) throw new Error(`主机安装包内容不合格：\n  ${problems.slice(0, 20).join('\n  ')}`);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// 固定时间戳（1980-01-01 00:00）：同样的输入产出同样的 ZIP，便于比对。
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/**
 * 最小 ZIP 写入：deflate 压缩，文件名必须 ASCII。返回 Buffer。
 * 只支持 <4GB、<65535 个文件（主机安装包远小于上限）。
 */
export function createZip(files) {
  if (files.length >= 0xffff) throw new Error('文件数量超过 ZIP 上限（65535）');
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    if (!/^[\x20-\x7e]+$/.test(file.name)) throw new Error(`不能写入非 ASCII 路径: ${JSON.stringify(file.name)}`);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.concat([local, name]);
    locals.push(header, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(useDeflate ? 8 : 0, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk
    record.writeUInt16LE(0, 36); // internal attrs
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs
    record.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([record, name]));

    offset += header.length + body.length;
    if (offset >= 0xffffffff) throw new Error('安装包超过 4GB，需要 ZIP64（不支持）');
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/** 从目录生成 ZIP Buffer（只收运行时文件，调用方已断言路径）。 */
export function zipDirectory(root, entries) {
  return createZip(
    entries.map((rel) => ({ name: rel, data: fs.readFileSync(path.join(root, rel)) })),
  );
}
