// 构建 web → 同步进 Android 工程 → gradle assembleDebug → 分发 APK。
// 跨平台：Linux / macOS / Windows 均可运行。web 构建失败时直接报错，不回退到旧代码打包。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(pkgDir, '../..')
const androidDir = path.join(pkgDir, 'android')
const apkOut = path.join(root, 'dist-apk', 'tandem-debug.apk')

/** 找 JDK：JAVA_HOME → 常见安装位置（需包含 bin/java）。 */
function findJavaHome() {
  const javaBin = (dir) => path.join(dir, 'bin', isWin ? 'java.exe' : 'java')
  if (process.env.JAVA_HOME && fs.existsSync(javaBin(process.env.JAVA_HOME))) return process.env.JAVA_HOME
  const bases = isWin
    ? ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Android\\Android Studio']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', path.join(os.homedir(), '.local')]
  for (const base of bases) {
    if (!fs.existsSync(base)) continue
    if (fs.existsSync(javaBin(path.join(base, 'jbr')))) return path.join(base, 'jbr') // Android Studio 自带 JBR
    const dirs = fs.readdirSync(base).filter((n) => /(jdk|java|temurin|openjdk).*(21|2[2-9])/i.test(n) || /^jdk-?21/i.test(n))
    for (const d of dirs.sort().reverse()) {
      for (const cand of [path.join(base, d), path.join(base, d, 'Contents', 'Home')]) {
        if (fs.existsSync(javaBin(cand))) return cand
      }
    }
  }
  return undefined
}

/** 找 Android SDK：ANDROID_HOME / ANDROID_SDK_ROOT → 各平台默认位置。 */
function findAndroidHome() {
  const cands = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    isWin && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : undefined,
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean)
  return cands.find((d) => fs.existsSync(path.join(d, 'platform-tools')) || fs.existsSync(path.join(d, 'platforms')))
}

const JAVA_HOME = findJavaHome()
const ANDROID_HOME = findAndroidHome()
const missing = []
if (!JAVA_HOME) missing.push('JDK 21（设置 JAVA_HOME，或安装 Temurin 21 / Android Studio）')
if (!ANDROID_HOME) missing.push('Android SDK（设置 ANDROID_HOME，或用 Android Studio 安装 SDK）')
if (missing.length) {
  console.error('缺少打包环境：\n  - ' + missing.join('\n  - ') + '\n详见 README.md「安卓 APK」。')
  process.exit(1)
}
console.log(`JAVA_HOME=${JAVA_HOME}\nANDROID_HOME=${ANDROID_HOME}`)

const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME,
  ANDROID_SDK_ROOT: ANDROID_HOME,
  PATH: [path.join(JAVA_HOME, 'bin'), process.env.PATH].join(path.delimiter),
}

/** Windows 下 npm/npx 是 .cmd，需要经 shell 启动，否则 spawn 报 ENOENT。 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: isWin, ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${r.status})`)
}

function copyToWindowsDownloads() {
  const targets = []
  if (isWin && process.env.USERPROFILE) targets.push(path.join(process.env.USERPROFILE, 'Downloads'))
  const wslUsers = '/mnt/c/Users'
  if (!isWin && fs.existsSync(wslUsers)) {
    const skip = new Set(['all users', 'default', 'default user', 'public', 'defaultapppool'])
    for (const n of fs.readdirSync(wslUsers)) {
      if (skip.has(n.toLowerCase()) || n.startsWith('.')) continue
      const d = path.join(wslUsers, n, 'Downloads')
      if (fs.existsSync(d)) targets.push(d)
    }
  }
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue
    const target = path.join(dir, 'tandem-debug.apk')
    fs.copyFileSync(apkOut, target)
    console.log(`已复制到 ${target}`)
  }
}

run('npm', ['run', 'build', '-w', '@tandem/protocol'], { cwd: root })
run('npm', ['run', 'build', '-w', '@tandem/relay'], { cwd: root })
run('npm', ['run', 'build', '-w', '@tandem/web'], { cwd: root })
const webDist = path.join(root, 'packages', 'web', 'dist')

run('npx', ['cap', 'sync', 'android'], { cwd: pkgDir, env: { ...env, TANDEM_WEB_DIR: webDist } })

const gradlew = isWin ? 'gradlew.bat' : './gradlew'
if (!isWin) fs.chmodSync(path.join(androidDir, 'gradlew'), 0o755)
run(gradlew, ['assembleDebug', '--no-daemon'], { cwd: androidDir })

const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
if (!fs.existsSync(apk)) throw new Error(`未找到 APK: ${apk}`)
fs.mkdirSync(path.dirname(apkOut), { recursive: true })
fs.copyFileSync(apk, apkOut)
console.log(`APK: ${apkOut}`)
copyToWindowsDownloads()
