#!/usr/bin/env node
/**
 * 构建远端执行器 tandem-exec（Go，见 docs/features/executor.md）。
 *
 * 用法：
 *   node scripts/build-executor.mjs              构建五个平台的产物 + SHA256SUMS
 *   node scripts/build-executor.mjs --if-stale   产物缺失或源码/版本变化时才构建（check.mjs 使用）
 *   node scripts/build-executor.mjs --test       go vet + go test（主机平台）
 *
 * Go 解析顺序：PATH 上的 go（≥ 1.24）→ ~/.cache/tandem/go/go<固定版本> → 从 go.dev 下载并校验 sha256 后解压到缓存。
 * 依赖走 packages/executor/vendor，构建期间 GOPROXY=off，不联网拉模块。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXEC_DIR = path.join(ROOT, 'packages', 'executor')
const DIST = path.join(EXEC_DIR, 'dist')
const STAMP = path.join(DIST, 'SOURCE.sha256')
const CACHE = path.join(os.homedir(), '.cache', 'tandem', 'go')
const GO_PIN = '1.27.3'
const GO_MIN = [1, 24]
const TARGETS = [
  ['linux', 'amd64'],
  ['linux', 'arm64'],
  ['windows', 'amd64'],
  ['darwin', 'arm64'],
  ['darwin', 'amd64'],
]
const isWin = process.platform === 'win32'
const args = new Set(process.argv.slice(2))

function fail(message) {
  console.error(`build-executor: ${message}`)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  const child = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (child.error) fail(`无法运行 ${command}：${child.error.message}`)
  if (child.status !== 0) fail(`${command} ${commandArgs.join(' ')} 失败（退出码 ${child.status}）`)
}

function capture(command, commandArgs) {
  const child = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (child.error || child.status !== 0) return null
  return child.stdout
}

function parseVersion(text) {
  const m = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

function atLeastMin(v) {
  return v !== null && (v[0] > GO_MIN[0] || (v[0] === GO_MIN[0] && v[1] >= GO_MIN[1]))
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function installGo() {
  const hostOs = isWin ? 'windows' : process.platform
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const ext = hostOs === 'windows' ? 'zip' : 'tar.gz'
  const filename = `go${GO_PIN}.${hostOs}-${hostArch}.${ext}`
  console.log(`build-executor: 未找到 Go ≥ ${GO_MIN.join('.')}，下载 go${GO_PIN}（${hostOs}-${hostArch}）到 ${CACHE}`)
  const index = capture('curl', ['-fsSL', '--retry', '3', 'https://go.dev/dl/?mode=json'])
  if (!index) fail('无法获取 go.dev 下载列表（检查网络或代理设置）')
  const release = JSON.parse(index).find((r) => r.version === `go${GO_PIN}`)
  const entry = release?.files.find((f) => f.filename === filename)
  if (!entry) fail(`go.dev 下载列表中没有 ${filename}`)

  mkdirSync(CACHE, { recursive: true })
  const archive = path.join(CACHE, filename)
  if (!existsSync(archive) || sha256(archive) !== entry.sha256) {
    rmSync(archive, { force: true })
    run('curl', ['-fL', '--retry', '3', '-o', `${archive}.part`, `https://go.dev/dl/${filename}`])
    if (sha256(`${archive}.part`) !== entry.sha256) {
      rmSync(`${archive}.part`, { force: true })
      fail(`${filename} 的 sha256 与 go.dev 不符，已丢弃`)
    }
    renameSync(`${archive}.part`, archive)
  }

  const staging = path.join(CACHE, `extract-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  run('tar', ['-xf', archive, '-C', staging])
  const target = path.join(CACHE, `go${GO_PIN}`)
  rmSync(target, { recursive: true, force: true })
  renameSync(path.join(staging, 'go'), target)
  rmSync(staging, { recursive: true, force: true })
  return path.join(target, 'bin', isWin ? 'go.exe' : 'go')
}

function findGo() {
  if (atLeastMin(parseVersion(capture('go', ['version'])))) return 'go'
  const cached = path.join(CACHE, `go${GO_PIN}`, 'bin', isWin ? 'go.exe' : 'go')
  if (existsSync(cached)) return cached
  return installGo()
}

const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

// 源码指纹：执行器目录（不含 dist）+ 本脚本 + 版本号。变化即视为需要重建。
function sourceHash() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === EXEC_DIR && entry.name === 'dist') continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else files.push(p)
    }
  }
  walk(EXEC_DIR)
  files.push(fileURLToPath(import.meta.url))
  files.sort()
  const h = createHash('sha256')
  h.update(version)
  for (const f of files) {
    h.update(path.relative(ROOT, f))
    h.update('\0')
    h.update(readFileSync(f))
    h.update('\0')
  }
  return h.digest('hex')
}

function outputName(goos, goarch) {
  return `tandem-exec-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`
}

function isFresh(hash) {
  if (!existsSync(STAMP) || readFileSync(STAMP, 'utf8').trim() !== hash) return false
  return TARGETS.every(([goos, goarch]) => existsSync(path.join(DIST, outputName(goos, goarch))))
}

const hash = sourceHash()
if (args.has('--if-stale') && isFresh(hash)) {
  console.log('build-executor: 执行器产物已是最新，跳过')
  process.exit(0)
}

const goBin = findGo()
const goVersion = capture(goBin, ['version'])?.trim()
if (!atLeastMin(parseVersion(goVersion))) fail(`Go 版本过低：${goVersion ?? '无法运行 ' + goBin}`)
console.log(`build-executor: ${goVersion}，版本 ${version}`)

const env = {
  ...process.env,
  CGO_ENABLED: '0',
  GOTOOLCHAIN: 'local',
  GOFLAGS: '-mod=vendor',
  GOPROXY: 'off',
}

if (args.has('--test')) {
  run(goBin, ['vet', './...'], { cwd: EXEC_DIR, env })
  run(goBin, ['test', '-count=1', './...'], { cwd: EXEC_DIR, env })
  process.exit(0)
}

const ldflags = `-s -w -X tandem/executor/internal/ops.Version=${version}`
run(goBin, ['vet', './...'], { cwd: EXEC_DIR, env })

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
const sums = []
for (const [goos, goarch] of TARGETS) {
  const name = outputName(goos, goarch)
  const out = path.join(DIST, name)
  run(goBin, ['build', '-trimpath', '-buildvcs=false', '-ldflags', ldflags, '-o', out, './cmd/tandem-exec'], {
    cwd: EXEC_DIR,
    env: { ...env, GOOS: goos, GOARCH: goarch },
  })
  sums.push(`${sha256(out)}  ${name}`)
  console.log(`build-executor: ${name} ${(statSync(out).size / 1048576).toFixed(2)} MiB`)
}
writeFileSync(path.join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`)
writeFileSync(STAMP, `${hash}\n`)
console.log(`build-executor: 完成，产物在 ${path.relative(ROOT, DIST)}/`)
