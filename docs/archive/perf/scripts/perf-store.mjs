#!/usr/bin/env node
// 测会话存储：启动加载、同步落盘、异步落盘。
import { statSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { SessionStore } from '../../../../packages/server/dist/store.js'

const home = process.env.TANDEM_HOME ?? '/tmp/tandem-perf'
let t0 = performance.now()
const store = new SessionStore(home)
const loadMs = performance.now() - t0
const file = path.join(home, 'sessions', 'long.json')
const bytes = statSync(file).size
console.log(`loadAll ${loadMs.toFixed(1)} 0`)

t0 = performance.now()
store.saveNow('long')
console.log(`saveNowLong ${(performance.now() - t0).toFixed(1)} ${bytes}`)

t0 = performance.now()
store.saveNow('long')
console.log(`saveNowLongAgain ${(performance.now() - t0).toFixed(1)} ${bytes}`)

t0 = performance.now()
await store.write('long')
console.log(`writeAsyncLong ${(performance.now() - t0).toFixed(1)} ${bytes}`)
