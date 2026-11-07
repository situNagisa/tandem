/** 去掉记忆文件首行的 Tandem 内部元数据，只保留用户可见正文。 */
export function stripMemoryMeta(text: string): string {
  return text.replace(/^<!--\s*tandem-memory[\s\S]*?-->\s*/, '')
}
