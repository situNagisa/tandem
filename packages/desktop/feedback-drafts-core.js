'use strict';
// 反馈草稿落盘的核心逻辑（不依赖 Electron，便于单测）：
// 每条反馈一个文件，文本写 UTF-8、图片写原始字节；先写临时文件再 rename，
// 任何时刻磁盘上都不会出现半截文件。
const fs = require('node:fs');
const path = require('node:path');

const DRAFT_PATTERN = /^草稿-\d{8}-\d{4}$/;
const ARCHIVE_PATTERN = /^tandem-feedback-\d{8}-\d{4}\.(tfb|zip)$/;
const EXPORTED_MARKER = '.exported.json';
const RETENTION_DAYS = 7;

function draftDirFor(root, draftId) {
  const id = String(draftId ?? '');
  if (!DRAFT_PATTERN.test(id)) throw new Error(`草稿目录名不合法：${id}`);
  return path.join(root, id);
}

function assertArchiveName(filename) {
  const name = String(filename ?? '');
  if (!ARCHIVE_PATTERN.test(name)) throw new Error(`导出文件名不合法：${name}`);
  return name;
}

/** 只允许单层、以编号或固定名开头的文件名，杜绝路径穿越。 */
function assertFileName(name) {
  const file = String(name ?? '');
  if (!file || file.includes('/') || file.includes('\\') || file === '.' || file.startsWith('..')) {
    throw new Error(`文件名不合法：${file}`);
  }
  if (file.startsWith('.') && file !== EXPORTED_MARKER) throw new Error(`文件名不合法：${file}`);
  return file;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 临时文件清理失败不影响主流程
    }
    throw err;
  }
}

function fileData(entry) {
  if (entry && typeof entry.text === 'string') return Buffer.from(entry.text, 'utf8');
  if (entry && typeof entry.base64 === 'string') return Buffer.from(entry.base64, 'base64');
  return Buffer.alloc(0);
}

/**
 * 把一组文件同步进草稿目录：逐个原子写入，再删掉这次不再产生的旧文件
 * （删除条目后编号会前移，不能留下上一条的截图）。
 */
function syncDraftDir(dir, files) {
  if (!Array.isArray(files)) throw new Error('草稿内容不合法');
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set([EXPORTED_MARKER]);
  const written = [];
  for (const entry of files) {
    const name = assertFileName(entry && entry.path);
    keep.add(name);
    writeAtomic(path.join(dir, name), fileData(entry));
    written.push(name);
  }
  for (const name of fs.readdirSync(dir)) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  return { dir, files: written };
}

function readExportedAt(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, EXPORTED_MARKER), 'utf8'));
    return Number.isFinite(raw?.exportedAt) ? raw.exportedAt : null;
  } catch {
    return null;
  }
}

function markExportedDir(dir, at = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, EXPORTED_MARKER), `${JSON.stringify({ exportedAt: at }, null, 2)}\n`);
  return { dir, exportedAt: at };
}

/** 已导出草稿保留 7 天；未导出的一律不动。返回删掉的目录名。 */
function pruneDrafts(root, now = Date.now(), days = RETENTION_DAYS) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !DRAFT_PATTERN.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const exportedAt = readExportedAt(dir);
    if (exportedAt === null || exportedAt > cutoff) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

function exportArchiveFile(root, filename, base64) {
  const name = assertArchiveName(filename);
  const target = path.join(root, name);
  writeAtomic(target, Buffer.from(String(base64 ?? ''), 'base64'));
  return target;
}

function removeDraftDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  return { dir };
}

module.exports = {
  DRAFT_PATTERN,
  ARCHIVE_PATTERN,
  EXPORTED_MARKER,
  RETENTION_DAYS,
  draftDirFor,
  assertArchiveName,
  assertFileName,
  writeAtomic,
  syncDraftDir,
  readExportedAt,
  markExportedDir,
  pruneDrafts,
  exportArchiveFile,
  removeDraftDir,
};
