// 设置 →「模型价格」：官方价格表按厂商列出、配置定价页地址与解析规则、一键刷新（先预览差异再写入）。
import type { FastifyInstance } from 'fastify';
import {
  applyVendorPrices,
  modelPriceTable,
  refreshVendorPrices,
  updateVendorConfig,
} from '../model-prices.js';
import { bad, str, type RouteDeps } from './common.js';

export function registerModelPriceRoutes(app: FastifyInstance, _deps: RouteDeps): void {
  app.get('/api/model-prices', async () => modelPriceTable());

  app.put('/api/model-prices/vendors/:id', async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? '';
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = str(body.source);
    if (source && !/^https?:\/\//i.test(source)) return bad(reply, '定价页地址需要以 http:// 或 https:// 开头');
    let rule: unknown;
    if (typeof body.rule === 'string') {
      const text = body.rule.trim();
      if (text) {
        if (text.startsWith('{')) {
          try {
            rule = JSON.parse(text);
          } catch {
            return bad(reply, '解析规则不是有效的 JSON');
          }
        } else {
          // 只写路径（如 models）时按 JSON 路径规则处理。
          rule = { type: 'json', path: text };
        }
      } else {
        rule = undefined;
      }
    } else if (body.rule && typeof body.rule === 'object') {
      rule = body.rule;
    }
    const vendor = updateVendorConfig(id, {
      ...(source ? { source } : {}),
      ...(body.rule !== undefined ? { rule } : {}),
    });
    if (!vendor) return bad(reply, '厂商不存在', 404);
    return { vendor };
  });

  app.post('/api/model-prices/vendors/:id/refresh', async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? '';
    try {
      return { preview: await refreshVendorPrices(id) };
    } catch (err) {
      const status = (err as Error).message === '厂商不存在' ? 404 : 400;
      return bad(reply, (err as Error).message || '刷新失败', status);
    }
  });

  app.post('/api/model-prices/vendors/:id/apply', async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? '';
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vendor = applyVendorPrices(id, body.models);
    if (!vendor) return bad(reply, '没有可写入的价格');
    return { vendor };
  });
}
