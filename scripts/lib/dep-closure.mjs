// 生产依赖闭包：从某个包目录出发，按 dependencies/optionalDependencies 递归定位并拷贝依赖。
// 与 packages/desktop/scripts/prepare-resources.mjs 的规则一致（顶层布局 + 嵌套的私有依赖），
// 供 scripts/pack-host.mjs 复用；desktop 打包暂不改动，避免影响发布产物布局。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function packageRoot(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** 向上找 name 匹配的包根：子目录里的 package.json（如 dist/cjs/package.json）不算包根。 */
function packageRootNamed(file, name) {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) return dir;
      } catch {
        // 继续向上找
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveDep(name, fromDir) {
  const req = createRequire(path.join(fromDir, 'package.json'));
  for (const spec of [`${name}/package.json`, name]) {
    try {
      const root = packageRootNamed(req.resolve(spec), name);
      if (root) return root;
    } catch {
      // exports 未暴露该入口：尝试下一个写法
    }
  }
  // 兜底：按 Node 解析顺序向上找 node_modules/<name>/package.json（支持工作区软链）。
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.fallbackNodeModules 非嵌套依赖的目标 node_modules（如 <stage>/node_modules）
 * @param {(msg: string) => void} [opts.warn]
 */
export function createDependencyCopier({ fallbackNodeModules, warn = () => {} }) {
  const copied = new Map(); // realPath -> destDir

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
        warn(`跳过未解析到的依赖: ${name} (来自 ${pkg.name || real})`);
        continue;
      }
      const nested = depDir.startsWith(real + path.sep + 'node_modules' + path.sep);
      const depDest = nested ? path.join(destDir, 'node_modules', name) : path.join(fallbackNodeModules, name);
      copyPackage(depDir, depDest);
    }
  }

  return { copyPackage };
}
