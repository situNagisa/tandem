import type {
  PermissionRequest,
  PreviewSelection,
  Profile,
  SlashCommand,
} from '@tandem/protocol'

export const EMPTY_PROFILES: Profile[] = []
export const EMPTY_PENDING: PermissionRequest[] = []
export const EMPTY_COMMANDS: SlashCommand[] = []
export const EMPTY_SELECTIONS: PreviewSelection[] = []

export const SOURCE_LABEL: Record<SlashCommand['source'], string> = {
  builtin: '内置',
  project: '项目',
  user: '用户',
  skill: '技能',
}

export interface Attachment {
  id: string
  mediaType: string
  dataBase64: string
  name: string
}

export interface PastedText {
  id: string
  text: string
  lines: number
}

export const PASTE_COLLAPSE_THRESHOLD = 2000

export const MAX_ATTACHMENTS = 6
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 剪贴板常把同一张图以多个 File 实例给出，用 类型+大小+头部字节 去重。 */
export async function imageFingerprint(file: File): Promise<string> {
  let head = ''
  try {
    const bytes = new Uint8Array(await file.slice(0, 96).arrayBuffer())
    for (const b of bytes) head += b.toString(16).padStart(2, '0')
  } catch {
    head = file.name
  }
  return `${file.type}:${file.size}:${head}`
}
