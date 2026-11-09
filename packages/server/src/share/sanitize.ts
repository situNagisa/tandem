// 分享前的脱敏：密钥 / URL 凭据 / 环境变量值一律抹掉；可选把绝对路径换成
// 项目相对路径或 <home>。所有字符串都过一遍，工具入参与输出也不例外。
import os from 'node:os';
import path from 'node:path';
import type { ContentBlock, Message, PublicShare } from '@tandem/protocol';
import {
  ASSIGN_SECRET,
  AUTH_HEADER,
  ENV_ASSIGN,
  KNOWN_KEY,
  PRIVATE_KEY,
  QUERY_SECRET,
  URL_CREDENTIAL,
} from '../redactPatterns.js';

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION)/i;

/** 当前进程里敏感环境变量的值：出现在消息/工具输出里时整段替换。 */
function secretEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && !!value && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

/** 文本脱敏。 */
export function redactText(input: string, envValues = secretEnvValues()): string {
  let out = input;
  out = out.replace(PRIVATE_KEY, '$1 [已隐藏私钥] $2');
  out = out.replace(KNOWN_KEY, '[已隐藏密钥]');
  out = out.replace(AUTH_HEADER, '$1$2 [已隐藏]');
  out = out.replace(QUERY_SECRET, '$1[已隐藏]');
  out = out.replace(ASSIGN_SECRET, '$1$2[已隐藏]$2');
  out = out.replace(ENV_ASSIGN, '$1=[已隐藏]');
  out = out.replace(URL_CREDENTIAL, '//[已隐藏]@');
  for (const value of envValues) {
    if (out.includes(value)) out = out.split(value).join('[已隐藏]');
  }
  return out;
}

const WIN_PATH = /\b[A-Za-z]:[\\/][^\s"'`<>|]*/g;
const UNIX_ABS = /(?<![\w:/])\/(?:home|Users|root|tmp|var|etc|opt|mnt|srv|data|private|usr|Applications)\/[^\s"'`<>|)]*/g;

function absPathReplacement(value: string): string {
  const base = value.split(/[\\/]/).filter(Boolean).pop();
  return base && base.includes('.') ? `<path>/${base}` : '<path>';
}

function replacePathRoots(text: string, roots: Array<{ root: string; label: string }>): string {
  let out = text;
  for (const { root, label } of roots) {
    if (!root) continue;
    for (const variant of new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])) {
      out = out.split(variant).join(label);
    }
  }
  return out;
}

/** 把绝对路径换成相对项目根 / <home> / <path>。 */
export function hidePathsInText(text: string, cwd: string, home = os.homedir()): string {
  const normalizedCwd = path.resolve(cwd).replace(/[\\/]+$/, '');
  const normalizedHome = path.resolve(home).replace(/[\\/]+$/, '');
  let out = replacePathRoots(text, [
    { root: normalizedCwd, label: '.' },
    { root: normalizedHome, label: '<home>' },
  ]);
  out = out.replace(WIN_PATH, absPathReplacement);
  out = out.replace(UNIX_ABS, absPathReplacement);
  // 单独出现的 cwd / home（例如消息正文只写了目录）
  if (normalizedCwd && out.includes(normalizedCwd)) out = out.split(normalizedCwd).join('.');
  if (normalizedHome && out.includes(normalizedHome)) out = out.split(normalizedHome).join('<home>');
  return out;
}

/** 工具结果摘要：保留首个非空行，其余省略。 */
export function summarizeToolOutput(content: string, isError?: boolean): string {
  const first = content.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  const head = first.length > 300 ? `${first.slice(0, 300)}…` : first;
  const suffix = content.length > 0 ? `\n…（工具输出已省略，原 ${content.length} 字符）` : '\n（工具输出已省略）';
  return isError ? `${head || '工具执行失败'}${suffix}` : `${head}${suffix}`;
}

function sanitizeText(text: string, cwd: string, hide: boolean, envValues: string[]): string {
  const redacted = redactText(text, envValues);
  return hide ? hidePathsInText(redacted, cwd) : redacted;
}

function sanitizeUnknown(value: unknown, cwd: string, hide: boolean, envValues: string[]): unknown {
  if (typeof value === 'string') return sanitizeText(value, cwd, hide, envValues);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item, cwd, hide, envValues));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 明确的结构化凭据字段直接清空，避免出现在工具入参 / usage 里
      if (/^(apiKey|api_key|token|accessToken|refreshToken|secret|password|authorization)$/i.test(key)) {
        out[key] = '[已隐藏]';
        continue;
      }
      if (key === 'keyId') continue;
      out[key] = sanitizeUnknown(item, cwd, hide, envValues);
    }
    return out;
  }
  return value;
}

export interface SanitizeOptions {
  includeToolOutputs: boolean;
  hidePaths: boolean;
}

function sanitizeBlock(
  block: ContentBlock,
  cwd: string,
  options: SanitizeOptions,
  envValues: string[],
): ContentBlock {
  switch (block.type) {
    case 'text':
    case 'thinking':
    case 'context':
      return {
        ...block,
        text: sanitizeText(block.text, cwd, options.hidePaths, envValues),
      } as ContentBlock;
    case 'tool_use':
      return {
        ...block,
        input: sanitizeUnknown(block.input, cwd, options.hidePaths, envValues),
      };
    case 'tool_result': {
      // 即使只保留摘要，摘要本身也要先脱敏 / 隐藏路径。
      const safe = sanitizeText(block.content, cwd, options.hidePaths, envValues);
      return {
        ...block,
        content: options.includeToolOutputs ? safe : summarizeToolOutput(safe, block.isError),
      };
    }
    case 'image':
      // 用户主动分享的截图保留；base64 本身不含文本信息。
      return { ...block };
    default:
      return block;
  }
}

function sanitizeMessage(
  message: Message,
  cwd: string,
  options: SanitizeOptions,
  envValues: string[],
): Message {
  return {
    ...message,
    content: message.content.map((block) => sanitizeBlock(block, cwd, options, envValues)),
    usage: message.usage
      ? {
          ...message.usage,
          ...(message.usage.keyId ? { keyId: undefined } : {}),
        }
      : undefined,
  };
}

/** 生成可直接下发给分享页的会话（不含 profile / cwd / env / 任何凭据）。 */
export function buildPublicShare(input: {
  shareId: string;
  hostName: string;
  session: {
    id: string;
    title: string;
    model?: string;
    createdAt: number;
    updatedAt: number;
    cwd: string;
    messages: Message[];
  };
  options: SanitizeOptions;
  live: boolean;
  expiresAt?: number;
}): PublicShare {
  const envValues = secretEnvValues();
  const hide = input.options.hidePaths;
  const cwd = input.session.cwd;
  return {
    id: input.shareId,
    hostName: redactText(input.hostName, envValues),
    title: sanitizeText(input.session.title || '未命名会话', cwd, hide, envValues),
    ...(input.session.model
      ? { model: sanitizeText(input.session.model, cwd, hide, envValues) }
      : {}),
    createdAt: input.session.createdAt,
    updatedAt: input.session.updatedAt,
    live: input.live,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    messages: input.session.messages.map((message) =>
      sanitizeMessage(structuredClone(message), cwd, input.options, envValues),
    ),
  };
}
