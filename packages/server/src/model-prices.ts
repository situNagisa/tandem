// 价格表（MODEL 领域核心模型「价格表」的唯一实现）。
//
// 官方单价存放在工作站数据目录的 model-prices.json（首启用下面这份内置表初始化），
// 计价只读这份表；设置里「模型价格」按厂商配置定价页地址与解析规则，一键刷新后先预览差异再写入。
// 只收官方定价页上逐型号列出的价格，不在型号之间借价：型号名须完全相同，或只差日期后缀
// （`-YYYYMMDD` / `@YYYYMMDD`）与 `-latest`（同一型号的不同写法）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ModelPriceChange,
  ModelPriceColumns,
  ModelPriceEntry,
  ModelPricePreview,
  ModelPriceRule,
  ModelPriceTable,
  ModelPriceVendor,
  UnitPrice,
} from '@tandem/protocol';

/** 一组每百万 token 的单价（美元）。 */
export type PriceRates = UnitPrice;

export interface Price extends UnitPrice {
  /** 单次请求提示 token 超过 threshold 时整条请求改用这份单价（如 Haiku 5.5 的 100K 分段）。 */
  longPrompt?: { threshold: number; rates: PriceRates };
}

const PRICE_FILE = 'model-prices.json';
const USER_AGENT = 'tandem-price-refresh/1.0 (+https://localhost)';

/** 首次启动写入的价格表：来源与核对日期见各厂商的 source / updatedAt。 */
const DEFAULT_VENDORS: ModelPriceVendor[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    // 文档站是客户端渲染，价格表在 llms-full.txt 的 Markdown 里；读到后半段就停，避免下载整站。
    rule: {
      type: 'markdown-table',
      url: 'https://platform.claude.com/llms-full.txt',
      until: 'All other models use the standard 0.1x multiplier',
      header: '5m cache writes',
      columns: { model: 0, input: 1, cacheWrite: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 },
    },
    updatedAt: '2026-11-17',
    models: [
      { model: 'claude-2', input: 8, output: 24 },
      { model: 'claude-3-opus', input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
      { model: 'claude-3-sonnet', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-3-5-sonnet', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-3.5-sonnet', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-3-7-sonnet', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-3.7-sonnet', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-3-5-haiku', input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
      { model: 'claude-3.5-haiku', input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
      { model: 'claude-3-haiku', input: 0.25, output: 1.25, cacheWrite5m: 0.3, cacheRead: 0.03 },
      { model: 'claude-opus-4-1', input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
      { model: 'claude-opus-4', input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
      { model: 'claude-opus-4-5', input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
      { model: 'claude-opus-4-6', input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
      { model: 'claude-opus-4-7', input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
      { model: 'claude-opus-4-8', input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
      { model: 'claude-opus-5-5', input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
      { model: 'claude-opus-5', input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
      { model: 'claude-sonnet-4', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-sonnet-4-5', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-sonnet-4-6', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { model: 'claude-sonnet-5-5', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
      { model: 'claude-sonnet-5', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
      { model: 'claude-haiku-4-5', input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
      { model: 'claude-haiku-5-5', input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, longPrompt: {threshold: 100000, rates: {input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05}} },
      { model: 'claude-fable-5-2', input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 },
      { model: 'claude-fable-5-1', input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
      { model: 'claude-fable-5', input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
      { model: 'claude-mythos-5-2', input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 },
      { model: 'claude-mythos-5-1', input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
      { model: 'claude-mythos-5', input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    source: 'https://developers.openai.com/api/docs/pricing',
    rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, cacheRead: 2, output: 3 } },
    updatedAt: '2026-11-17',
    models: [
      { model: 'gpt-6.1-sol', input: 2, output: 10, cacheRead: 0.1 },
      { model: 'gpt-6.1-terra', input: 1, output: 5, cacheRead: 0.05 },
      { model: 'gpt-6-astra-law', input: 10, output: 50, cacheRead: 1 },
      { model: 'gpt-6-astra', input: 10, output: 50, cacheRead: 1 },
      { model: 'gpt-6-cyber', input: 20, output: 100, cacheRead: 2 },
      { model: 'gpt-6-rosalind', input: 15, output: 75, cacheRead: 1.5 },
      { model: 'gpt-6-luna', input: 0.1, output: 0.5, cacheRead: 0.01 },
      { model: 'chat-latest', input: 5, output: 30, cacheRead: 0.5 },
      { model: 'gpt-5.1-codex', input: 1.25, output: 10 },
      { model: 'gpt-5-pro', input: 15, output: 120 },
      { model: 'gpt-5-codex', input: 1.25, output: 10 },
      { model: 'gpt-5-mini', input: 0.25, output: 2 },
      { model: 'gpt-5-nano', input: 0.05, output: 0.4 },
      { model: 'gpt-4.1-mini', input: 0.4, output: 1.6 },
      { model: 'gpt-4.1-nano', input: 0.1, output: 0.4 },
      { model: 'gpt-4.1', input: 2, output: 8 },
      { model: 'gpt-4o-mini', input: 0.15, output: 0.6 },
      { model: 'gpt-4o', input: 2.5, output: 10 },
      { model: 'gpt-4-turbo', input: 10, output: 30 },
      { model: 'gpt-4', input: 30, output: 60 },
      { model: 'gpt-3.5-turbo', input: 0.5, output: 1.5 },
      { model: 'o1-pro', input: 150, output: 600 },
      { model: 'o1-mini', input: 1.1, output: 4.4 },
      { model: 'o1-preview', input: 15, output: 60 },
      { model: 'o1', input: 15, output: 60 },
      { model: 'o3-pro', input: 20, output: 80 },
      { model: 'o3-mini', input: 1.1, output: 4.4 },
      { model: 'o3', input: 2, output: 8 },
      { model: 'o4-mini', input: 1.1, output: 4.4 },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, output: 2 } },
    updatedAt: '2026-11-17',
    models: [
      { model: 'gemini-3.1-pro', input: 2, output: 12, longPrompt: {threshold: 200000, rates: {input: 4, output: 18}} },
      { model: 'gemini-3-flash', input: 0.5, output: 3 },
      { model: 'gemini-2.5-pro', input: 1.25, output: 10, longPrompt: {threshold: 200000, rates: {input: 2.5, output: 15}} },
      { model: 'gemini-2.5-flash-lite', input: 0.1, output: 0.4 },
      { model: 'gemini-2.5-flash', input: 0.3, output: 2.5 },
      { model: 'gemini-2.0-flash-lite', input: 0.075, output: 0.3 },
      { model: 'gemini-2.0-flash', input: 0.1, output: 0.4 },
      { model: 'gemini-1.5-pro', input: 1.25, output: 5 },
      { model: 'gemini-1.5-flash', input: 0.075, output: 0.3 },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    // 价格表是转置的：型号为列、价格项为行，同一项分 PEAK / OFF-PEAK 两行。
    rule: {
      type: 'html-table',
      table: 'table',
      transpose: true,
      modelRow: 'MODEL',
      rows: { input: 'INPUT TOKENS (CACHE MISS)', cacheRead: 'INPUT TOKENS (CACHE HIT)', output: 'OUTPUT TOKENS' },
      variant: 'PEAK',
    },
    updatedAt: '2026-11-17',
    models: [
      { model: 'deepseek-v4-pro', input: 1.32, output: 3.96, cacheRead: 0.044 },
      { model: 'deepseek-flash', input: 0.3, output: 1.2, cacheRead: 0.006 },
      { model: 'deepseek-v4-flash', input: 0.3, output: 1.2, cacheRead: 0.006 },
      { model: 'deepseek-reasoner', input: 0.55, output: 2.19 },
      { model: 'deepseek-r1', input: 0.55, output: 2.19 },
      { model: 'deepseek-chat', input: 0.27, output: 1.1 },
      { model: 'deepseek-coder', input: 0.27, output: 1.1 },
      { model: 'deepseek-v3', input: 0.27, output: 1.1 },
    ],
  },
  {
    id: 'glm',
    label: 'Z.AI GLM',
    source: 'https://docs.z.ai/guides/overview/pricing',
    rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, cacheRead: 2, output: 4 } },
    updatedAt: '2026-11-17',
    models: [
      { model: 'glm-5.3-flashx-legal', input: 0.37, output: 1.25, cacheRead: 0.075 },
      { model: 'glm-5.3-flashx', input: 0.37, output: 1.25, cacheRead: 0.075 },
      { model: 'glm-5.3-flash', input: 0.15, output: 0.5, cacheRead: 0.03 },
      { model: 'glm-5.3', input: 1.4, output: 4.4, cacheRead: 0.26 },
      { model: 'glm-5.2', input: 1.4, output: 4.4, cacheRead: 0.26 },
      { model: 'glm-5.1', input: 1.4, output: 4.4, cacheRead: 0.26 },
      { model: 'glm-5', input: 1, output: 3.2, cacheRead: 0.2 },
      { model: 'glm-4.7-flashx', input: 0.07, output: 0.4, cacheRead: 0.01 },
      { model: 'glm-4.7', input: 0.6, output: 2.2, cacheRead: 0.11 },
      { model: 'glm-4.6v-flashx', input: 0.04, output: 0.4, cacheRead: 0.004 },
      { model: 'glm-4.6v', input: 0.3, output: 0.9, cacheRead: 0.05 },
      { model: 'glm-4.6', input: 0.6, output: 2.2, cacheRead: 0.11 },
      { model: 'glm-4.5-x', input: 2.2, output: 8.9, cacheRead: 0.45 },
      { model: 'glm-4.5-airx', input: 1.1, output: 4.5, cacheRead: 0.22 },
      { model: 'glm-4.5-air', input: 0.2, output: 1.1, cacheRead: 0.03 },
      { model: 'glm-4.5v', input: 0.6, output: 1.8, cacheRead: 0.11 },
      { model: 'glm-4.5', input: 0.6, output: 2.2, cacheRead: 0.11 },
      { model: 'glm-4-32b-0414-128k', input: 0.1, output: 0.1 },
      { model: 'glm-ocr', input: 0.03, output: 0.03 },
      { model: 'glm-4-plus', input: 0.7, output: 0.7 },
      { model: 'glm-4', input: 0.6, output: 0.6 },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi（Moonshot）',
    // 价格表由页面脚本里的 DocTable 数据渲染，没有 <table>；用英文站（美元，与价格表一致）。
    source: 'https://platform.moonshot.ai/docs/pricing/chat',
    rule: {
      type: 'script-table',
      columns: { model: 0, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5 },
    },
    updatedAt: '2026-11-17',
    models: [
      { model: 'kimi-k2', input: 0.6, output: 2.5 },
      { model: 'kimi-latest', input: 2, output: 8 },
      { model: 'moonshot-v1-128k', input: 1.68, output: 1.68 },
      { model: 'moonshot-v1-32k', input: 0.84, output: 0.84 },
      { model: 'moonshot-v1-8k', input: 0.17, output: 0.17 },
    ],
  },
  {
    id: 'qwen',
    label: 'Qwen（阿里云）',
    source: 'https://help.aliyun.com/zh/model-studio/models',
    rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, output: 2 } },
    updatedAt: '2026-11-17',
    models: [
      { model: 'qwen3-max', input: 1.2, output: 6 },
      { model: 'qwen3-coder', input: 0.3, output: 1.2 },
      { model: 'qwen-max', input: 1.6, output: 6.4 },
      { model: 'qwen-plus', input: 0.4, output: 1.2 },
      { model: 'qwen-turbo', input: 0.05, output: 0.2 },
      { model: 'qwen-long', input: 0.07, output: 0.28 },
    ],
  },
];

/**
 * 上一版内置的规则与地址。已存在的数据文件不会重新初始化，读取时若某个厂商的规则
 * 仍与这里完全相同（用户没改过），就换成当前内置规则；用户改过的不动。
 */
const PREVIOUS_DEFAULTS: Record<string, { source: string; rule: ModelPriceRule }> = {
  anthropic: {
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } },
  },
  deepseek: {
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, cacheRead: 2, output: 3 } },
  },
  kimi: {
    source: 'https://platform.moonshot.cn/docs/pricing/chat',
    rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, output: 2 } },
  },
};

let current: ModelPriceTable = { version: 1, vendors: structuredClone(DEFAULT_VENDORS) };
let currentHome: string | undefined;

/** 价格数据文件：工作站数据目录下的 model-prices.json。 */
export function priceFileFor(home: string): string {
  return path.join(home, PRICE_FILE);
}

function normalizeEntry(raw: unknown): ModelPriceEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const model = typeof item.model === 'string' ? item.model.trim().toLowerCase() : '';
  const input = Number(item.input);
  const output = Number(item.output);
  if (!model || !Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const out: ModelPriceEntry = { model, input, output };
  const cacheRead = Number(item.cacheRead);
  const cacheWrite5m = Number(item.cacheWrite5m);
  const cacheWrite1h = Number(item.cacheWrite1h);
  if (item.cacheRead !== undefined && Number.isFinite(cacheRead)) out.cacheRead = cacheRead;
  if (item.cacheWrite5m !== undefined && Number.isFinite(cacheWrite5m)) out.cacheWrite5m = cacheWrite5m;
  if (item.cacheWrite1h !== undefined && Number.isFinite(cacheWrite1h)) out.cacheWrite1h = cacheWrite1h;
  const long = item.longPrompt as { threshold?: unknown; rates?: Record<string, unknown> } | undefined;
  const threshold = Number(long?.threshold);
  if (long?.rates && Number.isFinite(threshold)) {
    const rates = normalizeEntry({ model, ...long.rates });
    if (rates) out.longPrompt = { threshold, rates: withoutModel(rates) };
  }
  return out;
}

function withoutModel(entry: ModelPriceEntry): UnitPrice {
  const { model, longPrompt, ...rates } = entry;
  void model;
  void longPrompt;
  return rates;
}

const COLUMN_KEYS = ['model', 'input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'] as const;
const ROW_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const;

function normalizeColumns(raw: unknown): ModelPriceColumns {
  const columns = (raw ?? {}) as Record<string, unknown>;
  const mapped: ModelPriceColumns = {};
  for (const key of COLUMN_KEYS) {
    const index = Number(columns[key]);
    if (Number.isInteger(index) && index >= 0) mapped[key] = index;
  }
  return mapped;
}

function normalizeRule(raw: unknown): ModelPriceRule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rule = raw as Record<string, unknown>;
  const fetch: { url?: string; until?: string } = {};
  if (typeof rule.url === 'string' && rule.url.trim()) fetch.url = rule.url.trim();
  if (typeof rule.until === 'string' && rule.until.trim()) fetch.until = rule.until.trim();
  if (rule.type === 'json') {
    const rulePath = typeof rule.path === 'string' ? rule.path.trim() : '';
    return { ...fetch, type: 'json', ...(rulePath ? { path: rulePath } : {}) };
  }
  if (rule.type === 'html-table') {
    const rows: Partial<Record<(typeof ROW_KEYS)[number], string>> = {};
    if (rule.rows && typeof rule.rows === 'object') {
      for (const key of ROW_KEYS) {
        const label = (rule.rows as Record<string, unknown>)[key];
        if (typeof label === 'string' && label.trim()) rows[key] = label.trim();
      }
    }
    return {
      ...fetch,
      type: 'html-table',
      ...(typeof rule.table === 'string' && rule.table.trim() ? { table: rule.table.trim() } : {}),
      columns: normalizeColumns(rule.columns),
      ...(rule.transpose === true ? { transpose: true } : {}),
      ...(typeof rule.modelRow === 'string' && rule.modelRow.trim() ? { modelRow: rule.modelRow.trim() } : {}),
      ...(Object.keys(rows).length ? { rows } : {}),
      ...(typeof rule.variant === 'string' && rule.variant.trim() ? { variant: rule.variant.trim() } : {}),
    };
  }
  if (rule.type === 'markdown-table') {
    return {
      ...fetch,
      type: 'markdown-table',
      ...(typeof rule.header === 'string' && rule.header.trim() ? { header: rule.header.trim() } : {}),
      columns: normalizeColumns(rule.columns),
    };
  }
  if (rule.type === 'script-table') {
    return { ...fetch, type: 'script-table', columns: normalizeColumns(rule.columns) };
  }
  return undefined;
}

function sameRule(a: ModelPriceRule | undefined, b: ModelPriceRule | undefined): boolean {
  if (!a || !b) return false;
  return JSON.stringify(normalizeRule(a)) === JSON.stringify(normalizeRule(b));
}

/** 把仍是上一版内置值的规则/地址换成当前内置值；返回是否有改动。 */
function upgradeVendorDefaults(vendors: ModelPriceVendor[]): boolean {
  let changed = false;
  for (const vendor of vendors) {
    const previous = PREVIOUS_DEFAULTS[vendor.id];
    const next = DEFAULT_VENDORS.find((item) => item.id === vendor.id);
    if (!previous || !next) continue;
    if (next.source !== previous.source && vendor.source === previous.source) {
      vendor.source = next.source;
      changed = true;
    }
    if (next.rule && sameRule(vendor.rule, previous.rule)) {
      vendor.rule = structuredClone(next.rule);
      changed = true;
    }
  }
  return changed;
}

function normalizeVendor(raw: unknown): ModelPriceVendor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const label = typeof item.label === 'string' ? item.label.trim() : '';
  const source = typeof item.source === 'string' ? item.source.trim() : '';
  if (!id || !label || !source) return undefined;
  const models = Array.isArray(item.models)
    ? item.models.map(normalizeEntry).filter((entry): entry is ModelPriceEntry => !!entry)
    : [];
  const rule = normalizeRule(item.rule);
  return {
    id,
    label,
    source,
    ...(rule ? { rule } : {}),
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    models,
  };
}

/** 读价格表；文件不存在时用内置表初始化并落盘。 */
export function loadModelPrices(home: string): void {
  currentHome = home;
  const file = priceFileFor(home);
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { vendors?: unknown };
      const vendors = Array.isArray(data.vendors)
        ? data.vendors.map(normalizeVendor).filter((vendor): vendor is ModelPriceVendor => !!vendor)
        : [];
      if (vendors.length) {
        current = { version: 1, vendors };
        if (upgradeVendorDefaults(current.vendors)) saveModelPrices();
        return;
      }
      console.warn('[tandem] 价格表为空，按内置表重建');
    } catch (err) {
      console.warn(`[tandem] 无法解析价格表 ${file}，按内置表重建：`, (err as Error).message);
    }
  }
  current = { version: 1, vendors: structuredClone(DEFAULT_VENDORS) };
  saveModelPrices();
}

/** 当前价格表（副本）；带上文件位置供设置页显示。 */
export function modelPriceTable(): ModelPriceTable {
  return {
    version: current.version,
    vendors: structuredClone(current.vendors),
    ...(currentHome ? { file: priceFileFor(currentHome) } : {}),
  };
}

function saveModelPrices(): void {
  if (!currentHome) return;
  const file = priceFileFor(currentHome);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: current.version, vendors: current.vendors }, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    console.error('[tandem] 保存价格表失败：', (err as Error).message);
  }
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 改厂商的定价页地址与解析规则（不重算已记账的花费）。 */
export function updateVendorConfig(
  id: string,
  patch: { source?: string; rule?: unknown },
): ModelPriceVendor | undefined {
  const vendor = current.vendors.find((item) => item.id === id);
  if (!vendor) return undefined;
  const source = typeof patch.source === 'string' ? patch.source.trim() : '';
  if (source) vendor.source = source;
  if (patch.rule !== undefined) {
    const rule = normalizeRule(patch.rule);
    if (rule) vendor.rule = rule;
    else delete vendor.rule;
  }
  saveModelPrices();
  return structuredClone(vendor);
}

/** 写入刷新后的价格（用户在预览里确认后调用）。 */
export function applyVendorPrices(id: string, models: unknown): ModelPriceVendor | undefined {
  const vendor = current.vendors.find((item) => item.id === id);
  if (!vendor || !Array.isArray(models)) return undefined;
  const entries = models.map(normalizeEntry).filter((entry): entry is ModelPriceEntry => !!entry);
  if (!entries.length) return undefined;
  vendor.models = mergeVendorModels(vendor, entries);
  vendor.updatedAt = today();
  saveModelPrices();
  return structuredClone(vendor);
}

/**
 * 合并刷新结果：只覆盖解析结果里出现的字段，`cacheWrite1h` / `longPrompt` 等页面没解析到的
 * 字段保留原值；页面没出现的旧型号整体保留，避免旧会话所用型号突然变成未知单价。
 */
function mergeVendorModels(vendor: ModelPriceVendor, entries: ModelPriceEntry[]): ModelPriceEntry[] {
  const merged = vendor.models.map((entry) => ({ ...entry }));
  for (const entry of entries) {
    const index = merged.findIndex((item) => item.model === entry.model);
    if (index >= 0) merged[index] = { ...merged[index]!, ...entry };
    else merged.push(entry);
  }
  return merged;
}

/** 去掉供应商前缀后的小写模型名，兼容 openrouter 的 "vendor/model" 写法。 */
export function normalizeModel(model: string): string {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/** 同一型号的允许写法：原名、去掉日期后缀（-YYYYMMDD / @YYYYMMDD）、去掉 -latest。 */
export function modelNameVariants(model: string): string[] {
  const name = normalizeModel(model);
  if (!name) return [];
  const out = [name];
  const noDate = name.replace(/[-@]\d{8}$/, '');
  if (noDate !== name) out.push(noDate);
  const noLatest = name.replace(/-latest$/, '');
  if (noLatest !== name) out.push(noLatest);
  return [...new Set(out)];
}

/** 官方价：只认完全相同的型号名，或同一型号加日期 / `-latest` 后缀；不按前缀借价。 */
export function officialPriceFor(model: string): { vendor: string; price: Price } | undefined {
  for (const name of modelNameVariants(model)) {
    const hit = findEntry(name);
    if (hit) return { vendor: hit.vendor.id, price: toPrice(hit.entry) };
  }
  return undefined;
}

function findEntry(name: string): { vendor: ModelPriceVendor; entry: ModelPriceEntry } | undefined {
  for (const vendor of current.vendors) {
    const entry = vendor.models.find((item) => item.model === name);
    if (entry) return { vendor, entry };
  }
  return undefined;
}

/** 表里的条目转成计价用的单价（含分段价）。 */
export function toPrice(entry: ModelPriceEntry): Price {
  const price: Price = withoutModel(entry);
  if (entry.longPrompt) price.longPrompt = { threshold: entry.longPrompt.threshold, rates: entry.longPrompt.rates };
  return price;
}

type HtmlTableRule = Extract<ModelPriceRule, { type: 'html-table' }>;
type MarkdownTableRule = Extract<ModelPriceRule, { type: 'markdown-table' }>;
type ScriptTableRule = Extract<ModelPriceRule, { type: 'script-table' }>;

/** llms-full.txt 这类整站合并在读到停止标记前最多读这么多。 */
const MAX_SCAN_BYTES = 16_000_000;

/** 按厂商配置抓取定价页并解析出新价格（不写入）。失败时抛出可读原因。 */
export async function refreshVendorPrices(id: string): Promise<ModelPricePreview> {
  const vendor = current.vendors.find((item) => item.id === id);
  if (!vendor) throw new Error('厂商不存在');
  const rule = vendor.rule ?? { type: 'json' as const, path: 'models' };
  const fetchUrl = rule.url || vendor.source;
  let text: string;
  try {
    const res = await fetch(fetchUrl, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json,text/html,text/plain,*/*' },
      // llms-full.txt 是整站合并的大文件，读到停止标记为止，给足时间。
      signal: AbortSignal.timeout(rule.until ? 30_000 : 15_000),
    });
    if (!res.ok) throw new Error(`请求失败：HTTP ${res.status}`);
    text = await readFetched(res, rule.until);
  } catch (err) {
    const message = (err as Error).message || '网络错误';
    if (/abort|timeout/i.test(message)) throw new Error('请求失败：超时');
    throw new Error(message.startsWith('请求失败') ? message : `请求失败：${message}`);
  }
  if (rule.until && !text.includes(rule.until)) {
    throw new Error(`没有读到预期内容（${rule.until}）；页面可能改版、被拦截或返回了网页`);
  }
  if (rule.type === 'markdown-table' && /^\s*<(!doctype\b|html\b)/i.test(text)) {
    throw new Error('抓取地址返回的是网页（客户端渲染），没有可直接解析的文本表格');
  }
  const models =
    rule.type === 'json'
      ? parseJson(text, rule.path)
      : rule.type === 'markdown-table'
        ? parseMarkdownTable(text, rule)
        : rule.type === 'script-table'
          ? parseScriptTable(text, rule)
          : parseHtmlTable(text, rule);
  if (!models.length) throw new Error('解析结果为空，请检查解析规则');
  // 预览按合并后的结果给差异：解析规则没覆盖的字段沿用旧值，确认后写入的就是这份结果。
  const merged = mergeVendorModels(vendor, models);
  return { vendorId: vendor.id, source: vendor.source, fetchedAt: Date.now(), changes: diffVendor(vendor, merged), models: merged };
}

/** 读到 `until` 就停止并取消读取；没有 `until` 时读完整响应。 */
async function readFetched(res: Awaited<ReturnType<typeof fetch>>, until?: string): Promise<string> {
  if (!until || !res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes(until)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= MAX_SCAN_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

function parseJson(text: string, rulePath?: string): ModelPriceEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('响应不是有效的 JSON');
  }
  let list: unknown = data;
  for (const key of (rulePath || '').split('.').filter(Boolean)) {
    if (!list || typeof list !== 'object') return [];
    list = (list as Record<string, unknown>)[key];
  }
  if (!Array.isArray(list)) throw new Error('响应里没有价格数组，请检查解析规则');
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const raw = item as Record<string, unknown>;
      return normalizeEntry({
        model: raw.model ?? raw.id,
        input: raw.input,
        output: raw.output,
        cacheRead: raw.cacheRead,
        cacheWrite5m: raw.cacheWrite5m ?? raw.cacheWrite,
        cacheWrite1h: raw.cacheWrite1h,
      });
    })
    .filter((entry): entry is ModelPriceEntry => !!entry);
}

/** 在 HTML 里按规则（table 选择器 + 列下标）解析价格行；单价单元格可写成 "$x / MTok"。 */
function parseHtmlTable(text: string, rule: HtmlTableRule): ModelPriceEntry[] {
  const table = findTable(text, rule.table);
  if (!table) throw new Error(`没有找到价格表格（${rule.table ?? 'table'}）`);
  if (rule.transpose) return parseTransposedTable(table, rule);
  const columns = rule.columns ?? {};
  const out: ModelPriceEntry[] = [];
  for (const row of table.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...row[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((cell) => plainText(cell[0]));
    const model = cells[columns.model ?? 0] ?? '';
    if (!model || !/^[A-Za-z][\w.\-/:]*$/.test(model)) continue;
    const entry = normalizeEntry({ model, ...ratesFromCells(cells, columns) });
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * 转置表：型号是列、价格项是行。先把 colspan/rowspan 展开成完整网格，
 * 再按 `rows` 的行文字取每个价格项；同一项有多行时用 `variant` 选（如 PEAK）。
 */
function parseTransposedTable(table: string, rule: HtmlTableRule): ModelPriceEntry[] {
  const grid = tableGrid(table);
  const marker = (rule.modelRow ?? 'MODEL').toLowerCase();
  let headerIndex = -1;
  let markerIndex = -1;
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const index = row.findIndex((cell) => cell.trim().toLowerCase() === marker);
    if (index >= 0 && row.slice(index + 1).some((cell) => isModelName(cell))) {
      headerIndex = i;
      markerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) throw new Error(`没有找到型号行（${rule.modelRow ?? 'MODEL'}）`);
  const header = grid[headerIndex] ?? [];
  const modelColumns: Array<{ column: number; model: string }> = [];
  for (let column = markerIndex + 1; column < header.length; column++) {
    const model = (header[column] ?? '').trim();
    if (!model || !isModelName(model) || model.toLowerCase() === marker) continue;
    if (modelColumns.some((item) => item.model === model.toLowerCase())) continue;
    modelColumns.push({ column, model: model.toLowerCase() });
  }
  if (!modelColumns.length) throw new Error('型号行里没有型号名');
  const labels = rule.rows ?? {};
  const rates = new Map<string, Partial<UnitPrice>>();
  for (const row of grid) {
    if (!row) continue;
    const hasVariant = !rule.variant || row.some((cell) => cell.trim().toLowerCase() === rule.variant!.toLowerCase());
    if (!hasVariant) continue;
    for (const key of ROW_KEYS) {
      const label = labels[key];
      if (!label || !row.some((cell) => cell.toLowerCase().includes(label.toLowerCase()))) continue;
      for (const { column, model } of modelColumns) {
        const value = priceOf(row[column]);
        if (value === undefined) continue;
        const currentRates = rates.get(model) ?? {};
        if (key === 'cacheWrite') currentRates.cacheWrite5m = value;
        else if (key === 'cacheWrite1h') currentRates.cacheWrite1h = value;
        else currentRates[key] = value;
        rates.set(model, currentRates);
      }
    }
  }
  return [...rates].map(([model, values]) => normalizeEntry({ model, ...values })).filter((entry): entry is ModelPriceEntry => !!entry);
}

/** 展开 colspan / rowspan 后的单元格网格；同一格的合并区域都填上该格文字。 */
function tableGrid(table: string): string[][] {
  const grid: string[][] = [];
  const occupied = new Set<string>();
  let rowIndex = 0;
  for (const row of table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    let column = 0;
    for (const cell of row[0].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      while (occupied.has(`${rowIndex},${column}`)) column++;
      const attrs = cell[1] ?? '';
      const colspan = Math.max(1, Number(attrs.match(/colspan=["']?(\d+)/i)?.[1] ?? 1));
      const rowspan = Math.max(1, Number(attrs.match(/rowspan=["']?(\d+)/i)?.[1] ?? 1));
      const value = plainText(cell[2] ?? '');
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          const r = rowIndex + dr;
          const c = column + dc;
          grid[r] = grid[r] ?? [];
          grid[r]![c] = value;
          occupied.add(`${r},${c}`);
        }
      }
      column += colspan;
    }
    rowIndex++;
  }
  return grid;
}

/** Markdown 表格：按表头文字选表，行里的「over N tokens」档合并为该型号的 longPrompt。 */
function parseMarkdownTable(text: string, rule: MarkdownTableRule): ModelPriceEntry[] {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith('|')) continue;
    if (rule.header && !line.toLowerCase().includes(rule.header.toLowerCase())) continue;
    const next = lines[i + 1] ?? '';
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(next) || !next.includes('-')) continue;
    start = i;
    break;
  }
  if (start < 0) throw new Error(`没有找到 Markdown 价格表格${rule.header ? `（表头含「${rule.header}」）` : ''}`);
  const rows = new Map<string, ModelPriceEntry>();
  const longs = new Map<string, { threshold: number; rates: Partial<UnitPrice> }>();
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith('|')) break;
    const cells = splitMarkdownRow(line);
    const rawLabel = cells[rule.columns.model ?? 0] ?? '';
    if (!rawLabel || cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))) continue;
    const label = markdownText(rawLabel);
    const model = markdownModelName(label);
    if (!model) continue;
    const values = ratesFromCells(cells, rule.columns);
    const tier = label.match(/over\s+([\d,]+)\s+tokens?/i);
    const threshold = tier ? Number(tier[1]!.replace(/,/g, '')) : Number.NaN;
    if (Number.isFinite(threshold)) {
      longs.set(model, { threshold, rates: values });
      continue;
    }
    const entry = normalizeEntry({ model, ...values });
    if (entry) rows.set(model, entry);
  }
  for (const [model, long] of longs) {
    if (long.rates.input === undefined || long.rates.output === undefined) continue;
    const longRates = long.rates as UnitPrice;
    const entry = rows.get(model);
    if (entry) entry.longPrompt = { threshold: long.threshold, rates: longRates };
    else {
      // 只有高价档时仍记成分段价，避免把它当成所有请求的单价。
      const base = normalizeEntry({ model, ...longRates });
      if (base) rows.set(model, { ...base, longPrompt: { threshold: long.threshold, rates: longRates } });
    }
  }
  return [...rows.values()];
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function markdownText(cell: string): string {
  return cell
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Claude Sonnet 4.5 (for prompts up to …)" → "claude-sonnet-4-5"。 */
function markdownModelName(label: string): string {
  const name = label.split('(')[0]!.trim();
  if (!/^[A-Za-z]/.test(name)) return '';
  return name
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/** 页面脚本里以 `rows:[[…]]` 内嵌的表格（Mintlify DocTable）：取每行里的型号与单价字面量。 */
function parseScriptTable(text: string, rule: ScriptTableRule): ModelPriceEntry[] {
  const rows = new Map<string, ModelPriceEntry>();
  for (const payload of embeddedRows(text)) {
    for (const element of splitTopLevel(payload, ',')) {
      if (!element.trim().startsWith('[')) continue;
      const cells: string[] = [];
      for (const match of element.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)) {
        const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        if (!value || value.startsWith('/')) continue;
        if (isScriptModelToken(value) || isPriceText(value)) cells.push(value);
      }
      if (cells.length < 2 || !isScriptModelToken(cells[0]!)) continue;
      const entry = normalizeEntry({ model: cells[0]!, ...ratesFromCells(cells, rule.columns) });
      if (entry) rows.set(entry.model, entry);
    }
  }
  if (!rows.size) throw new Error('没有解析到价格行，请检查解析规则');
  return [...rows.values()];
}

/** 找出页面脚本里所有 `rows:[…]` 数组的内容。 */
function embeddedRows(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/rows:\s*\[/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBracket(text, open);
    if (close > open) out.push(text.slice(open + 1, close));
  }
  return out;
}

function matchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (!depth) return i;
    }
  }
  return -1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth--;
    else if (ch === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function isScriptModelToken(value: string): boolean {
  return /^[A-Za-z][\w.-]*$/.test(value) && !isPriceText(value);
}

function isPriceText(value: string): boolean {
  return /^[\$\u00a5]\s*[\d.,]+/.test(value);
}

function isModelName(value: string): boolean {
  return /^[A-Za-z][\w.\-/:]*$/.test(value);
}

/** 按列映射从单元格里取单价（cacheWrite 指 5m）。 */
function ratesFromCells(cells: string[], columns: ModelPriceColumns): Partial<UnitPrice> {
  const rates: Partial<UnitPrice> = {};
  for (const key of COLUMN_KEYS) {
    if (key === 'model') continue;
    const index = columns[key];
    if (index === undefined) continue;
    const value = priceOf(cells[index]);
    if (value === undefined) continue;
    if (key === 'cacheWrite') rates.cacheWrite5m = value;
    else if (key === 'cacheWrite1h') rates.cacheWrite1h = value;
    else rates[key] = value;
  }
  return rates;
}

/** 只接受 table 选择器：`table`、`table#id`、`#id`、`table.class`。 */
function findTable(text: string, selector?: string): string | undefined {
  const value = (selector ?? 'table').trim();
  const id = value.match(/#([\w-]+)/)?.[1];
  const cls = value.match(/\.([\w-]+)/)?.[1];
  for (const match of text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const open = match[0].slice(0, match[0].indexOf('>') + 1);
    if (id && !new RegExp(`\\bid=["']${id}["']`).test(open)) continue;
    if (cls && !new RegExp(`\\bclass=["'][^"']*\\b${cls}\\b`).test(open)) continue;
    return match[0];
  }
  return undefined;
}

function plainText(html: string): string {
  return html
    // sup 是脚注编号（如 deepseek-flash<sup>(1)</sup>），不能混进型号名。
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function priceOf(cell: string | undefined): number | undefined {
  if (!cell) return undefined;
  const match = cell.replace(/,/g, '').match(/\$?\s*([\d]+(?:\.[\d]+)?)/);
  return match ? Number(match[1]) : undefined;
}

const PRICE_FIELDS: Array<keyof UnitPrice> = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

function diffVendor(vendor: ModelPriceVendor, next: ModelPriceEntry[]): ModelPriceChange[] {
  const changes: ModelPriceChange[] = [];
  const before = new Map(vendor.models.map((entry) => [entry.model, entry]));
  const after = new Map(next.map((entry) => [entry.model, entry]));
  for (const [model, entry] of after) {
    const prev = before.get(model);
    if (!prev) {
      changes.push({ model, status: 'added', after: entry, fields: PRICE_FIELDS.filter((key) => entry[key] !== undefined).map(String) });
      continue;
    }
    const fields = PRICE_FIELDS.filter((key) => prev[key] !== entry[key]).map(String);
    const longChanged = stableJson(prev.longPrompt ?? null) !== stableJson(entry.longPrompt ?? null);
    if (fields.length || longChanged) {
      changes.push({ model, status: 'changed', before: prev, after: entry, fields: longChanged ? [...fields, 'longPrompt'] : fields });
    }
  }
  return changes;
}

/** 与键顺序无关的 JSON（比较分段价时，解析顺序不同不算调价）。 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}
