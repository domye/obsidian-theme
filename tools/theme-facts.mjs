// 事实层：把「文件」变成「数据」。
//
// 这一层是唯一的 I/O 与解析边界：往下是 sass 编译与逐字符 SCSS 扫描，往上是
// tools/rules.mjs 里的纯规则。规则只接收事实，因此可以喂假事实做单测，
// 也能在不动解析器的前提下加规则。
//
// 两套事实：
//   SCSS 事实  —— 每个 .scss 文件扫出的变量定义 / 引用 / 字面量 / 块→声明树
//   面板事实  —— src/scss/style-settings/_declarations.scss 里每个 @settings 块的条目

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── SCSS 事实 ──────────────────────────────────────────────────────────────
// 逐字符扫描 SCSS，产出：变量定义、变量引用、字面量、以及「块 → 声明」树。
// 记录的是源码块的边界（不是编译后的扁平结果），所以同块重复声明不会被嵌套规则干扰。

/// 读取目录下所有 .scss，返回事实列表（rel 是相对 scssDir 的路径，供规则按文件名匹配）。
export function readScssFacts(scssDir) {
  return walkScss(scssDir).map((file) => {
    const src = readFileSync(file, 'utf8');
    return { ...scanScss(src), rel: toRel(file, scssDir), src };
  });
}

export function scanScss(src) {
  const result = { defs: [], refs: [], literals: [], blocks: [], hasDynamicRef: false };
  const stack = [];
  let buf = '';
  let line = 1;
  let bufLine = 1;
  let i = 0;

  const flush = () => {
    const text = buf.trim();
    buf = '';
    if (!text || text.startsWith('@')) return;
    const decl = splitDeclaration(text);
    if (decl) {
      const block = stack[stack.length - 1];
      if (block) block.decls.push({ ...decl, line: bufLine });
      if (decl.prop.startsWith('--')) result.defs.push({ name: decl.prop, line: bufLine });
      collectRefs(decl.value, bufLine, result);
      collectLiterals(decl.value, bufLine, result);
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') line++;

    if (c === '/' && src[i + 1] === '/') {
      i = skipToLineEnd(src, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, end === -1 ? src.length : end + 2);
      line += chunk.split('\n').length - 1;
      i += chunk.length;
      continue;
    }
    if (c === '#') {
      const interp = readInterpolation(src, i);
      if (interp) {
        buf += interp;
        i += interp.length;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const str = readString(src, i);
      buf += str;
      i += str.length;
      continue;
    }
    if (c === '{') {
      stack.push({ selector: buf.trim(), line: bufLine, decls: [] });
      buf = '';
      i++;
      bufLine = line;
      continue;
    }
    if (c === '}') {
      flush();
      const done = stack.pop();
      if (done) result.blocks.push(done);
      i++;
      bufLine = line;
      continue;
    }
    if (c === ';') {
      flush();
      i++;
      bufLine = line;
      continue;
    }
    if (!buf.trim()) bufLine = line;
    buf += c;
    i++;
  }
  flush();
  return result;
}

function splitDeclaration(text) {
  const idx = text.indexOf(':');
  if (idx <= 0) return null;
  return { prop: text.slice(0, idx).trim(), value: text.slice(idx + 1).trim() };
}

function readString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === '\\') i++;
    i++;
  }
  return src.slice(start, Math.min(i + 1, src.length));
}

function readInterpolation(src, start) {
  if (src[start + 1] !== '{') return null;
  let depth = 1;
  let i = start + 2;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

function skipToLineEnd(src, start) {
  const end = src.indexOf('\n', start);
  return end === -1 ? src.length : end;
}

function collectRefs(value, line, result) {
  const re = /var\(\s*(--[^,)\s]+)/g;
  let m;
  while ((m = re.exec(value))) {
    if (m[1].includes('#')) {
      result.hasDynamicRef = true;
      continue;
    }
    result.refs.push({ name: m[1], line });
  }
}

const LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/;

function collectLiterals(value, line, result) {
  if (!LITERAL_RE.test(value)) return;
  result.literals.push({ line, value: value.trim().slice(0, 60) });
}

function walkScss(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walkScss(full));
    else if (entry.endsWith('.scss')) files.push(full);
  }
  return files;
}

function toRel(file, dir) {
  return file.slice(dir.length + 1).replace(/\\/g, '/');
}

// ── 面板事实 ───────────────────────────────────────────────────────────────
// Style Settings 的每个 `/* @settings … */` 注释块 = 面板上的一个顶层区。
// 块是无缩进的 YAML：name / id / settings: 下面一列以 `- ` 分隔的条目。
//
// 提取规则关心的东西：条目 id / type、class-select 的选项值（运行时会变成 body 上的 class，
// `# no-style` 后缀表示「刻意不写样式」）、以及 YAML 里写的默认值（键名保持原样）。

export function readPanelFacts(declarationsSrc) {
  const blocks = [];
  const blockRe = /\/\* @settings\n([\s\S]*?)\n\*\//g;
  let m;
  while ((m = blockRe.exec(declarationsSrc))) {
    const name = (m[1].match(/^name:\s*(.*)$/m) || [])[1]?.trim() ?? '';
    const bodyStart = m.index + '/* @settings\n'.length;
    blocks.push({
      name,
      line: lineAt(declarationsSrc, m.index),
      entries: readEntries(m[1], bodyStart, declarationsSrc),
    });
  }
  return blocks;
}

function readEntries(blockBody, bodyStart, declarationsSrc) {
  const settingsAt = blockBody.search(/^settings:\s*$/m);
  if (settingsAt === -1) return [];
  const region = blockBody.slice(settingsAt);
  // 条目的分隔符是行首的 `- `（标签/值里的 `-` 都有缩进，不会误伤）
  const marks = [...region.matchAll(/^[ \t]*-[ \t]*$/gm)].map((x) => x.index);
  return marks
    .map((at, i) => {
      const chunk = region.slice(at, i + 1 < marks.length ? marks[i + 1] : region.length);
      return readEntry(chunk, bodyStart + settingsAt + at, declarationsSrc);
    })
    .filter((e) => e.id);
}

function readEntry(chunk, offset, declarationsSrc) {
  const lines = chunk.split('\n');
  return {
    id: firstMatch(lines, /^\s*id:\s*(\S+)\s*$/),
    type: firstMatch(lines, /^\s*type:\s*(\S+)\s*$/),
    line: lineAt(declarationsSrc, offset),
    defaults: {
      default: firstMatch(lines, /^\s*default:\s*(.*)$/),
      'default-light': firstMatch(lines, /^\s*default-light:\s*(.*)$/),
      'default-dark': firstMatch(lines, /^\s*default-dark:\s*(.*)$/),
    },
    options: readOptions(lines),
  };
}

function readOptions(lines) {
  const at = lines.findIndex((l) => /^\s*options:\s*$/.test(l));
  if (at === -1) return [];
  const options = [];
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^\s*value:\s*(\S+)\s*(#.*)?$/);
    if (!m) continue;
    // 契约写在声明旁边：`value: xxx  # no-style` = 这个选项刻意没有对应样式
    const comment = (m[2] ?? '').replace(/^#\s*/, '');
    options.push({ value: m[1], noStyle: comment.startsWith('no-style'), comment });
  }
  return options;
}

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function firstMatch(lines, re) {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1];
  }
}

// ── 编译产物事实 ───────────────────────────────────────────────────────────

import { parseCss } from './css-map.mjs';

/// 用 sass 把入口编译成 CSS 字符串（等价性守卫与面板契约检查共用这一次编译）。
export async function compileScss(entryFile) {
  const { compile } = await import('sass');
  return compile(entryFile, { style: 'expanded' }).css;
}

/// 从编译产物里取出所有 class 名。
/// 只看选择器（parseCss 的 key），不看声明值，避免 data URI 里的 `.cls-1` 之类噪声；
/// 用现成解析器也就不会和 css-map.mjs 各写一套字符扫描。
export function classNamesFromCss(css) {
  const names = new Set();
  for (const selector of parseCss(css).keys()) {
    for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]);
  }
  return names;
}
