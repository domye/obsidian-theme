// 把 CSS 解析成「单条选择器 → 它命中的声明列表」的映射，用来比较两份样式表是否语义相同。
//
// 为什么不是逐字节比文本：
//   - 注释位置无所谓（@settings 声明块的顺序不影响插件行为）
//   - 一条 163 段选择器的规则拆成 133 条规则，行为完全一样，但文本差得远
// 比较单位的取舍：
//   - 选择器、属性、值、以及同一选择器上多条规则的先后顺序都参与比较
//   - 字符串里的内容原样保留（data:image/svg+xml,... 这类值不会被拆坏影响判断）

const AT_RULE_WITH_BLOCK = /^@(media|supports|layer|container|scope|document|keyframes|font-face|property)/;

/// 解析整份 CSS。返回 Map<上下文+选择器, 声明字符串数组>。
export function parseCss(css) {
  const out = new Map();
  walkBlocks(stripComments(css), '', out);
  return out;
}

/// 规模下限：主题当前约 1400 条选择器，低于这个数就判定「解析器坏了」而不是「主题变小了」。
/// 默认值保留 1（比对小片 CSS 的调用方不该被主题规模约束），整主题的守卫显式传它。
export const MIN_SELECTORS = 1000;

/// 比较两份映射。相同返回 null，不同返回一段可直接打印的差异说明。
/// minRules：低于这个条数就判定「解析异常」而不是「等价」——防止解析器坏掉时
/// 两边都得到空映射、于是报「一致」。调用方按实际规模给它下限。
export function compareRuleMaps(golden, fresh, minRules = 1) {
  if (golden.size < minRules || fresh.size < minRules) {
    return `解析结果异常：golden ${golden.size} 条选择器 / fresh ${fresh.size} 条，低于下限 ${minRules}。` +
      '守卫拒绝在此情况下判「等价」。';
  }
  for (const key of new Set([...golden.keys(), ...fresh.keys()])) {
    const a = JSON.stringify(golden.get(key) ?? null);
    const b = JSON.stringify(fresh.get(key) ?? null);
    if (a !== b) return `${key}\n    golden: ${a}\n    fresh : ${b}`;
  }
  return null;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function walkBlocks(src, context, out) {
  let i = 0;
  let buf = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      const head = buf.trim();
      buf = '';
      const body = readBraced(src, i);
      i = body.end;
      if (AT_RULE_WITH_BLOCK.test(head)) {
        walkBlocks(body.text, `${context}${head}|`, out);
        continue;
      }
      recordRule(context, head, body.text, out);
      continue;
    }
    if (c === '}') break;
    if (c === ';') {
      // 语句型 at-rule（@charset / @import）没有块。清掉缓冲区，
      // 否则它会被当成下一个选择器的一部分（键变成 `@charset "UTF-8"; body`）。
      buf = '';
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const str = readQuoted(src, i);
      buf += str;
      i += str.length;
      continue;
    }
    buf += c;
    i++;
  }
}

/// 读出 `{...}` 的内容。字符串里的花括号不算层级（data:image/svg+xml 里有花括号）。
function readBraced(src, open) {
  let depth = 1;
  let i = open + 1;
  const start = i;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i += readQuoted(src, i).length;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return { text: src.slice(start, i), end: i + 1 };
}

function readQuoted(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === '\\') i++;
    i++;
  }
  return src.slice(start, Math.min(i + 1, src.length));
}

function recordRule(context, selectorList, body, out) {
  const decls = normalizeDeclarations(body);
  for (const sel of splitSelectors(selectorList)) {
    const key = context + sel;
    const list = out.get(key) || [];
    list.push(decls);
    out.set(key, list);
  }
}

function normalizeDeclarations(body) {
  return body
    .split(';')
    .map(normalizeDeclaration)
    .filter(Boolean)
    .join(';');
}

/// 归一化一条声明：只动第一个冒号两侧的空白，值里的冒号（url(data:...) 之类）原样保留。
function normalizeDeclaration(part) {
  const text = part.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const colon = text.indexOf(':');
  if (colon < 0) return text;
  return `${text.slice(0, colon).trim()}: ${text.slice(colon + 1).trim()}`;
}

/// 按顶层逗号切选择器列表。括号内的逗号属于 :is()/:not()/:has() 的参数，不切。
function splitSelectors(text) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const c of text) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  parts.push(buf);
  return parts.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
