// 官方价格表：型号匹配与刷新合并写入（非验收用例）。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyVendorPrices,
  loadModelPrices,
  modelPriceTable,
  officialPriceFor,
  refreshVendorPrices,
  updateVendorConfig,
} from '../src/model-prices.js';

async function withHome(fn: (home: string) => Promise<void> | void) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-model-prices-'));
  try {
    loadModelPrices(home);
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const anthropicModel = (model: string) =>
  modelPriceTable().vendors.find((vendor) => vendor.id === 'anthropic')?.models.find((entry) => entry.model === model);

test('型号匹配：只接受同名、日期后缀与 -latest，不按前缀借价', () =>
  withHome(() => {
    assert.equal(officialPriceFor('gpt-4.5'), undefined);
    assert.equal(officialPriceFor('claude-opus-5-6'), undefined);
    assert.equal(officialPriceFor('claude-opus-4-5-20251101')?.price.input, 5);
    assert.equal(officialPriceFor('claude-opus-4-5@20251101')?.price.input, 5);
    assert.equal(officialPriceFor('claude-opus-4-5-latest')?.price.input, 5);
  }));

test('刷新写入合并：解析结果没覆盖的缓存价与分段价保留旧值', () =>
  withHome(() => {
    applyVendorPrices('anthropic', [{ model: 'claude-opus-4-5', input: 6, output: 30 }]);
    assert.deepEqual(anthropicModel('claude-opus-4-5'), {
      model: 'claude-opus-4-5',
      input: 6,
      output: 30,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
    });

    applyVendorPrices('anthropic', [{ model: 'claude-haiku-5-5', input: 0.2, output: 1 }]);
    const haiku = anthropicModel('claude-haiku-5-5');
    assert.equal(haiku?.input, 0.2);
    assert.equal(haiku?.longPrompt?.threshold, 100_000);
    assert.equal(haiku?.longPrompt?.rates.cacheRead, 0.05);
  }));

test('刷新预览按合并结果显示差异', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        models: [{ id: 'claude-opus-4-5', input: 6, output: 30 }],
      }),
    );
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  try {
    await withHome(async () => {
      updateVendorConfig('anthropic', {
        source: `http://127.0.0.1:${port}/pricing`,
        rule: { type: 'json', path: 'models' },
      });
      const preview = await refreshVendorPrices('anthropic');
      const change = preview.changes.find((item) => item.model === 'claude-opus-4-5');
      assert.ok(change, '预览没有列出变更型号');
      assert.equal(change.after?.input, 6);
      assert.equal(change.after?.cacheWrite1h, 10, '预览差异丢掉了未解析字段');
      assert.deepEqual(change.fields, ['input', 'output']);
      const opus = preview.models.find((item) => item.model === 'claude-opus-4-5');
      assert.equal(opus?.cacheRead, 0.5);
    });
  } finally {
    server.close();
  }
});

const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name);

/** 用本地服务器提供真实页面片段，把厂商的抓取地址换过去（规则本身用内置默认值）。 */
async function withFixture(file: string, fn: (url: string) => Promise<void>) {
  const body = readFileSync(file);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': file.endsWith('.md') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  try {
    await fn(`http://127.0.0.1:${port}/pricing`);
  } finally {
    server.close();
  }
}

function useDefaultRule(id: string, url: string) {
  const rule = modelPriceTable().vendors.find((vendor) => vendor.id === id)?.rule;
  assert.ok(rule, `内置规则缺失：${id}`);
  updateVendorConfig(id, { source: url, rule: { ...rule, url } });
}

test('默认规则解析 Anthropic 文档的 Markdown 价格表：缓存写 5m/1h、缓存读、Haiku 5.5 分段价', () =>
  withHome(async () => {
    await withFixture(fixture('anthropic-pricing.md'), async (url) => {
      useDefaultRule('anthropic', url);
      const preview = await refreshVendorPrices('anthropic');
      assert.equal(preview.changes.length, 0, `与内置表有差异：${JSON.stringify(preview.changes)}`);
      const opus = preview.models.find((entry) => entry.model === 'claude-opus-5-5');
      assert.deepEqual(opus, {
        model: 'claude-opus-5-5',
        input: 4,
        output: 20,
        cacheWrite5m: 5,
        cacheWrite1h: 8,
        cacheRead: 0.2,
      });
      const haiku = preview.models.find((entry) => entry.model === 'claude-haiku-5-5');
      assert.equal(haiku?.input, 0.1);
      assert.equal(haiku?.cacheWrite1h, 0.2);
      assert.deepEqual(haiku?.longPrompt, {
        threshold: 100_000,
        rates: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
      });
    });
  }));

test('默认规则解析 DeepSeek 转置表格：型号为列、取 PEAK 档', () =>
  withHome(async () => {
    await withFixture(fixture('deepseek-pricing.html'), async (url) => {
      useDefaultRule('deepseek', url);
      const preview = await refreshVendorPrices('deepseek');
      assert.equal(preview.changes.length, 0, `与内置表有差异：${JSON.stringify(preview.changes)}`);
      assert.deepEqual(preview.models.find((entry) => entry.model === 'deepseek-v4-pro'), {
        model: 'deepseek-v4-pro',
        input: 1.32,
        output: 3.96,
        cacheRead: 0.044,
      });
      assert.deepEqual(preview.models.find((entry) => entry.model === 'deepseek-flash'), {
        model: 'deepseek-flash',
        input: 0.3,
        output: 1.2,
        cacheRead: 0.006,
      });
    });
  }));

test('默认规则解析 GLM 的 HTML 表格', () =>
  withHome(async () => {
    await withFixture(fixture('glm-pricing.html'), async (url) => {
      useDefaultRule('glm', url);
      const preview = await refreshVendorPrices('glm');
      assert.equal(preview.changes.length, 0, `与内置表有差异：${JSON.stringify(preview.changes)}`);
      assert.deepEqual(preview.models.find((entry) => entry.model === 'glm-5.3'), {
        model: 'glm-5.3',
        input: 1.4,
        output: 4.4,
        cacheRead: 0.26,
      });
    });
  }));

test('默认规则解析 Kimi 页面脚本里内嵌的表格：K3 有缓存写 5m/1h，K2 只有缓存读', () =>
  withHome(async () => {
    await withFixture(fixture('kimi-pricing.html'), async (url) => {
      useDefaultRule('kimi', url);
      const preview = await refreshVendorPrices('kimi');
      assert.deepEqual(
        preview.changes.map((change) => [change.status, change.model]),
        [
          ['added', 'kimi-k3.1-pro'],
          ['added', 'kimi-k3.1-pro-highspeed'],
          ['added', 'kimi-k3'],
          ['added', 'kimi-k2.7-code'],
          ['added', 'kimi-k2.7-code-highspeed'],
          ['added', 'kimi-k2.6'],
        ],
      );
      assert.deepEqual(preview.models.find((entry) => entry.model === 'kimi-k3.1-pro'), {
        model: 'kimi-k3.1-pro',
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite5m: 2,
        cacheWrite1h: 4,
      });
      assert.deepEqual(preview.models.find((entry) => entry.model === 'kimi-k2.6'), {
        model: 'kimi-k2.6',
        input: 0.95,
        output: 4,
        cacheRead: 0.16,
      });
    });
  }));

test('已有数据文件里未改过的旧内置规则自动升级，用户改过的规则不动', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-model-prices-upgrade-'));
  try {
    writeFileSync(
      path.join(home, 'model-prices.json'),
      JSON.stringify({
        version: 1,
        vendors: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            source: 'https://platform.claude.com/docs/en/about-claude/pricing',
            rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } },
            models: [{ model: 'claude-opus-5-5', input: 4, output: 20 }],
          },
          {
            id: 'deepseek',
            label: 'DeepSeek',
            source: 'https://api-docs.deepseek.com/quick_start/pricing',
            rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, cacheRead: 2, output: 3 } },
            models: [{ model: 'deepseek-v4-pro', input: 1.32, output: 3.96 }],
          },
          {
            id: 'kimi',
            label: 'Kimi（Moonshot）',
            source: 'https://platform.moonshot.cn/docs/pricing/chat',
            rule: { type: 'html-table', table: 'table', columns: { model: 0, input: 1, output: 2 } },
            models: [{ model: 'kimi-k2', input: 0.6, output: 2.5 }],
          },
          {
            id: 'glm',
            label: 'Z.AI GLM',
            source: 'https://docs.z.ai/guides/overview/pricing',
            rule: { type: 'html-table', table: '#custom', columns: { model: 0, input: 1 } },
            models: [{ model: 'glm-5.3', input: 1.4, output: 4.4 }],
          },
        ],
      }),
    );
    loadModelPrices(home);
    const vendors = modelPriceTable().vendors;
    assert.equal(vendors.find((vendor) => vendor.id === 'anthropic')?.rule?.type, 'markdown-table');
    assert.equal(vendors.find((vendor) => vendor.id === 'deepseek')?.rule?.type, 'html-table');
    assert.equal(vendors.find((vendor) => vendor.id === 'deepseek')?.rule?.transpose, true);
    const kimiVendor = vendors.find((vendor) => vendor.id === 'kimi');
    assert.equal(kimiVendor?.source, 'https://platform.moonshot.ai/docs/pricing/chat');
    assert.equal(kimiVendor?.rule?.type, 'script-table');
    // 用户改过的规则原样保留。
    assert.deepEqual(vendors.find((vendor) => vendor.id === 'glm')?.rule, {
      type: 'html-table',
      table: '#custom',
      columns: { model: 0, input: 1 },
    });
    // 升级结果已落盘，下次启动不会又退回旧规则。
    const saved = JSON.parse(readFileSync(path.join(home, 'model-prices.json'), 'utf8')) as {
      vendors: Array<{ id: string; source: string; rule?: { type?: string } }>;
    };
    assert.equal(saved.vendors.find((vendor) => vendor.id === 'anthropic')?.rule?.type, 'markdown-table');
    assert.equal(saved.vendors.find((vendor) => vendor.id === 'kimi')?.source, 'https://platform.moonshot.ai/docs/pricing/chat');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
