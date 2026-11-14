#!/usr/bin/env node
/**
 * 产品定义落地检查（快速步骤，接在 scripts/check.mjs 的 docs 之后）。
 *
 * A. 结构：解析 product/README.md 的领域表（领域编号、拥有的概念、依赖）。
 *    概念在两个领域出现、依赖成环、依赖指向未登记领域都报错；README ≤80 行、每个领域文件 ≤150 行。
 * B. 编号：领域文件里的行为编号（TREE-12）在全仓唯一；编号必须被测试名引用；
 *    测试名与 decisions-check 条目引用的编号必须在 product/ 中存在。
 *    测试名引用规则：名字以编号开头（`TREE-12 …`）、包含方括号编号（`… [TREE-12]`）
 *    或包含裸编号（`… TREE-12`）都算；按整词匹配，TREE-1 不会被 TREE-12 误认。
 *    迁移期（product/ROLLOUT.md 第 5 步完成前）：缺测试只警告并列清单，--strict 才报错；
 *    切为默认严格时把 STRICT_BY_DEFAULT 改成 true。
 * C. 提交规则：`git log main..HEAD` 与工作区改动。`spec:` 提交只能改 product/（与 AGENTS.md、
 *    docs/HANDOFF.md），非 spec 提交不能改 product/；product/ 里写了「验收测试：<路径或用例名>」的，
 *    非 spec 提交改了它报错（目前没有登记项，只保留机制）。在 main 上运行时检查最近一次合并之后的提交。
 * D. 核心模型唯一实现：读 scripts/product-core-models.json（不放进 product/，避免污染产品定义），
 *    每个核心模型登记唯一实现模块与识别特征；packages 各包的 src 里登记模块之外出现同类特征时警告
 *    （迁移期），--strict 报错。识别特征用精确正则，宁可漏报不要误报。
 *    模型可登记 exceptions（path + reason）放行「请求未返回时的离线兜底」这类不可避免的重复；
 *    命中后打提示说明理由，登记的路径不存在时仍警告。
 *
 * 用法：
 *   node scripts/product-check.mjs
 *   node scripts/product-check.mjs --strict        警告也按错误处理
 *   node scripts/product-check.mjs --root <dir>    检查另一棵树（单测用）
 *   node scripts/product-check.mjs --base <ref>    提交规则的基线分支（默认 main）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  idsIn,
  readDecisions,
  readProduct,
  readTestNames,
  readText,
  relPath,
  walk,
} from './lib/product.mjs'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const argv = process.argv.slice(2)
const argValue = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const root = path.resolve(argValue('--root') ?? ROOT)
const base = argValue('--base') ?? 'main'
const strict = argv.includes('--strict')

const README_MAX_LINES = 80
const DOMAIN_MAX_LINES = 150
/** 迁移期：缺测试只警告。ROLLOUT 第 5 步完成后，把这里改成 true。 */
const STRICT_BY_DEFAULT = false

const errors = []
const warnings = []
const notes = []
const report = (message) => {
  if (strict || STRICT_BY_DEFAULT) errors.push(message)
  else warnings.push(message)
}

const product = readProduct(root)

// ---------- A. 结构 ----------
if (!product.readmeText) {
  errors.push('product/README.md 不存在：产品定义的入口与领域表都在这里')
} else {
  if (product.readmeLines > README_MAX_LINES) {
    errors.push(
      `product/README.md：${product.readmeLines} 行，超过上限 ${README_MAX_LINES} 行（写不下说明该重新划分领域，而不是继续加）`,
    )
  }
  if (product.domains.length === 0) {
    errors.push('product/README.md 没有解析到领域表：需要「| 领域 | 拥有的概念 | 依赖 |」三列表格')
  }
}

const domainSeen = new Set()
for (const domain of product.domains) {
  if (domainSeen.has(domain.id)) errors.push(`领域表重复登记了领域 ${domain.id}`)
  domainSeen.add(domain.id)
}

// 一个概念只属于一个领域；其他领域只能引用。
const conceptOwners = new Map()
for (const domain of product.domains) {
  for (const concept of domain.concepts) {
    if (!conceptOwners.has(concept)) conceptOwners.set(concept, [])
    conceptOwners.get(concept).push(domain.id)
  }
}
for (const [concept, owners] of conceptOwners) {
  if (owners.length > 1) {
    errors.push(`概念「${concept}」同时出现在 ${owners.join('、')}：每个概念只属于一个领域`)
  }
}

// 依赖必须指向已登记领域；「全部」表示除自己以外的所有领域。
const depsOf = (domain) =>
  domain.deps.includes('全部')
    ? product.domains.filter((item) => item.id !== domain.id).map((item) => item.id)
    : domain.deps
for (const domain of product.domains) {
  for (const dep of domain.deps) {
    if (dep === '全部') continue
    if (!product.domainById.has(dep)) errors.push(`领域 ${domain.id} 依赖未登记的领域 ${dep}`)
  }
}

// 依赖成环。
const color = new Map()
const stack = []
const visit = (id) => {
  if (color.get(id) === 1) {
    const at = stack.indexOf(id)
    errors.push(`领域依赖成环：${[...stack.slice(at), id].join(' → ')}`)
    return
  }
  if (color.get(id) === 2) return
  const domain = product.domainById.get(id)
  if (!domain) return
  color.set(id, 1)
  stack.push(id)
  for (const dep of depsOf(domain)) if (product.domainById.has(dep)) visit(dep)
  stack.pop()
  color.set(id, 2)
}
for (const domain of product.domains) visit(domain.id)

for (const file of product.domainFiles) {
  if (file.lines.length > DOMAIN_MAX_LINES) {
    errors.push(`${file.rel}：${file.lines.length} 行，超过上限 ${DOMAIN_MAX_LINES} 行`)
  }
  if (file.domainId && !product.domainById.has(file.domainId)) {
    warnings.push(`${file.rel}：领域 ${file.domainId} 没有在 product/README.md 的领域表登记`)
  }
}
for (const domain of product.domains) {
  if (!product.domainFiles.some((file) => file.domainId === domain.id)) {
    notes.push(`领域 ${domain.id} 尚未迁移（没有领域文件）`)
  }
}

// ---------- B. 编号 ----------
const definitions = product.occurrences.filter((occurrence) => occurrence.definition)
const definitionsById = new Map()
for (const occurrence of definitions) {
  if (!definitionsById.has(occurrence.id)) definitionsById.set(occurrence.id, [])
  definitionsById.get(occurrence.id).push(occurrence)
}
for (const [id, list] of definitionsById) {
  if (list.length > 1) {
    const places = [...new Set(list.map((item) => `${item.file}:${item.line}`))].join('、')
    errors.push(`行为编号 ${id} 定义了 ${list.length} 次（${places}）：编号在全仓唯一`)
  }
  for (const item of list) {
    if (item.domain && item.domain !== item.prefix) {
      warnings.push(`${item.file}:${item.line}：编号 ${id} 的前缀与所在领域 ${item.domain} 不一致`)
    }
  }
}

const tests = readTestNames(root)
const testRefs = new Map()
for (const test of tests) {
  for (const id of idsIn(test.name)) {
    if (!testRefs.has(id)) testRefs.set(id, [])
    testRefs.get(id).push(test)
  }
}
const registeredDomains = new Set(product.domains.map((domain) => domain.id))
for (const [id, hits] of testRefs) {
  if (product.ids.has(id)) continue
  // UTF-8、GPT-6 这类不是产品编号：前缀不是已登记领域时忽略，避免误报。
  if (!registeredDomains.has(id.split('-')[0])) continue
  const places = hits.map((hit) => `${hit.file}:${hit.line}`).join('、')
  errors.push(`测试名引用的编号 ${id} 在 product/ 中不存在（${places}）`)
}

for (const id of product.requiredIds) {
  if (testRefs.has(id)) continue
  report(`编号 ${id} 没有被任何测试名引用（测试名以编号开头或包含 [${id}] / ${id}）`)
}

const decisions = readDecisions(root)
for (const entry of decisions) {
  for (const id of new Set(idsIn(entry.text))) {
    if (product.ids.has(id) || !registeredDomains.has(id.split('-')[0])) continue
    errors.push(`decisions-check 条目 ${entry.id || '?'}（脚本第 ${entry.line} 行附近）引用的编号 ${id} 在 product/ 中不存在`)
  }
}
for (const entry of decisions) {
  const referenced = new Set(idsIn(entry.text))
  if (referenced.size === 0) continue
  const missing = [...referenced].filter((id) => !product.ids.has(id) && registeredDomains.has(id.split('-')[0]))
  if (missing.length === 0) notes.push(`decisions-check 条目 ${entry.id} 已挂编号 ${[...referenced].join('、')}`)
}

// ---------- C. 提交规则 ----------
const git = (args) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}
const short = (hash) => hash.slice(0, 8)
const isProduct = (file) => file.startsWith('product/')
const specAllowed = (file) => isProduct(file) || file === 'AGENTS.md' || file === 'docs/HANDOFF.md'

/** product/ 里登记的验收测试：「验收测试：<路径或用例名>」，实现提交不得修改。 */
const acceptance = []
for (const file of product.markdownFiles) {
  file.lines.forEach((line, index) => {
    const match = line.match(/验收测试[：:]\s*(.+)/)
    if (!match) return
    for (const value of match[1].split(/[、,，]/)) {
      const trimmed = value.replace(/`/g, '').trim()
      if (trimmed) acceptance.push({ value: trimmed, file: file.rel, line: index + 1 })
    }
  })
}
const acceptanceHit = (changed) => {
  for (const entry of acceptance) {
    const looksLikePath = entry.value.includes('/') || /\.(?:tsx?|js|mjs)$/.test(entry.value)
    if (looksLikePath) {
      if (changed.some((file) => file === entry.value || file.endsWith(`/${entry.value}`))) return entry
      continue
    }
    const holders = new Set(tests.filter((test) => test.name.includes(entry.value)).map((test) => test.file))
    if (changed.some((file) => holders.has(file))) return entry
  }
  return null
}

const isRepo = git(['rev-parse', '--is-inside-work-tree']) === 'true'
if (!isRepo) {
  warnings.push('不在 git 仓库里：跳过提交规则检查')
} else {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const hasBase = git(['rev-parse', '--verify', '--quiet', base]) !== null
  let hashes = []
  if (branch === base || branch === 'HEAD') {
    // 主分支：只看最近一次合并之后的提交（合并本身往往引入大批历史，不逐条追究）。
    const rows = (git(['log', '--first-parent', '--format=%H %P', '-n', '200']) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((row) => row.split(' '))
    const mergeAt = rows.findIndex((row) => row.length > 2)
    // mergeAt === 0：HEAD 就是合并提交，之后没有提交；-1：最近 200 个里没有合并，退回最近 30 个。
    if (mergeAt === 0) hashes = []
    else if (mergeAt > 0) hashes = rows.slice(0, mergeAt).map((row) => row[0])
    else hashes = rows.slice(0, 30).map((row) => row[0])
  } else if (hasBase) {
    hashes = (git(['rev-list', `${base}..HEAD`]) ?? '').split('\n').filter(Boolean)
  } else {
    warnings.push(`找不到基线 ${base}：提交规则只检查最近 30 个提交`)
    hashes = (git(['rev-list', '-n', '30', 'HEAD']) ?? '').split('\n').filter(Boolean)
  }

  for (const hash of hashes) {
    const subject = git(['show', '-s', '--format=%s', hash]) ?? ''
    const parents = (git(['show', '-s', '--format=%P', hash]) ?? '').split(/\s+/).filter(Boolean)
    if (parents.length > 1) continue
    const files = (git(['show', '--name-only', '--format=', hash]) ?? '').split('\n').filter(Boolean)
    const spec = /^spec:/.test(subject)
    if (spec) {
      for (const file of files) {
        if (specAllowed(file)) continue
        errors.push(`spec 提交 ${short(hash)}（${subject}）改了 product/ 之外的文件：${file}`)
      }
      continue
    }
    for (const file of files) {
      if (isProduct(file)) errors.push(`非 spec 提交 ${short(hash)}（${subject}）改了 product/：${file}（规格变更请单独用 spec: 提交）`)
    }
    const hit = acceptanceHit(files)
    if (hit) {
      errors.push(
        `提交 ${short(hash)}（${subject}）修改了 product/ 登记的验收测试「${hit.value}」（${hit.file}:${hit.line}）：验收测试先写、实现者不改`,
      )
    }
  }

  const staged = (git(['diff', '--cached', '--name-only']) ?? '').split('\n').filter(Boolean)
  const statusFiles = (git(['status', '--porcelain']) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(2).trim()
      const arrow = rest.lastIndexOf(' -> ')
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, '')
    })

  const pendingSpecMix = (files) => {
    if (!files.some(isProduct)) return
    const stray = files.filter((file) => !specAllowed(file))
    if (stray.length === 0) return
    return `工作区同时改了 product/ 与 product/ 之外的文件（${stray.slice(0, 5).join('、')}${stray.length > 5 ? ' 等' : ''}）：spec 提交只能改 product/、AGENTS.md、docs/HANDOFF.md，请拆开`
  }
  const stagedMix = pendingSpecMix(staged)
  if (stagedMix) errors.push(`已暂存：${stagedMix}`)
  const workingMix = pendingSpecMix(statusFiles)
  if (workingMix && !stagedMix) warnings.push(`未暂存：${workingMix}`)

  const stagedHit = acceptanceHit(staged)
  if (stagedHit) errors.push(`已暂存：修改了 product/ 登记的验收测试「${stagedHit.value}」（${stagedHit.file}:${stagedHit.line}）`)
  const workingHit = acceptanceHit(statusFiles)
  if (workingHit && !stagedHit) {
    warnings.push(`未暂存：修改了 product/ 登记的验收测试「${workingHit.value}」（${workingHit.file}:${workingHit.line}）`)
  }
}

if (decisions.length > 0) notes.push(`decisions-check 共 ${decisions.length} 条用户决定，其中 ${decisions.filter((entry) => idsIn(entry.text).length > 0).length} 条已挂编号`)

// ---------- D. 核心模型唯一实现 ----------
const coreModelsFile = path.join(root, 'scripts/product-core-models.json')
const coreModelsText = readText(coreModelsFile)
if (!coreModelsText.trim()) {
  errors.push('scripts/product-core-models.json 不存在：核心模型（会话树、运行状态、模型能力、滚动位置）要登记唯一实现')
} else {
  let config
  try {
    config = JSON.parse(coreModelsText)
  } catch (error) {
    config = null
    errors.push(`scripts/product-core-models.json 不是合法 JSON：${error.message}`)
  }
  const models = Array.isArray(config?.models) ? config.models : []
  if (config && models.length === 0) errors.push('scripts/product-core-models.json 没有登记任何核心模型')

  const sourceFiles = []
  const packagesDir = path.join(root, 'packages')
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir)) {
      sourceFiles.push(
        ...walk(
          path.join(packagesDir, pkg, 'src'),
          (name) => /\.(?:ts|tsx)$/.test(name) && !/\.test\./.test(name),
        ),
      )
    }
  }

  for (const model of models) {
    const owners = Array.isArray(model.owner) ? model.owner : []
    if (!model.id || owners.length === 0 || !Array.isArray(model.features)) {
      errors.push(`核心模型登记不完整：${JSON.stringify(model).slice(0, 120)}（需要 id、owner、features）`)
      continue
    }
    // 允许的例外：明确的路径 + 理由。只用于「请求未返回时的离线兜底」这类不可避免的重复；
    // 命中后不再报同类实现，但会把理由打出来，避免悄悄保留第二套表。
    const exceptions = Array.isArray(model.exceptions) ? model.exceptions : []
    for (const exception of exceptions) {
      if (
        typeof exception?.path !== 'string' ||
        !exception.path.trim() ||
        typeof exception?.reason !== 'string' ||
        !exception.reason.trim()
      ) {
        errors.push(
          `核心模型 ${model.id} 的例外登记不完整：${JSON.stringify(exception).slice(0, 120)}（需要 path、reason）`,
        )
      }
    }
    const exceptionFor = (rel) => {
      for (const exception of exceptions) {
        if (typeof exception?.path !== 'string' || !exception.path) continue
        const prefix = exception.path.replace(/\/$/, '')
        if (rel === prefix || rel.startsWith(`${prefix}/`)) return exception
      }
      return null
    }
    const exceptionsHit = new Set()
    const features = []
    for (const feature of model.features) {
      try {
        features.push({
          re: new RegExp(feature.pattern),
          also: feature.also ? new RegExp(feature.also) : null,
        })
      } catch {
        errors.push(`核心模型 ${model.id} 的识别特征不是合法正则：${feature.pattern}`)
      }
    }
    const owned = (rel) => owners.some((owner) => rel === owner || rel.startsWith(`${owner.replace(/\/$/, '')}/`))
    for (const file of sourceFiles) {
      const rel = relPath(root, file)
      if (owned(rel)) continue
      const exception = exceptionFor(rel)
      if (exception) {
        exceptionsHit.add(exception)
        continue
      }
      const text = readText(file)
      for (const feature of features) {
        if (feature.also && !feature.also.test(text)) continue
        text.split('\n').forEach((line, index) => {
          if (!feature.re.test(line)) return
          report(
            `核心模型「${model.name ?? model.id}」在登记模块之外出现同类实现：${rel}:${index + 1}\n` +
              `      ${line.trim()}\n` +
              `      唯一实现应为 ${owners.join('、')}`,
          )
        })
      }
    }
    for (const exception of exceptions) {
      if (!exceptionsHit.has(exception)) {
        warnings.push(`核心模型 ${model.id} 登记的例外没有命中任何文件：${exception.path}`)
      } else {
        notes.push(
          `核心模型「${model.name ?? model.id}」允许的例外：${exception.path}（${exception.reason}）`,
        )
      }
    }
  }
}

// ---------- 输出 ----------
for (const note of notes) console.log(`提示 ${note}`)
for (const warning of warnings) console.log(`警告 ${warning}`)
for (const error of errors) console.log(`错误 ${error}`)
const summary = `领域 ${product.domains.length} 个，领域文件 ${product.domainFiles.length} 个，行为编号 ${product.ids.size} 条`
if (errors.length > 0 || (strict && warnings.length > 0)) {
  console.log(`\nproduct-check: ${summary}；${errors.length} 个错误，${warnings.length} 个警告`)
  process.exitCode = 1
} else {
  console.log(`\nproduct-check: 通过（${summary}；${warnings.length} 个警告）`)
}
