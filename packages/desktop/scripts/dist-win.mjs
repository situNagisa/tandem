// 构建 web + server → 整理资源 → electron-builder 打包 Windows x64 → 复制产物。
// 默认发布版；--debug（或 TANDEM_FLAVOR=debug）产出带调试工具的安装包。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const outDir = path.join(desktopDir, 'dist');
const flavor =
  process.argv.includes('--debug') || process.env.TANDEM_FLAVOR === 'debug' ? 'debug' : 'release';
const version = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version;
const artifactName =
  flavor === 'debug' ? 'Tandem-Setup-${version}-debug-${arch}.${ext}' : undefined;
const targets = [
  path.join(repoRoot, 'dist-desktop'),
  '/mnt/c/Users/JDHC/Downloads',
];

function spawnStep(cmd, args, cwd, extraEnv = {}) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  return spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...extraEnv },
  });
}

function run(cmd, args, cwd, extraEnv = {}) {
  const result = spawnStep(cmd, args, cwd, extraEnv);
  if (result.status !== 0) {
    throw new Error(`命令失败（退出码 ${result.status}）: ${cmd} ${args.join(' ')}`);
  }
}

/** 构建 server；若只是类型检查报错但 tsc 仍输出了比源码新的 dist，则沿用。 */
function buildServer() {
  const result = spawnStep('npm', ['run', 'build', '-w', '@tandem/server'], repoRoot, {
    TANDEM_FLAVOR: flavor,
  });
  if (result.status === 0) return;
  const distFile = path.join(repoRoot, 'packages', 'server', 'dist', 'server.js');
  const srcDir = path.join(repoRoot, 'packages', 'server', 'src');
  const newestSrc = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((max, entry) => {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) return Math.max(max, newestSrc(p));
      return Math.max(max, fs.statSync(p).mtimeMs);
    }, 0);
  const emitted = fs.existsSync(distFile) && fs.statSync(distFile).mtimeMs >= newestSrc(srcDir);
  if (!emitted) {
    throw new Error('server 构建失败且未产出 dist');
  }
  console.warn('\n[dist:win] 警告：server 类型检查失败，沿用 tsc 已生成的 dist 继续打包');
}

function find7za() {
  const cache = path.join(os.homedir(), '.cache', 'electron-builder');
  if (!fs.existsSync(cache)) return null;
  for (const entry of fs.readdirSync(cache)) {
    if (!entry.startsWith('7zip')) continue;
    const binDir = path.join(cache, entry);
    for (const sub of fs.readdirSync(binDir)) {
      const candidate = path.join(binDir, sub, 'bin', '7za');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function zipDir(dir, zipPath) {
  const sevenZa = find7za();
  if (sevenZa) {
    run(sevenZa, ['a', '-tzip', '-mx=6', zipPath, '.'], dir);
    return;
  }
  const zipAvailable = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;
  if (!zipAvailable) throw new Error('缺少 zip / 7za，无法生成 zip');
  run('zip', ['-qr', zipPath, '.'], dir);
}

function collectArtifacts() {
  const files = fs.existsSync(outDir)
    ? fs
        .readdirSync(outDir)
        .filter((f) => /\.(exe|zip|dmg|AppImage|blockmap)$/i.test(f) || /^latest.*\.yml$/i.test(f))
    : [];
  return files.map((f) => path.join(outDir, f));
}

function builder(args) {
  const bin = path.join(repoRoot, 'node_modules', '.bin', 'electron-builder');
  fs.rmSync(outDir, { recursive: true, force: true });
  const configArgs = artifactName ? [`--config.win.artifactName=${artifactName}`] : [];
  return spawnSync(bin, [...args, ...configArgs], {
    cwd: desktopDir,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
}

try {
  console.log(`[dist:win] flavor=${flavor} version=${version}`);
  run('npm', ['run', 'build', '-w', '@tandem/protocol'], repoRoot);
  run('npm', ['run', 'build', '-w', '@tandem/web'], repoRoot, { TANDEM_FLAVOR: flavor });
  buildServer();
  if (flavor === 'release') {
    run(process.execPath, [path.join(repoRoot, 'scripts', 'strip-debug-dist.mjs')], repoRoot);
  }
  run(process.execPath, [path.join(here, 'prepare-resources.mjs')], desktopDir);

  let ok = false;
  let result = builder(['--win', 'nsis', '--x64', '--publish', 'never']);
  if (result.status === 0) {
    ok = true;
  } else {
    console.warn('\n[dist:win] NSIS 打包失败，尝试 portable…');
    result = builder(['--win', 'portable', '--x64', '--publish', 'never']);
    if (result.status === 0) ok = true;
  }

  if (!ok) {
    console.warn('\n[dist:win] portable 失败，退回到 --dir + zip…');
    result = builder(['--win', '--dir', '--x64', '--publish', 'never']);
    if (result.status !== 0) throw new Error('electron-builder 打包失败');
    const unpacked = path.join(outDir, 'win-unpacked');
    if (!fs.existsSync(unpacked)) throw new Error('未找到 win-unpacked');
    zipDir(unpacked, path.join(outDir, flavor === 'debug' ? 'Tandem-debug-win-x64.zip' : 'Tandem-win-x64.zip'));
  }

  const artifacts = collectArtifacts();
  if (!artifacts.length) throw new Error(`未找到打包产物：${outDir}`);

  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) {
        if (target.startsWith('/mnt/')) continue;
        fs.mkdirSync(target, { recursive: true });
      }
      for (const file of artifacts) {
        const dest = path.join(target, path.basename(file));
        fs.copyFileSync(file, dest);
        console.log(`[dist:win] 已复制 → ${dest}`);
      }
    } catch (err) {
      console.warn(`[dist:win] 复制到 ${target} 失败：${err.message}`);
    }
  }

  console.log('\n[dist:win] 完成：');
  for (const file of artifacts) {
    const stat = fs.statSync(file);
    console.log(`  ${file}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  }
} catch (err) {
  console.error(`\n[dist:win] 失败：${err.message}`);
  process.exit(1);
}
