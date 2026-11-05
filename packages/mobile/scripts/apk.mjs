// 构建 web → 同步进 Android 工程 → gradle assembleDebug → 分发 APK。
// 同事可能正在改 packages/web：直接构建失败时，改用临时 worktree 里的 HEAD 版本。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(pkgDir, '../..')
const androidDir = path.join(pkgDir, 'android')
const apkOut = path.join(root, 'dist-apk/tandem-debug.apk')

const JAVA_HOME = process.env.JAVA_HOME ?? '/usr/lib/jvm/java-21-openjdk'
const ANDROID_HOME = process.env.ANDROID_HOME ?? `${process.env.HOME}/Android/Sdk`
const env = { ...process.env, JAVA_HOME, ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${r.status})`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function buildWeb() {
  for (let i = 1; i <= 3; i++) {
    try {
      run('npm', ['run', 'build', '-w', '@tandem/web'], { cwd: root })
      return path.join(root, 'packages/web/dist')
    } catch {
      if (i < 3) {
        console.log(`web 构建失败，可能同事正在改动，60s 后重试（${i}/3）`)
        await sleep(60_000)
      }
    }
  }
  console.log('web 工作区构建持续失败，改用 HEAD 版本的临时 worktree')
  const wt = '/tmp/tandem-web-head'
  if (!fs.existsSync(path.join(wt, 'package.json'))) {
    run('git', ['worktree', 'add', '--force', wt, 'HEAD'], { cwd: root })
  } else {
    run('git', ['-C', wt, 'checkout', '--force', 'HEAD'])
  }
  // 复用主仓库依赖；web 源码与 protocol 的 dist 都来自 HEAD 侧。
  if (!fs.existsSync(path.join(wt, 'node_modules'))) {
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules'))
  }
  run('npm', ['run', 'build', '-w', '@tandem/web'], { cwd: wt })
  return path.join(wt, 'packages/web/dist')
}

function copyToWindowsDownloads() {
  const users = '/mnt/c/Users'
  if (!fs.existsSync(users)) return
  const skip = new Set(['all users', 'default', 'default user', 'public', 'defaultapppool'])
  const candidates = fs
    .readdirSync(users)
    .filter((n) => !skip.has(n.toLowerCase()) && !n.startsWith('.'))
    .filter((n) => fs.existsSync(path.join(users, n, 'Downloads')))
  if (candidates.length === 0) return
  for (const name of candidates) {
    const target = path.join(users, name, 'Downloads', 'tandem-debug.apk')
    fs.copyFileSync(apkOut, target)
    console.log(`已复制到 ${target}`)
  }
}

const webDist = await buildWeb()
console.log(`使用 web 构建产物: ${webDist}`)

run('npx', ['cap', 'sync', 'android'], {
  cwd: pkgDir,
  env: { ...env, TANDEM_WEB_DIR: webDist },
})

run('./gradlew', ['assembleDebug', '--no-daemon'], { cwd: androidDir })

const apk = path.join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk')
if (!fs.existsSync(apk)) throw new Error(`未找到 APK: ${apk}`)
fs.mkdirSync(path.dirname(apkOut), { recursive: true })
fs.copyFileSync(apk, apkOut)
console.log(`APK: ${apkOut}`)
copyToWindowsDownloads()
