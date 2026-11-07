// Host 诊断：一次请求返回逐项检查结果与可复制的纯文本报告。
import type { FastifyInstance } from 'fastify';
import { runDoctor } from '../doctor.js';
import type { RouteDeps } from './common.js';

export function registerDoctorRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/doctor', async (req) => {
    const query = (req.query ?? {}) as { checks?: unknown; clientTime?: unknown };
    const checks =
      typeof query.checks === 'string'
        ? query.checks
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;
    const clientTime =
      typeof query.clientTime === 'string' || typeof query.clientTime === 'number'
        ? Number(query.clientTime)
        : undefined;
    const address = app.server.address();
    const listen =
      address && typeof address === 'object'
        ? { host: address.address, port: address.port }
        : { host: '127.0.0.1', port: 7878 };
    return runDoctor(host, {
      ...(checks && checks.length > 0 ? { checks } : {}),
      listen,
      ...(typeof clientTime === 'number' && Number.isFinite(clientTime) ? { clientTime } : {}),
    });
  });
}
