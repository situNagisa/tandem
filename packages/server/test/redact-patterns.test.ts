import assert from 'node:assert/strict';
import test from 'node:test';
import { redactText } from '../src/share/sanitize.js';
import { redactGatewayText } from '../src/gateway/redact.js';
import { redactSecretValues } from '../src/secrets.js';
import { KNOWN_KEY, PRIVATE_KEY } from '../src/redactPatterns.js';

/** 用统一标记验证模式能识别某种形态。 */
function masked(text: string): string {
  return text.replace(PRIVATE_KEY, '[P]').replace(KNOWN_KEY, '[K]');
}

test('合并后的私钥模式覆盖各 PEM 类型', () => {
  for (const kind of ['RSA ', 'EC ', 'OPENSSH ', 'DSA ', 'PGP ', '', 'ENCRYPTED ']) {
    const text = `-----BEGIN ${kind}PRIVATE KEY-----\nMIIEow\n-----END ${kind}PRIVATE KEY-----`;
    assert.equal(masked(text), '[P]', kind || '裸 PRIVATE KEY');
  }
});

test('合并后的 Key 模式覆盖三处原先识别的每种形态', () => {
  const samples = [
    // secrets / sanitize：OpenAI 系（含 secrets 的 20+ 与 sanitize 的 8+、gateway 的 6+）
    'sk-12345678901234567890',
    'sk-abcdefgh',
    'sk-123456',
    'rk-12345678901234567890',
    'pk-12345678901234567890',
    // secrets / sanitize：GitHub
    'ghp_abcdefghijklmnopqrstuvwx',
    'gho_abcdefghijklmnopqrstuvwx',
    'ghu_abcdefghijklmnopqrstuvwx',
    'ghs_abcdefghijklmnopqrstuvwx',
    'ghr_abcdefghijklmnopqrstuvwx',
    'github_pat_abcdefghijklmnopqrstuvwx',
    // secrets / sanitize：GitLab、Slack
    'glpat-abcdefghijklmnopqrstuvwx',
    'xoxb-1234567890',
    'xoxp-1234567890',
    // secrets：AWS
    'AKIAABCDEFGHIJKLMNOP',
    'ASIAABCDEFGHIJKLMNOP',
    // sanitize：Google
    'AIzaabcdefghijklmnopqrstuvwx',
    // gateway：Tandem 网关 / 成员令牌
    'tgw_0123456789abcdef',
    'tmm_0123456789abcdef',
  ];
  for (const sample of samples) {
    assert.equal(masked(`前缀 ${sample} 后缀`), '前缀 [K] 后缀', sample);
  }
});

test('分享脱敏仍识别私钥、Key、Authorization、查询参数、赋值、环境变量与 URL 凭据', () => {
  const cases: Array<[string, string]> = [
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[已隐藏私钥]'],
    ['sk-1234567890', '[已隐藏密钥]'],
    ['xoxb-1234567890', '[已隐藏密钥]'],
    ['AIzaabcdefghijklmnopqrstuvwx', '[已隐藏密钥]'],
    ['Authorization: Bearer abc123', '[已隐藏]'],
    ['Authorization=Basic dXNlcjpwYXNz', '[已隐藏]'],
    ['https://x.test/?token=abc123&x=1', '[已隐藏]'],
    ['https://x.test/?api_key=abc123', '[已隐藏]'],
    ['{"apiKey": "abcdef"}', '[已隐藏]'],
    ['"shareToken": "abcdef"', '[已隐藏]'],
    ['OPENAI_API_KEY=abc123', '[已隐藏]'],
    ['https://user:pass@example.com/x', '[已隐藏]'],
  ];
  for (const [input, mark] of cases) {
    const output = redactText(input);
    assert.ok(output.includes(mark), `${input} → ${output}`);
    assert.ok(!output.includes('abc123') && !output.includes('abcdef') && !output.includes('dXNlcjpwYXNz'), output);
  }
});

test('网关调试脱敏仍识别 Bearer、sk、tgw 与 tmm', () => {
  const cases: Array<[string, string]> = [
    ['Authorization: Bearer abcdef', 'Bearer [REDACTED]'],
    ['sk-123456', '[REDACTED_KEY]'],
    ['tgw_0123456789abcdef', '[REDACTED_GATEWAY_TOKEN]'],
    ['TGW_0123456789ABCDEF', '[REDACTED_GATEWAY_TOKEN]'],
    ['tmm_0123456789abcdef', '[REDACTED_MEMBER_TOKEN]'],
    ['TMM_0123456789ABCDEF', '[REDACTED_MEMBER_TOKEN]'],
  ];
  for (const [input, mark] of cases) {
    assert.ok(redactGatewayText(input).includes(mark), `${input} → ${redactGatewayText(input)}`);
  }
});

test('Secrets 通用打码仍识别原先每种形态并在关闭时不打码', () => {
  const text = [
    '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    'sk-12345678901234567890',
    'ghp_abcdefghijklmnopqrstuvwx',
    'github_pat_abcdefghijklmnopqrstuvwx',
    'glpat-abcdefghijklmnopqrstuvwx',
    'xoxb-1234567890',
    'AKIAABCDEFGHIJKLMNOP',
    'ASIAABCDEFGHIJKLMNOP',
  ].join('\n');
  const output = redactSecretValues(text, [], true);
  assert.ok(output.includes('[secret:private-key]'));
  assert.equal(output.match(/\[secret:generic\]/g)?.length, 7);
  assert.equal(redactSecretValues(text, [], false), text);
});
