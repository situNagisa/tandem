// 读取 Tandem 反馈包：.tfb（zip 容器）、旧 .json 包与草稿目录。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** 单层相对文件名；拒绝绝对路径、`..` 与目录分隔。 */
export function safeEntryName(name) {
  const value = String(name ?? '')
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes('\0')) return null
  if (value.split('/').some((part) => part === '..' || part === '')) return null
  return value
}

export function isZipBuffer(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIG
}

/** 解析 zip（store / deflate 两种方法），返回 Map<文件名, Buffer>。 */
export function readZip(buffer) {
  let eocd = -1
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（缺少目录结尾）')
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) throw new Error('zip 目录项损坏')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`zip 条目损坏：${name}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(start, start + compressedSize)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`不支持的压缩方法 ${method}（${name}）`)
    const safe = safeEntryName(name)
    if (safe) entries.set(safe, Buffer.from(data))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function normalizeManifest(manifest) {
  const items = Array.isArray(manifest?.items) ? manifest.items : []
  return {
    version: manifest?.version ?? 1,
    kind: manifest?.kind === 'verification' ? 'verification' : 'feedback',
    exportedAt: manifest?.exportedAt ?? null,
    app: manifest?.app ?? { name: 'Tandem', version: '' },
    env: manifest?.env ?? {},
    snapshotPrefs: manifest?.snapshotPrefs,
    items,
    featureGroups: Array.isArray(manifest?.featureGroups) ? manifest.featureGroups : [],
    causeGroups: Array.isArray(manifest?.causeGroups) ? manifest.causeGroups : [],
    pageShots: Array.isArray(manifest?.pageShots) ? manifest.pageShots : [],
    receipt: manifest?.receipt ?? null,
    checklist: typeof manifest?.checklist === 'string' ? manifest.checklist : null,
    errors: Array.isArray(manifest?.errors) ? manifest.errors : [],
    draft: manifest?.draft ?? null,
  }
}

/**
 * 统一入口：返回 { type: 'json' | 'archive' | 'draft', items, manifest?, files? }
 * - .json：旧反馈包，图片是 dataURL
 * - .tfb/.zip：zip 容器，图片是独立文件
 * - 目录：桌面草稿目录
 */
export function loadFeedbackSource(input) {
  const target = path.resolve(input)
  if (!existsSync(target)) throw new Error(`文件不存在: ${target}`)
  const stat = statSync(target)

  if (stat.isDirectory()) {
    const files = new Map()
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (entry.name.startsWith('.tmp-')) continue
      const safe = safeEntryName(entry.name)
      if (!safe) continue
      files.set(safe, readFileSync(path.join(target, safe)))
    }
    const raw = files.get('manifest.json')
    if (!raw) throw new Error('草稿目录里没有 manifest.json')
    const manifest = normalizeManifest(JSON.parse(raw.toString('utf8')))
    return { type: 'draft', dir: target, manifest, files, items: manifest.items }
  }

  const buffer = readFileSync(target)
  if (/\.json$/i.test(target) || (!isZipBuffer(buffer) && buffer[0] === 0x7b)) {
    const data = JSON.parse(buffer.toString('utf8'))
    return { type: 'json', data, items: Array.isArray(data.items) ? data.items : [] }
  }
  if (!isZipBuffer(buffer)) throw new Error('无法识别：既不是 JSON，也不是 .tfb（zip）包')
  const files = readZip(buffer)
  const raw = files.get('manifest.json')
  if (!raw) throw new Error('反馈包里没有 manifest.json')
  const manifest = normalizeManifest(JSON.parse(raw.toString('utf8')))
  return { type: 'archive', manifest, files, items: manifest.items }
}
