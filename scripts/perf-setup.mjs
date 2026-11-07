#!/usr/bin/env node
// 性能专项夹具：大仓库 + 长会话 + 多会话 + 外部会话。仅写 /tmp，不碰真实数据。
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = '/tmp/tandem-perf'
const REPO = path.join(ROOT, 'repo')
const HOME = path.join(ROOT, 'home')
const CONFIG = ROOT
const SESSIONS = path.join(CONFIG, 'sessions')
const PROJECTS = path.join(HOME, '.claude', 'projects', '-tmp-tandem-perf-repo')

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
}

export function setupRepo() {
  rmSync(REPO, { recursive: true, force: true })
  mkdirSync(REPO, { recursive: true })
  let n = 0
  for (let d = 0; d < 2000; d++) {
    const dir = path.join(REPO, 'pkg', `p${String(d).padStart(4, '0')}`, 'src')
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 25; f++) {
      writeFileSync(
        path.join(dir, `file${String(f).padStart(2, '0')}.ts`),
        `// pkg ${d} file ${f}\nexport const value${f} = ${d * 100 + f};\nexport function fn${f}() { return 'pkg${d}-file${f}'; }\n`,
      )
      n++
    }
  }
  // 单目录 5000 个文件：文件浏览器展开
  const flat = path.join(REPO, 'flat')
  mkdirSync(flat, { recursive: true })
  for (let i = 0; i < 5000; i++) {
    writeFileSync(path.join(flat, `flat-${String(i).padStart(4, '0')}.txt`), `flat ${i}\n`)
    n++
  }
  // 3 个 10MB 文件
  for (let i = 1; i <= 3; i++) {
    writeFileSync(path.join(REPO, `big${i}.log`), `${'x'.repeat(1023)}\n`.repeat(10240))
  }
  // node_modules：500 目录 × 10 文件
  for (let d = 0; d < 500; d++) {
    const dir = path.join(REPO, 'node_modules', `dep${String(d).padStart(3, '0')}`)
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 10; f++) {
      writeFileSync(path.join(dir, `mod${f}.js`), `module.exports = ${d * 10 + f};\n`)
      n++
    }
  }
  writeFileSync(path.join(REPO, '.gitignore'), 'node_modules/\n')
  sh(REPO, ['init', '-q'])
  sh(REPO, ['config', 'user.email', 'perf@example.com'])
  sh(REPO, ['config', 'user.name', 'perf'])
  sh(REPO, ['add', '-A'])
  sh(REPO, ['commit', '-qm', 'fixture'])
  // 3000 个已跟踪文件改动 + 1000 个未跟踪文件
  for (let d = 0; d < 1500; d++) {
    const dir = path.join(REPO, 'pkg', `p${String(d).padStart(4, '0')}`, 'src')
    for (let f = 0; f < 2; f++) {
      const file = path.join(dir, `file${String(f).padStart(2, '0')}.ts`)
      writeFileSync(file, `// changed ${d} ${f}\nexport const value${f} = ${d};\n`)
    }
  }
  const untracked = path.join(REPO, 'new')
  mkdirSync(untracked, { recursive: true })
  for (let i = 0; i < 1000; i++) {
    writeFileSync(path.join(untracked, `new-${String(i).padStart(4, '0')}.txt`), `new ${i}\n`)
  }
  // 10MB 文件追加几行 → 小 hunk；big2 整篇改写 → 大 diff
  writeFileSync(path.join(REPO, 'big1.log'), 'changed-tail\n', { flag: 'a' })
  writeFileSync(path.join(REPO, 'big2.log'), `${'y'.repeat(1023)}\n`.repeat(10240))
  return n
}

function seedSessions() {
  rmSync(SESSIONS, { recursive: true, force: true })
  mkdirSync(SESSIONS, { recursive: true })
  const now = Date.now()
  const base = (id, title) => ({
    id, title, cwd: REPO, profileId: 'mock', model: 'perf', permissionMode: 'default',
    status: 'idle', messages: [], todos: [], allowedTools: [], usage: {},
    createdAt: now - 86_400_000, updatedAt: now - 1000,
  })
  // 长会话：1000 轮，每轮一条 Bash 工具结果 30KB
  const out = `line of tool output\n`.repeat(Math.ceil(30 * 1024 / 19)).slice(0, 30 * 1024)
  const messages = []
  for (let turn = 0; turn < 1000; turn++) {
    const t = now - 3_600_000 + turn * 1000
    messages.push({
      id: `u${turn}`, role: 'user', createdAt: t,
      content: [{ type: 'text', text: `第 ${turn + 1} 轮：帮我检查构建输出并总结要点。` }],
    })
    messages.push({
      id: `a${turn}`, role: 'assistant', createdAt: t + 1, model: 'perf',
      content: [
        { type: 'text', text: `我先运行命令看看第 ${turn + 1} 轮的输出。` },
        { type: 'tool_use', id: `call-${turn}`, name: 'Bash', input: { command: `npm run build -- --turn=${turn}` } },
      ],
    })
    messages.push({
      id: `tr${turn}`, role: 'user', createdAt: t + 2,
      content: [{ type: 'tool_result', toolUseId: `call-${turn}`, content: out }],
    })
    messages.push({
      id: `af${turn}`, role: 'assistant', createdAt: t + 3, model: 'perf',
      content: [{ type: 'text', text: `第 ${turn + 1} 轮完成：构建通过。` }],
    })
  }
  const long = base('long', '长会话 · 1000 轮')
  long.messages = messages
  long.updatedAt = now
  writeFileSync(path.join(SESSIONS, 'long.json'), JSON.stringify(long))

  for (let i = 0; i < 200; i++) {
    const rec = base(`s${i}`, `会话 ${i} · 侧栏渲染`)
    rec.messages = [
      { id: `m${i}`, role: 'user', createdAt: now - i * 1000, content: [{ type: 'text', text: `会话 ${i} 的问题` }] },
      { id: `r${i}`, role: 'assistant', createdAt: now - i * 1000 + 1, content: [{ type: 'text', text: `会话 ${i} 的回答` }] },
    ]
    writeFileSync(path.join(SESSIONS, `s${i}.json`), JSON.stringify(rec))
  }
}

function seedExternal() {
  rmSync(PROJECTS, { recursive: true, force: true })
  mkdirSync(PROJECTS, { recursive: true })
  const now = Date.now()
  for (let i = 0; i < 3000; i++) {
    const lines = [
      JSON.stringify({ type: 'user', cwd: REPO, timestamp: new Date(now - i * 60_000).toISOString(), uuid: `u${i}`, message: { role: 'user', content: `外部会话 ${i}：请解释模块划分` } }),
      JSON.stringify({ type: 'assistant', cwd: REPO, timestamp: new Date(now - i * 60_000 + 1000).toISOString(), uuid: `a${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `外部会话 ${i} 的回答内容。` }] } }),
    ]
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    writeFileSync(path.join(PROJECTS, `${id}.jsonl`), lines.join('\n'))
  }
}

function seedConfig() {
  mkdirSync(CONFIG, { recursive: true })
  writeFileSync(path.join(CONFIG, 'config.json'), JSON.stringify({
    hostId: 'perf-host', token: 'perf-token', idleTimeoutSec: 180,
    resumeOnRestart: 'auto', defaultDelegation: 'less',
  }, null, 2))
  writeFileSync(path.join(CONFIG, 'profiles.json'), JSON.stringify({ profiles: [{
    id: 'mock', name: 'Mock', kind: 'openai', baseUrl: 'http://127.0.0.1:8262/v1',
    apiKey: 'perf-key', models: ['perf'], defaultModel: 'perf', createdAt: Date.now(),
  }] }, null, 2))
}

const mode = process.argv[2] ?? 'all'
if (mode === 'all') {
  const t0 = Date.now()
  const n = setupRepo()
  console.log(`repo: ${n} files, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  seedSessions()
  seedExternal()
  seedConfig()
  console.log(`fixture ready at ${ROOT}`)
} else if (mode === 'sessions') {
  seedSessions()
  console.log('sessions reseeded')
}
