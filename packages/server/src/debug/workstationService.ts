// 调试版工作站：自动创建本地测试账号，并提供仅回环可用的免密登录。
// 本模块只在调试版加载，发布构建会整体移除。
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AccountsStore } from '../accounts/store.js';
import { readJson, writePrivateFile } from '../config.js';

export const DEBUG_ACCOUNT_USERNAME = 'debug';
export const DEBUG_ACCOUNT_PASSWORD_FILE = 'debug-account.json';

interface DebugAccountFile {
  username?: string;
  password?: string;
}

/** 严格判断来源地址是否为回环（含 IPv4-mapped IPv6）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1';
}

/** 读取/生成密码文件，并确保测试账号存在；用户名被真实用户占用时返回 undefined。 */
function ensureTestAccount(
  store: AccountsStore,
  home: string,
): { username: string; password: string } | undefined {
  const file = path.join(home, DEBUG_ACCOUNT_PASSWORD_FILE);
  const saved = readJson<DebugAccountFile>(file);
  const hasSaved = typeof saved?.password === 'string' && saved.password.length >= 16;
  const password = hasSaved ? saved!.password! : randomBytes(24).toString('base64url');
  const account = store.ensureLocalAccount({
    username: DEBUG_ACCOUNT_USERNAME,
    name: '调试账号',
    password,
    debug: true,
  });
  if (!account) return undefined;
  // 文件丢失后重建密码：把新密码写回账号，保证免密登录仍可用。
  if (!hasSaved) store.updateAccount(account.id, { password }, 'debug-bootstrap');
  // writePrivateFile 会以 0600 原子写入，顺便修正历史文件的权限。
  writePrivateFile(file, JSON.stringify({ username: DEBUG_ACCOUNT_USERNAME, password }, null, 2));
  return { username: DEBUG_ACCOUNT_USERNAME, password };
}

/** 工作站启动时调用：确保测试账号存在，并注册仅调试版存在的免密登录路由。 */
export function ensureDebugWorkstation(store: AccountsStore, home: string, app: FastifyInstance): void {
  const mode = store.mode();
  if (mode !== 'none' && mode !== 'center') return;
  store.ensureWorkstationState('调试工作站');
  const credentials = ensureTestAccount(store, home);
  if (!credentials) return;
  app.post('/api/debug/auto-login', async (req, reply) => {
    // 非回环来源一律当作不存在：不暴露这个调试接口。
    if (!isLoopbackAddress(req.socket.remoteAddress)) return reply.code(404).send({ error: 'Not Found' });
    try {
      return store.login(credentials);
    } catch {
      return reply.code(404).send({ error: 'Not Found' });
    }
  });
}
