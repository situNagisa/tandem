// 浏览器与服务端共用的字节编码工具（只依赖 Uint8Array / btoa / atob）。

export function b64u(data: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(text: string): Uint8Array {
  const std = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 指纹统一为小写 64 位十六进制（去掉 `sha256:`、冒号、空格）。 */
export function normalizeFingerprint(text: string): string {
  return text.toLowerCase().replace(/^sha256:/, '').replace(/[^0-9a-f]/g, '');
}
