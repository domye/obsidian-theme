#!/usr/bin/env node
// domye 主题的体检工具。两种用法：
//
//   node tools/check-tokens.mjs                 静态检查（四种规则，见下）
//   node tools/check-tokens.mjs --verify-build  用 sass 重编译，与 theme.css 做归一化比对
//
// 为什么死变量只查 --domye- / --phycat-：
//   __variables.scss 与 __colors.scss 里大量变量是「覆盖 Obsidian 官方 API」
//   （--callout-* / --code-* / --tag-* …），由 Obsidian core 消费，本仓库零引用属正常。
//   只有主题自有命名空间下的零引用才是真正的死代码。
//
// 为什么裸字面量只报告不阻断：
//   现状 300+ 处，一次全报等于没报。先让它可见，等收敛到可维护数量再升级为 error。
//
// 归一化比对的语义：忽略注释与空白，逐 token 比较。忽略注释是因为 @settings 声明
//   块的物理顺序不影响 Style Settings 的行为；忽略空白是因为 sass 对生成的
//   selector list 的换行策略与手写不一致。属性、值、选择器 token、规则顺序全部参与比较。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareRuleMaps, parseCss } from './css-map.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCSS_DIR = join(ROOT, 'src/scss');
const THEME_CSS = join(ROOT, 'theme.css');
const OWN_PREFIX = /^--(domye|phycat)-/;

// ── 扫描器 ──────────────────────────────────────────────────────────────────
// 逐字符扫描 SCSS，产出：变量定义、变量引用、字面量、以及「块 → 声明」树。
// 记录的是源码块的边界（不是编译后的扁平结果），所以同块重复声明不会被嵌套规则干扰。

function scanFile(file, src) {
  const result = { file, defs: [], refs: [], literals: [], blocks: [], hasDynamicRef: false };
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

// ── 规则 ───────────────────────────────────────────────────────────────────

function checkDeadVars(scans) {
  const refs = new Set();
  let dynamic = false;
  for (const s of scans) {
    s.refs.forEach((r) => refs.add(r.name));
    dynamic = dynamic || s.hasDynamicRef;
  }
  const dead = [];
  for (const s of scans) {
    for (const d of s.defs) {
      // 名字本身带插值（如 --domye-radius-#{$name}）无法静态判定引用，交给 dynamic 提示
      if (d.name.includes('#')) continue;
      if (OWN_PREFIX.test(d.name) && !refs.has(d.name)) {
        dead.push({ ...d, file: rel(s.file) });
      }
    }
  }
  return { dead, dynamic };
}

function checkDuplicateDecls(scans) {
  const hits = [];
  for (const s of scans) {
    for (const block of s.blocks) {
      const seen = new Map();
      for (const d of block.decls) {
        if (seen.has(d.prop)) {
          hits.push({
            file: rel(s.file),
            line: d.line,
            prop: d.prop,
            selector: block.selector.replace(/\s+/g, ' ').slice(0, 70),
          });
        } else {
          seen.set(d.prop, d.line);
        }
      }
    }
  }
  return hits;
}

// _variables.scss / _colors.scss 是令牌层，字面量本来就该住在这里（README §4）。
const LITERAL_HOME = /_(variables|colors)\.scss$/;

function checkLiterals(scans) {
  return scans
    .filter((s) => !LITERAL_HOME.test(s.file))
    .map((s) => ({ file: rel(s.file), n: s.literals.length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
}

// Style Settings 面板的 default 值 ↔ Sass 令牌默认值。两处写同一个数字就会漂移，
// 这里把绑定关系写死成表：改了一边忘了另一边，跑 lint 就会报。
const DEFAULT_BINDINGS = [
  { yamlId: 'domye-radius', key: 'default', file: '_variables.scss', re: /\$radius-base:\s*([^;!]+)/ },
  { yamlId: 'domye-font-size', key: 'default', file: '_variables.scss', re: /\$font-size-base:\s*([^;!]+)/ },
  { yamlId: 'domye-heading-spacing', key: 'default', file: '_variables.scss', re: /\$heading-spacing:\s*([^;!]+)/ },
  { yamlId: 'domye-border-width', key: 'default', file: '_variables.scss', re: /\$border-width:\s*([^;!]+)/ },
  { yamlId: 'domye-accent', key: 'default', file: '_variables.scss', re: /\$accent:\s*([^;!]+)/ },
  { yamlId: 'secondary-color', key: 'default-light', file: '_variables.scss', re: /--secondary-color:\s*([^;]+)/ },
];

function checkDefaults(scans, sources) {
  const yaml = sources.map((s) => s.src).join('\n');
  const hits = [];
  for (const b of DEFAULT_BINDINGS) {
    const yamlValue = readYamlDefault(yaml, b.yamlId, b.key);
    const sassValue = readSassDefault(sources, b.file, b.re);
    if (yamlValue === null || sassValue === null) {
      hits.push({ id: `${b.yamlId}.${b.key}`, why: '找不到对应值（声明项或令牌被改名/删除？）' });
      continue;
    }
    if (normalizeDefault(yamlValue) !== normalizeDefault(sassValue)) {
      hits.push({ id: `${b.yamlId}.${b.key}`, why: `YAML=${yamlValue} ↔ Sass=${sassValue}` });
    }
  }
  return hits;
}

function readYamlDefault(text, id, key) {
  const at = text.indexOf(`id: ${id}\n`);
  if (at === -1) return null;
  const tail = text.slice(at, at + 2000);
  const m = tail.match(new RegExp(`^\\s+${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function readSassDefault(sources, file, re) {
  const hit = sources.find((s) => s.file.endsWith(file));
  if (!hit) return null;
  const m = hit.src.match(re);
  return m ? m[1].trim() : null;
}

function normalizeDefault(value) {
  return value
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(px|rem|em)$/i, '')
    .trim();
}

// ── 构建等价性 ──────────────────────────────────────────────────────────────
//
// 比较逻辑在 css-map.mjs（有独立的回归测试）。
// 这里只负责：编译源码、读基线、报差异。

// 低于这个条数就判定解析器出了问题，而不是「主题变小了」。
// 当前主题约 1380 条选择器：宽松，但远高于 0——空映射再也过不了。
const MIN_SELECTORS = 1000;

async function verifyBuild(goldenPath) {
  const { compile } = await import('sass');
  const golden = parseCss(readFileSync(goldenPath, 'utf8'));
  const fresh = parseCss(compile(join(SCSS_DIR, 'index.scss'), { style: 'expanded' }).css);
  const diff = compareRuleMaps(golden, fresh, MIN_SELECTORS);
  if (!diff) {
    console.log(`✓ 构建等价：${fresh.size} 条选择器与 ${rel(goldenPath)} 全部一致`);
    return 0;
  }
  console.error(`✗ 构建不等价：${rel(goldenPath)} 与重建结果有实质差异`);
  console.error(`  ${diff}`);
  return 1;
}

// ── 入口 ───────────────────────────────────────────────────────────────────

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

function report(label, items, isError, format) {
  if (!items.length) {
    console.log(`✓ ${label}`);
    return 0;
  }
  const mark = isError ? '✗' : '·';
  console.log(`${mark} ${label}：${items.length} 处`);
  items.slice(0, 20).forEach((x) => console.log(`    ${format(x)}`));
  if (items.length > 20) console.log(`    …还有 ${items.length - 20} 处`);
  return isError ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--verify-build');
  if (at !== -1) return verifyBuild(argv[at + 1] || THEME_CSS);

  const files = walkScss(SCSS_DIR);
  const scans = files.map((f) => scanFile(f, readFileSync(f, 'utf8')));
  const sources = files.map((f) => ({ file: f, src: readFileSync(f, 'utf8') }));

  const dupes = checkDuplicateDecls(scans);
  const { dead, dynamic } = checkDeadVars(scans);
  const literals = checkLiterals(scans);
  const defaults = checkDefaults(scans, sources);

  let code = 0;
  code += report('同一规则块内重复声明', dupes, true, (d) => `${d.file}:${d.line}  ${d.prop}  ← ${d.selector}`);
  code += report('Style Settings 默认值与令牌不一致', defaults, true, (d) => `${d.id}  ${d.why}`);
  if (dynamic) console.log('· 检测到动态 var(--#{...})，死变量检查仅供提示');
  report('主题自有命名空间下的零引用变量', dead, false, (d) => `${d.file}:${d.line}  ${d.name}`);
  report('裸字面量（应按 README §4 收敛进令牌）', literals, false, (l) => `${l.file}  ${l.n} 处`);

  if (code) console.error('\n有阻断项，未通过。');
  else console.log('\n静态检查通过。');
  return code;
}

process.exit(await main());
