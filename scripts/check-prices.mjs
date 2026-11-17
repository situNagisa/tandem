#!/usr/bin/env node
// 手动核对内置单价表：抓取官方定价页、解析表格，与 packages/server/src/usage.ts 的
// BUILTIN_PRICES 逐项比对。不接入 check.mjs 默认流程，价格更新时运行：
//   npm run check-prices
// 有差异退出码 1；抓不到的页面单独提示（站点反爬/改版时按提示人工核对）。
import { BUILTIN_PRICES } from '../packages/server/src/usage.ts';

const UA = 'tandem-check-prices/1.0 (+https://localhost)';

function stripTags(text) {
  return text
    .replace(/<sup[\s\S]*?<\/sup>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(text) {
  const match = text.replace(/,/g, '').match(/\$?\s*([\d]+(?:\.[\d]+)?)/);
  return match ? Number(match[1]) : undefined;
}

/** 只接受与内置表条目同名的型号（官方页给的是完整 id，不做前缀借价）。 */
function builtinFor(name) {
  return BUILTIN_PRICES.find((entry) => entry.prefix === name);
}

const FIELDS = [
  ['input', '输入'],
  ['output', '输出'],
  ['cacheRead', '缓存读'],
  ['cacheWrite5m', '缓存写5m'],
  ['cacheWrite1h', '缓存写1h'],
];

function compare(rows, source) {
  let differences = 0;
  for (const row of rows) {
    const builtin = builtinFor(row.model);
    if (!builtin) {
      console.log(`[未收录] ${source} 页面有 ${row.model}，内置表没有`);
      differences += 1;
      continue;
    }
    const ours = row.tier === 'long' ? builtin.price.longPrompt?.rates : builtin.price;
    if (!ours) {
      console.log(`[缺分段] ${row.model}：页面有 ${row.tier} 档，内置表没有`);
      differences += 1;
      continue;
    }
    for (const [field, label] of FIELDS) {
      const official = row[field];
      if (official === undefined) continue;
      const mine = ours[field];
      if (mine === undefined || Math.abs(mine - official) > 1e-6) {
        console.log(
          `[差异] ${row.model}${row.tier === 'long' ? '（长提示档）' : ''} ${label}：内置 ${mine ?? '未收录'} / 官方 ${official}`,
        );
        differences += 1;
      }
    }
  }
  console.log(`${source}：${rows.length} 行，差异 ${differences} 项`);
  return differences;
}

async function getText(url, stopAt) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/plain,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!stopAt || !res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes(stopAt)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/** Anthropic 定价表在 docs 的 llms-full.txt 里以 Markdown 表格给出，按行解析后提前断开。 */
async function checkAnthropic() {
  const marker = 'All other models use the standard 0.1x multiplier';
  const text = await getText('https://platform.claude.com/llms-full.txt', marker);
  // 文档里有多张表：找表头含「5m cache writes」的那一张。
  let start = -1;
  for (let at = text.indexOf('| Model'); at >= 0; at = text.indexOf('| Model', at + 1)) {
    if (text.slice(at, at + 500).includes('5m cache writes')) {
      start = at;
      break;
    }
  }
  if (start < 0) throw new Error('没有找到价格表（页面格式可能变了）');
  const rows = [];
  for (const line of text.slice(start).split('\n')) {
    if (!line.trim().startsWith('|')) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6 || /^-+$/.test(cells[0].replace(/[:\s]/g, ''))) continue;
    const label = stripTags(cells[0]);
    if (!/^Claude /i.test(label)) continue;
    const tier = /over 100,000/i.test(label) ? 'long' : 'short';
    const model = label
      .split('(')[0]
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/\./g, '-');
    const parsed = {
      model,
      tier,
      input: money(cells[1]),
      cacheWrite5m: money(cells[2]),
      cacheWrite1h: money(cells[3]),
      cacheRead: money(cells[4]),
      output: money(cells[5]),
    };
    // Haiku 5.5 的两档合并成一行比较：短档比 base，长档比 longPrompt。
    rows.push(parsed);
  }
  return rows;
}

/** z.ai 表格：Model | Input | Cached Input | Cached Input Storage | Output。 */
async function checkZhipu() {
  const html = await getText('https://docs.z.ai/guides/overview/pricing');
  const rows = [];
  for (const row of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...row[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((cell) => stripTags(cell[0]));
    if (cells.length < 5 || !/^GLM-/i.test(cells[0] ?? '')) continue;
    const model = cells[0].toLowerCase();
    const input = money(cells[1]);
    const cached = money(cells[2]);
    const output = money(cells[4]);
    if (input === undefined || output === undefined) continue;
    rows.push({ model, input, output, ...(cached !== undefined ? { cacheRead: cached } : {}) });
  }
  if (!rows.length) throw new Error('没有解析到 GLM 价格行');
  return rows;
}

/** DeepSeek 表格是转置的（模型名为列）：只取 PEAK 档。 */
async function checkDeepSeek() {
  const html = await getText('https://api-docs.deepseek.com/quick_start/pricing');
  const modelRow = html.match(/MODEL[\s\S]*?<td>\s*(deepseek-[\w.-]+)[\s\S]*?<td>\s*(deepseek-[\w.-]+)\s*<\/td>/i);
  if (!modelRow) throw new Error('没有解析到模型名');
  const models = [modelRow[1], modelRow[2]];
  const peak = (label) => {
    const index = html.indexOf(label);
    if (index < 0) return undefined;
    const row = html.slice(index).match(/(?<!OFF-)PEAK<\/td>[\s\S]*?<\/tr>/i);
    if (!row) return undefined;
    const prices = [...row[0].matchAll(/\$\s*([\d.]+)/g)].map((match) => Number(match[1]));
    return prices.length >= 2 ? prices : undefined;
  };
  const hit = peak('CACHE HIT');
  const miss = peak('CACHE MISS');
  const output = peak('1M OUTPUT TOKENS');
  if (!miss || !output) throw new Error('没有解析到价格行');
  return models.map((model, index) => ({
    model,
    input: miss[index],
    output: output[index],
    ...(hit ? { cacheRead: hit[index] } : {}),
  }));
}

const sources = [
  ['Anthropic', checkAnthropic],
  ['OpenAI', async () => {
    // developers.openai.com 对脚本请求返回 403；这里仅确认可达性，失败时人工看页面。
    const text = await getText('https://developers.openai.com/api/docs/pricing');
    if (!/gpt-|o3|pricing/i.test(text)) throw new Error('页面没有价格内容');
    throw new Error('页面有反爬拦截，无法解析；请人工核对（gpt-6-* 见 Standard 档）');
  }],
  ['Google Gemini', async () => {
    const text = await getText('https://ai.google.dev/gemini-api/docs/pricing');
    if (!/Gemini/i.test(text)) throw new Error('页面没有价格内容');
    throw new Error('页面结构与脚本不匹配，请人工核对');
  }],
  ['DeepSeek', checkDeepSeek],
  ['Z.AI GLM', checkZhipu],
];

let total = 0;
for (const [name, run] of sources) {
  try {
    const rows = await run();
    total += compare(rows, name);
  } catch (err) {
    console.warn(`[跳过] ${name}：${err.message}`);
  }
}
if (total > 0) {
  console.log(`\n共 ${total} 项差异，请按官方页更新 packages/server/src/usage.ts（表头写来源与核对日期）。`);
  process.exitCode = 1;
} else {
  console.log('\n没有差异。');
}
