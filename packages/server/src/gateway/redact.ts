// 调试正文脱敏：令牌/Key/密码类字段整体替换，常见的 Key 字符串形态做文本替换。
const SENSITIVE_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|gateway[-_]?token|secret|password|cookie)/i;
const KEY_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '[REDACTED_KEY]'],
  [/\btgw_[a-f0-9]{16,}/gi, '[REDACTED_GATEWAY_TOKEN]'],
  [/\btmm_[a-f0-9]{16,}/gi, '[REDACTED_MEMBER_TOKEN]'],
];

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return KEY_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** 对 JSON 字符串/纯文本做脱敏；非 JSON 也按常见 Key 形态替换。 */
export function redactGatewayText(text: string, maxChars = 200_000): string {
  if (!text) return '';
  let output = text;
  try {
    output = JSON.stringify(redactValue(JSON.parse(text)));
  } catch {
    output = KEY_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
  }
  if (output.length > maxChars) output = `${output.slice(0, maxChars)}\n…[truncated ${output.length - maxChars} chars]`;
  return output;
}
