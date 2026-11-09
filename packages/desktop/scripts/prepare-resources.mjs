// 把 server dist + 生产依赖、web dist、图标整理到 packages/desktop/resources。
// 打包时整个 resources 目录作为 extraResources 放进 app。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const root = path.resolve(desktopDir, '..', '..');
const serverDir = path.join(root, 'packages', 'server');
const webDir = path.join(root, 'packages', 'web');
const outDir = path.join(desktopDir, 'resources');

const copied = new Map(); // realPath -> destDir

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function packageRoot(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveDep(name, fromDir) {
  const req = createRequire(path.join(fromDir, 'package.json'));
  try {
    return packageRoot(req.resolve(`${name}/package.json`));
  } catch {
    // exports 未暴露 package.json
  }
  try {
    return packageRoot(req.resolve(name));
  } catch {
    return undefined;
  }
}

function copyPackage(pkgDir, destDir) {
  const real = fs.realpathSync(pkgDir);
  if (copied.has(real)) {
    if (copied.get(real) === destDir) return;
    // 同一包被解析到不同位置：按需再拷贝一份
  }
  copied.set(real, destDir);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(real, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => path.basename(src) !== 'node_modules' || path.dirname(src) !== real,
  });

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  for (const name of Object.keys(deps)) {
    const depDir = resolveDep(name, real);
    if (!depDir) {
      console.warn(`[resources] 跳过未解析到的依赖: ${name} (来自 ${pkg.name || real})`);
      continue;
    }
    const nested = depDir.startsWith(real + path.sep + 'node_modules' + path.sep);
    const depDest = nested
      ? path.join(destDir, 'node_modules', name)
      : path.join(outDir, 'server', 'node_modules', name);
    copyPackage(depDir, depDest);
  }
}

function assertBuilt(dir, label) {
  if (!fs.existsSync(path.join(dir, 'index.html')) && !fs.existsSync(path.join(dir, 'cli.js'))) {
    throw new Error(`${label} 尚未构建：${dir}`);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// server
const serverDist = path.join(serverDir, 'dist');
assertBuilt(serverDist, 'packages/server/dist');
copyDir(serverDist, path.join(outDir, 'server', 'dist'));
fs.copyFileSync(path.join(serverDir, 'package.json'), path.join(outDir, 'server', 'package.json'));

// web
const webDist = path.join(webDir, 'dist');
assertBuilt(webDist, 'packages/web/dist');
copyDir(webDist, path.join(outDir, 'web', 'dist'));

// 生产依赖闭包（server 自身只保留 dist 与 package.json）
copyPackage(serverDir, path.join(outDir, 'server'));
for (const extra of ['src', 'tsconfig.json', 'package-lock.json']) {
  fs.rmSync(path.join(outDir, 'server', extra), { recursive: true, force: true });
}

// 图标（沿用 web 现有图标）
const iconSrc = path.join(webDir, 'public', 'icons', 'icon-512.png');
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
fs.copyFileSync(iconSrc, path.join(outDir, 'icons', 'icon.png'));
fs.mkdirSync(path.join(desktopDir, 'build'), { recursive: true });
fs.copyFileSync(iconSrc, path.join(desktopDir, 'build', 'icon.png'));

// 主进程据此决定是否注册调试版入口（手机预览等）。
const flavor = process.env.TANDEM_FLAVOR === 'release' ? 'release' : 'debug';
fs.writeFileSync(path.join(outDir, 'flavor.txt'), `${flavor}\n`);

const depCount = fs.existsSync(path.join(outDir, 'server', 'node_modules'))
  ? fs.readdirSync(path.join(outDir, 'server', 'node_modules')).length
  : 0;
console.log(`[resources] 完成：${outDir}（node_modules 顶层 ${depCount} 项，flavor=${flavor}）`);
