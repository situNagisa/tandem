// 官方价格表：型号匹配与刷新合并写入（非验收用例）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

function withHome(fn: (home: string) => Promise<void> | void) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-model-prices-'));
  try {
    loadModelPrices(home);
    return Promise.resolve(fn(home));
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
