// 轻量 glob 匹配（支持 **、*、?、[...]、{a,b}），避免引入额外依赖。

const cache = new Map<string, RegExp[]>();

/** 展开花括号：{a,b}/x -> [a/x, b/x]，支持嵌套。 */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [pattern];
  const prefix = pattern.slice(0, open);
  const body = pattern.slice(open + 1, close);
  const suffix = pattern.slice(close + 1);
  const alternatives: string[] = [];
  let level = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') level++;
    else if (body[i] === '}') level--;
    else if (body[i] === ',' && level === 0) {
      alternatives.push(body.slice(start, i));
      start = i + 1;
    }
  }
  alternatives.push(body.slice(start));
  return alternatives.flatMap((alt) => expandBraces(prefix + alt + suffix));
}

function compileOne(pattern: string): RegExp {
  let re = '';
  const hasSlash = pattern.includes('/');
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) {
        re += '\\[';
      } else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if ('\\^$+.|()'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const prefix = hasSlash ? '' : '(?:.*/)?';
  return new RegExp(`^${prefix}${re}$`);
}

/** 相对路径（posix 分隔符）是否匹配 pattern。 */
export function matchGlob(relPath: string, pattern: string): boolean {
  let compiled = cache.get(pattern);
  if (!compiled) {
    compiled = expandBraces(pattern.replace(/\\/g, '/')).map(compileOne);
    cache.set(pattern, compiled);
  }
  return compiled.some((re) => re.test(relPath));
}
