import path from 'node:path'

export const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname)
export const HOST_ENTRY = path.join(ROOT, 'packages/server/dist/cli.js')
export const DESKTOP = { width: 2552, height: 1274 }
export const MOBILE = { width: 390, height: 844 }
export const SMALL = { width: 360, height: 780 }
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}
