// product-check 的故意违规样例：每类检查（结构 / 编号 / 提交规则 / 唯一实现）至少一条，
// 证明规则真的会拦住，而不是只在正常仓库里打印「通过」。
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const CHECK = path.resolve(new URL('../product-check.mjs', import.meta.url).pathname)

const TABLE = (rows) =>
  ['# 产品定义', '', '| 领域 | 拥有的概念 | 依赖 |', '|---|---|---|', ...rows, ''].join('\n')

const productFiles = (rows = ['| HOST 工作站 | 工作站、账号 | — |', '| TREE 会话树 | 分叉、子代理 | HOST |']) => ({
  'product/README.md': TABLE(rows),
  'product/session-tree.md': '# TREE 会话树\n\n- **TREE-1** 树里所有会话的所有轮都是节点。\n',
})

// 用函数拼测试文件内容：本文件自己也在 scripts/**/*.test.mjs 的扫描范围内，
// 直接写带编号的测试调用会被 product-check 当成真实测试名。
const fakeTest = (name) => `test(${JSON.stringify(name)}, () => {})\n`

const passingTest = {
  'packages/web/src/lib/sample.test.ts': fakeTest('[TREE-1] 节点相同'),
}

// 空登记本身是错误（真实仓库必须登记四个核心模型），样例里放一条永不命中的占位。
const DUMMY_MODELS = {
  models: [{ id: 'dummy', owner: ['packages/web/src/lib/dummy.ts'], features: [{ pattern: '__never_matches__' }] }],
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commit(root, message) {
  git(root, ['add', '-A'])
  const result = git(root, ['commit', '-qm', message])
  assert.equal(result.status, 0, `git commit 失败：${result.stderr}`)
}

/** 造一棵最小仓库：product/ + 一条测试 + 核心模型登记；基线提交后再做一次合并。 */
function fixture({ product = productFiles(), files = passingTest, models = DUMMY_MODELS } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tandem-product-check-'))
  const write = (rel, content) => {
    const file = path.join(root, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  write('scripts/product-core-models.json', JSON.stringify(models))
  for (const [rel, content] of Object.entries(product)) write(rel, content)
  for (const [rel, content] of Object.entries(files)) write(rel, content)

  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'test'])
  commit(root, 'chore: 基线')
  // 产品检查在 main 上只看「最近一次合并之后」的提交；用一次真合并把基线挡在检查范围外。
  git(root, ['checkout', '-q', '-b', 'seed'])
  write('docs/seed.md', 'seed\n')
  commit(root, 'docs: 种子')
  git(root, ['checkout', '-q', 'main'])
  git(root, ['merge', '-q', '--no-ff', 'seed', '-m', 'merge: 种子'])
  return root
}

function runCheck(root, args = []) {
  const result = spawnSync(process.execPath, [CHECK, '--root', root, ...args], { encoding: 'utf8' })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function track(t, root) {
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('合规仓库通过', (t) => {
  const root = track(t, fixture())
  const { code, out } = runCheck(root)
  assert.equal(code, 0, out)
  assert.match(out, /product-check: 通过/)
})

test('结构：同一个概念出现在两个领域即报错', (t) => {
  const root = track(
    t,
    fixture({
      product: productFiles(['| HOST 工作站 | 工作站、会话 | — |', '| TREE 会话树 | 分叉、会话 | HOST |']),
    }),
  )
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /概念「会话」同时出现在 HOST、TREE/)
})

test('结构：依赖成环、依赖指向未登记领域都报错', (t) => {
  const root = track(
    t,
    fixture({
      product: productFiles([
        '| HOST 工作站 | 工作站、账号 | TREE |',
        '| TREE 会话树 | 分叉、子代理 | HOST、CONV |',
      ]),
    }),
  )
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /领域依赖成环：HOST → TREE → HOST|领域依赖成环：TREE → HOST → TREE/)
  assert.match(out, /领域 TREE 依赖未登记的领域 CONV/)
})

test('结构：领域文件超过 150 行即报错', (t) => {
  const product = productFiles()
  product['product/session-tree.md'] = `# TREE 会话树\n${Array.from({ length: 150 }, () => 'x').join('\n')}`
  const root = track(t, fixture({ product }))
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /product\/session-tree\.md：151 行，超过上限 150 行/)
})

test('编号：缺测试在迁移期只警告，--strict 时才是错误', (t) => {
  const product = productFiles()
  // 删掉弧绑定 TREE-1 的测试：编号没有被测试名引用。
  const root = track(t, fixture({ product, files: {} }))
  const loose = runCheck(root)
  assert.equal(loose.code, 0, loose.out)
  assert.match(loose.out, /警告 编号 TREE-1 没有被任何测试名引用/)
  const strict = runCheck(root, ['--strict'])
  assert.equal(strict.code, 1, strict.out)
  assert.match(strict.out, /错误 编号 TREE-1 没有被任何测试名引用/)
})

test('编号：测试名引用的编号在 product/ 中不存在即报错', (t) => {
  const root = track(
    t,
    fixture({
      files: {
        'packages/web/src/lib/sample.test.ts':
          fakeTest('[TREE-1] 节点相同') + fakeTest('[TREE-9] 不存在的编号'),
      },
    }),
  )
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /测试名引用的编号 TREE-9 在 product\/ 中不存在/)
})

test('提交规则：spec 提交改了 product/ 之外的文件即报错', (t) => {
  const root = track(t, fixture())
  git(root, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(path.join(root, 'product/session-tree.md'), '# TREE 会话树\n\n- **TREE-2** 新行为。\n')
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  writeFileSync(path.join(root, 'scripts/touch.mjs'), '// 实现改动\n')
  commit(root, 'spec: 顺手改了实现')
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /spec 提交 [0-9a-f]{8}（spec: 顺手改了实现）改了 product\/ 之外的文件：scripts\/touch\.mjs/)
})

test('提交规则：非 spec 提交改了 product/ 即报错', (t) => {
  const root = track(t, fixture())
  git(root, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(path.join(root, 'product/session-tree.md'), '# TREE 会话树\n\n- **TREE-2** 新行为。\n')
  commit(root, 'fix: 改实现时顺手改了规格')
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /非 spec 提交 [0-9a-f]{8}（fix: 改实现时顺手改了规格）改了 product\/：product\/session-tree\.md/)
})

test('提交规则：非 spec 提交修改 product/ 登记的验收测试即报错', (t) => {
  const product = productFiles()
  product['product/session-tree.md'] =
    '# TREE 会话树\n\n- **TREE-1** 树里所有会话的所有轮都是节点。\n\n验收测试：`packages/web/src/lib/sample.test.ts`\n'
  const root = track(t, fixture({ product }))
  git(root, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(
    path.join(root, 'packages/web/src/lib/sample.test.ts'),
    fakeTest('[TREE-1] 节点相同（被实现者改动）'),
  )
  commit(root, 'fix: 为了让测试通过而改测试')
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /修改了 product\/ 登记的验收测试「packages\/web\/src\/lib\/sample\.test\.ts」/)
})

test('唯一实现：登记模块之外出现同类特征时警告，--strict 报错', (t) => {
  const models = {
    models: [
      {
        id: 'session-tree',
        name: '会话树归并',
        owner: ['packages/web/src/lib/sessionTree.ts'],
        features: [{ pattern: 'parentId\\s*\\?\\?\\s*[\\w.$]*forkedFrom\\?\\.sessionId' }],
      },
    ],
  }
  const files = {
    ...passingTest,
    'packages/web/src/components/Dup.ts':
      'export const rootOf = (rec: any) => rec.parentId ?? rec.forkedFrom?.sessionId\n',
  }
  const root = track(t, fixture({ models, files }))
  const loose = runCheck(root)
  assert.equal(loose.code, 0, loose.out)
  assert.match(loose.out, /核心模型「会话树归并」在登记模块之外出现同类实现：packages\/web\/src\/components\/Dup\.ts:1/)
  const strict = runCheck(root, ['--strict'])
  assert.equal(strict.code, 1, strict.out)
  assert.match(strict.out, /错误 核心模型「会话树归并」在登记模块之外出现同类实现/)
})

test('唯一实现：登记的例外命中后只提示，不再警告', (t) => {
  const models = {
    models: [
      {
        id: 'model-capabilities',
        name: '模型能力',
        owner: ['packages/server/src/providers/capabilities.ts'],
        features: [{ pattern: 'OFFLINE_TABLE' }],
        exceptions: [
          {
            path: 'packages/web/src/lib/effort.ts',
            reason: '能力接口未返回时的离线兜底',
          },
        ],
      },
    ],
  }
  const files = {
    ...passingTest,
    'packages/web/src/lib/effort.ts': 'export const OFFLINE_TABLE = 1\n',
  }
  const root = track(t, fixture({ models, files }))
  const loose = runCheck(root)
  assert.equal(loose.code, 0, loose.out)
  assert.match(loose.out, /允许的例外：packages\/web\/src\/lib\/effort\.ts（能力接口未返回时的离线兜底）/)
  assert.doesNotMatch(loose.out, /在登记模块之外出现同类实现/)
  const strict = runCheck(root, ['--strict'])
  assert.equal(strict.code, 0, strict.out)
})

test('唯一实现：例外缺理由报错，路径不存在仍警告', (t) => {
  const models = {
    models: [
      {
        id: 'model-capabilities',
        name: '模型能力',
        owner: ['packages/server/src/providers/capabilities.ts'],
        features: [{ pattern: 'OFFLINE_TABLE' }],
        exceptions: [{ path: 'packages/web/src/lib/effort.ts' }],
      },
    ],
  }
  const files = {
    ...passingTest,
    'packages/web/src/lib/effort.ts': 'export const OFFLINE_TABLE = 1\n',
  }
  const root = track(t, fixture({ models, files }))
  const { code, out } = runCheck(root)
  assert.equal(code, 1, out)
  assert.match(out, /例外登记不完整：.*需要 path、reason/)
})

test('唯一实现：例外登记的路径不存在时警告', (t) => {
  const models = {
    models: [
      {
        id: 'model-capabilities',
        name: '模型能力',
        owner: ['packages/server/src/providers/capabilities.ts'],
        features: [{ pattern: '__never_matches__' }],
        exceptions: [{ path: 'packages/web/src/lib/gone.ts', reason: '已删除的兜底' }],
      },
    ],
  }
  const root = track(t, fixture({ models }))
  const { code, out } = runCheck(root)
  assert.equal(code, 0, out)
  assert.match(out, /登记的例外没有命中任何文件：packages\/web\/src\/lib\/gone\.ts/)
})
