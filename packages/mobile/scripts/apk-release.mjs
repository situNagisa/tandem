// 构建 web → 同步进 Android 工程 → 用本机 release keystore 签名的 assembleRelease + bundleRelease。
// 签名材料放在仓库外：~/.tandem-release/（android.keystore 与 600 权限的密码文件）。
// 密码也可以从环境变量 TANDEM_ANDROID_KEYSTORE_PASSWORD 读取；任何情况下都不写入仓库或日志。
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(pkgDir, '../..')
const androidDir = path.join(pkgDir, 'android')
const apkOut = path.join(root, 'dist-apk', 'tandem-release.apk')
const aabOut = path.join(root, 'dist-apk', 'tandem-release.aab')
const releaseDir = path.join(os.homedir(), '.tandem-release')
const keystore = path.join(releaseDir, 'android.keystore')
const passwordFile = path.join(releaseDir, 'android.keystore.password')
const alias = process.env.TANDEM_ANDROID_KEY_ALIAS || 'tandem'
const PASSWORD_ENV = 'TANDEM_ANDROID_KEYSTORE_PASSWORD'

function findJavaHome() {
  const javaBin = (dir) => path.join(dir, 'bin', isWin ? 'java.exe' : 'java')
  if (process.env.JAVA_HOME && fs.existsSync(javaBin(process.env.JAVA_HOME))) return process.env.JAVA_HOME
  const bases = isWin
    ? ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Android\\Android Studio']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', path.join(os.homedir(), '.local')]
  for (const base of bases) {
    if (!fs.existsSync(base)) continue
    if (fs.existsSync(javaBin(path.join(base, 'jbr')))) return path.join(base, 'jbr')
    const dirs = fs.readdirSync(base).filter((n) => /(jdk|java|temurin|openjdk).*(21|2[2-9])/i.test(n) || /^jdk-?21/i.test(n))
    for (const d of dirs.sort().reverse()) {
      for (const cand of [path.join(base, d), path.join(base, d, 'Contents', 'Home')]) {
        if (fs.existsSync(javaBin(cand))) return cand
      }
    }
  }
  return undefined
}

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

const keytool = path.join(JAVA_HOME, 'bin', isWin ? 'keytool.exe' : 'keytool')
const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME,
  ANDROID_SDK_ROOT: ANDROID_HOME,
  PATH: [path.join(JAVA_HOME, 'bin'), process.env.PATH].join(path.delimiter),
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: isWin, ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${r.status})`)
}

function readPassword() {
  const fromEnv = process.env[PASSWORD_ENV]
  if (fromEnv) return fromEnv.trim()
  if (!fs.existsSync(passwordFile)) return undefined
  const mode = fs.statSync(passwordFile).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(`密码文件权限过宽（${mode.toString(8)}）：${passwordFile}\n请先执行 chmod 600 后再打包。`)
  }
  return fs.readFileSync(passwordFile, 'utf8').trim()
}

function ensureKeystore() {
  fs.mkdirSync(releaseDir, { recursive: true, mode: 0o700 })
  let password = readPassword()
  if (!fs.existsSync(keystore)) {
    if (!password) {
      password = randomBytes(24).toString('base64url')
      fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 })
      fs.chmodSync(passwordFile, 0o600)
      console.log(`已生成本机签名密码文件：${passwordFile}（权限 600）`)
    }
    console.log(`未找到签名密钥，正在生成：${keystore}`)
    run(
      keytool,
      [
        '-genkeypair',
        '-keystore', keystore,
        '-alias', alias,
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', '10000',
        '-dname', 'CN=Tandem, OU=Tandem, O=Tandem, L=Local, ST=Local, C=CN',
        '-storepass:env', PASSWORD_ENV,
        '-keypass:env', PASSWORD_ENV,
      ],
      { env: { ...env, [PASSWORD_ENV]: password } },
    )
    fs.chmodSync(keystore, 0o600)
    console.log('密钥已生成。请把整个 ~/.tandem-release 目录离线备份；丢失后无法再给已安装用户升级。')
  } else if (!password) {
    throw new Error(
      `找不到签名密码。请设置环境变量 ${PASSWORD_ENV}，或把密码写入 ${passwordFile}（chmod 600）。`,
    )
  } else if (!fs.existsSync(passwordFile)) {
    console.log('使用环境变量中的签名密码。')
  }
  return password
}

function apksigner() {
  const buildTools = path.join(ANDROID_HOME, 'build-tools')
  if (!fs.existsSync(buildTools)) return undefined
  const versions = fs
    .readdirSync(buildTools)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse()
  for (const version of versions) {
    const bin = path.join(buildTools, version, isWin ? 'apksigner.bat' : 'apksigner')
    if (fs.existsSync(bin)) return bin
  }
  return undefined
}

function verifyApk(apk) {
  const signer = apksigner()
  if (!signer) throw new Error('未找到 apksigner（Android SDK build-tools）')
  const result = spawnSync(signer, ['verify', '--verbose', '--print-certs', apk], {
    stdio: 'inherit',
    env,
    shell: isWin,
  })
  if (result.status !== 0) throw new Error('apksigner verify 校验失败')
  const listing = spawnSync('unzip', ['-l', apk], { encoding: 'utf8' })
  if (listing.status !== 0) throw new Error('无法读取 APK 内容（需要 unzip）')
  if (!listing.stdout.includes('assets/public/index.html')) {
    throw new Error('APK 内缺少 assets/public/index.html：WebView 资源未被打包')
  }
  if (!/assets\/public\/assets\/[^\s]+\.js/.test(listing.stdout)) {
    throw new Error('APK 内缺少 WebView JS 资源：代码压缩可能误删了前端产物')
  }
  console.log('WebView 资源检查通过：assets/public/index.html 与 JS/CSS 均存在。')
}

function copyToWindowsDownloads(files) {
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
    for (const file of files) {
      const target = path.join(dir, path.basename(file))
      fs.copyFileSync(file, target)
      console.log(`已复制到 ${target}`)
    }
  }
}

const password = ensureKeystore()
console.log(`JAVA_HOME=${JAVA_HOME}\nANDROID_HOME=${ANDROID_HOME}\nkeystore=${keystore}`)

run('npm', ['run', 'build', '-w', '@tandem/protocol'], { cwd: root })
run('npm', ['run', 'build', '-w', '@tandem/relay'], { cwd: root })
run('npm', ['run', 'build', '-w', '@tandem/web'], {
  cwd: root,
  env: { ...env, TANDEM_FLAVOR: 'release' },
})
const webDist = path.join(root, 'packages', 'web', 'dist')
run('npx', ['cap', 'sync', 'android'], {
  cwd: pkgDir,
  env: { ...env, TANDEM_WEB_DIR: webDist },
})

const gradlew = isWin ? 'gradlew.bat' : './gradlew'
if (!isWin) fs.chmodSync(path.join(androidDir, 'gradlew'), 0o755)
const gradleEnv = {
  ...env,
  TANDEM_ANDROID_KEYSTORE: keystore,
  [PASSWORD_ENV]: password,
  TANDEM_ANDROID_KEY_ALIAS: alias,
  TANDEM_ANDROID_KEY_PASSWORD: password,
}
run(gradlew, ['assembleRelease', 'bundleRelease', '--no-daemon'], { cwd: androidDir, env: gradleEnv })

const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const aab = path.join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')
if (!fs.existsSync(apk)) throw new Error(`未找到 release APK: ${apk}`)
if (!fs.existsSync(aab)) throw new Error(`未找到 release AAB: ${aab}`)

verifyApk(apk)
fs.mkdirSync(path.dirname(apkOut), { recursive: true })
fs.copyFileSync(apk, apkOut)
fs.copyFileSync(aab, aabOut)
console.log(`APK: ${apkOut}`)
console.log(`AAB: ${aabOut}`)
console.log(`签名密钥：${keystore}（密码文件 ${passwordFile}）`)
console.log('提醒：请离线备份 ~/.tandem-release；丢失密钥后，已安装用户将无法覆盖升级。')
copyToWindowsDownloads([apkOut, aabOut])
