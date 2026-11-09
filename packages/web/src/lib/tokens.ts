/** 与 Host 侧 estimateTokens 同口径的粗略估算：字符数 / 3.5。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

/** 图片按 Host 侧估算口径计 1200 token。 */
export const IMAGE_TOKEN_ESTIMATE = 1200

export function estimateInputTokens(input: {
  text: string
  attachments?: number
}): number {
  return estimateTextTokens(input.text) + (input.attachments ?? 0) * IMAGE_TOKEN_ESTIMATE
}
