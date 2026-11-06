// 文件预览：按需读取文件、识别二进制与语言，并在 Host 桌面环境打开文件位置。
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FsReadResult } from '@tandem/protocol';

const MAX_PREVIEW = 1024 * 1024;

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'bash',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  html: 'xml',
  vue: 'xml',
  svg: 'xml',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  diff: 'diff',
  patch: 'diff',
};

export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

function extOf(file: string): string {
  const name = path.basename(file);
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
}

export function languageFromFile(file: string): string | undefined {
  return EXT_LANGUAGE[extOf(file)];
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.includes(0);
}

export async function readForPreview(abs: string): Promise<FsReadResult> {
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw Object.assign(new Error(`这是一个目录: ${abs}`), { statusCode: 400 });
  const size = stat.size;
  const handle = await fs.open(abs, 'r');
  const length = Math.min(size, MAX_PREVIEW + 1);
  const buf = Buffer.alloc(length);
  try {
    if (length > 0) await handle.read(buf, 0, length, 0);
  } finally {
    await handle.close();
  }
  const isBinary = looksBinary(buf);
  const truncated = !isBinary && size > MAX_PREVIEW;
  const content = isBinary ? '' : buf.subarray(0, Math.min(buf.length, MAX_PREVIEW)).toString('utf8');
  return {
    path: abs,
    content,
    truncated,
    isBinary,
    size,
    ...(languageFromFile(abs) ? { language: languageFromFile(abs) } : {}),
  };
}

export async function readImage(abs: string): Promise<{ data: Buffer; mime: string }> {
  const mime = IMAGE_MIME[extOf(abs)];
  if (!mime) throw Object.assign(new Error('不是支持的图片格式'), { statusCode: 400 });
  const data = await fs.readFile(abs);
  return { data, mime };
}

/** 在 Host 桌面环境打开文件所在目录（macOS 用 Finder 定位文件）。 */
export function revealFile(abs: string, isDir: boolean): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const done = (err: Error | null) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    };
    let cmd: string;
    let args: string[];
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = isDir ? [abs] : ['-R', abs];
    } else if (process.platform === 'win32') {
      cmd = 'explorer.exe';
      args = isDir ? [abs] : [`/select,${abs}`];
    } else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        resolve({ ok: false, error: 'Host 不在桌面环境，无法打开文件管理器' });
        return;
      }
      cmd = 'xdg-open';
      args = [isDir ? abs : path.dirname(abs)];
    }
    try {
      execFile(cmd, args, { timeout: 10_000 }, done);
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
    }
  });
}

export function imageMimeFor(file: string): string | undefined {
  return IMAGE_MIME[extOf(file)];
}
