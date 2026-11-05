// 文本/错误处理小工具。
export const MAX_TOOL_OUTPUT = 30_000;

/** 超长时保留头尾、省略中间，避免浪费上下文。 */
export function truncateMiddle(text: string, max = MAX_TOOL_OUTPUT, headRatio = 0.7): string {
  if (text.length <= max) return text;
  const keep = max - 60;
  const head = Math.floor(keep * headRatio);
  const tail = keep - head;
  return `${text.slice(0, head)}\n\n…[已截断 ${text.length - keep} 字符]…\n\n${text.slice(-tail)}`;
}

export function truncateEnd(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 40)}\n…[已截断 ${text.length - max + 40} 字符]`;
}

export function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError')
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
