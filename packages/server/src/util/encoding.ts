// 子进程输出解码：Windows 下 cmd/PowerShell 与老程序常按系统代码页（中文为 GBK/CP936）输出，
// 直接按 UTF-8 读会得到乱码。先按 UTF-8 严格解码，失败再用 GBK 回退。

import { TextDecoder } from 'node:util';

const utf8 = new TextDecoder('utf-8', { fatal: true });
let gbk: TextDecoder | null | undefined;

function gbkDecoder(): TextDecoder | null {
  if (gbk === undefined) {
    try {
      gbk = new TextDecoder('gbk');
    } catch {
      // 精简 ICU 的 Node 不带 GBK，只能退回 UTF-8 有损解码。
      gbk = null;
    }
  }
  return gbk;
}

export function decodeProcessOutput(input: Uint8Array): string {
  if (input.length === 0) return '';
  try {
    return utf8.decode(input);
  } catch {
    const decoder = gbkDecoder();
    if (decoder) {
      try {
        return decoder.decode(input);
      } catch {
        /* 回退失败时按 UTF-8 有损解码 */
      }
    }
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8');
  }
}

/** Windows cmd.exe：先把控制台输出代码页切到 UTF-8，再执行原命令。 */
export function cmdUtf8Command(command: string): string {
  return `chcp 65001 >NUL & ${command}`;
}
