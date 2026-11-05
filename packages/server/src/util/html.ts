// 极简 HTML 转纯文本，用于 WebFetch。
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const n = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    if (code.startsWith('#')) {
      const n = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

export function htmlToText(html: string): string {
  let text = html;
  // 去掉不可见内容
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  // 块级元素转换行
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote|table|ul|ol)>/gi, '\n');
  text = text.replace(/<(hr)\s*\/?>/gi, '\n---\n');
  // 图片保留 alt
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => (alt ? `[图片: ${alt}]` : ''));
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  // 压缩空白
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
