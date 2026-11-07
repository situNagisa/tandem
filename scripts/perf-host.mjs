#!/usr/bin/env node
// 性能测量专用 Host 包装：等价 cli 启动，并暴露 SIGUSR1 打印事件循环延迟直方图。
import { Host } from '../packages/server/dist/host.js'
import { createApp } from '../packages/server/dist/server.js'
import { loadHostConfig } from '../packages/server/dist/config.js'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const home = process.env.TANDEM_HOME ?? '/tmp/tandem-perf'
const port = Number(process.env.PORT ?? 8261)
const config = loadHostConfig(home)
const host = new Host(config, home)
const app = await createApp(host)
await app.listen({ port, host: '127.0.0.1' })

const eld = monitorEventLoopDelay({ resolution: 10 })
eld.enable()
process.on('SIGUSR1', () => {
  const ms = (v) => +(v / 1e6).toFixed(2)
  console.log(
    `ELD ${JSON.stringify({ p50: ms(eld.percentile(50)), p99: ms(eld.percentile(99)), max: ms(eld.max), mean: ms(eld.mean) })}`,
  )
  eld.reset()
})

const address = app.server.address()
const actualPort = typeof address === 'object' && address ? address.port : port
console.log(`访问: http://127.0.0.1:${actualPort}/?token=${config.token}`)
console.log(`PERF_HOST_PID ${process.pid}`)

const shutdown = async () => {
  try { await app.close() } catch {}
  host.store.flush()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
