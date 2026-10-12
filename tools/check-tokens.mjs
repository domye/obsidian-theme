#!/usr/bin/env node
// domye 主题的体检入口。两种用法：
//
//   node tools/check-tokens.mjs                 静态检查（见 tools/rules.mjs 里的各条规则）
//   node tools/check-tokens.mjs --verify-build  用 sass 重编译，与 theme.css 做归一化比对
//
// 这里只做三件事：读事实（tools/theme-facts.mjs）、跑规则（tools/rules.mjs，有单测）、打印。
// 规则加了/改了都发生在 rules.mjs 里，本文件不需要知道规则细节。
//
// 归一化比对的语义：忽略注释与空白，逐 token 比较。忽略注释是因为 @settings 声明
//   块的物理顺序不影响 Style Settings 的行为；忽略空白是因为 sass 对生成的
//   selector list 的换行策略与手写不一致。属性、值、选择器 token、规则顺序全部参与比较。
//   比较逻辑在 css-map.mjs（有独立的回归测试）。

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareRuleMaps, parseCss } from './css-map.mjs';
import { classNamesFromCss, compileScss, readPanelFacts, readScssFacts } from './theme-facts.mjs';
import {
  checkDeadVars,
  checkDefaults,
  checkDuplicateDecls,
  checkLiterals,
  checkPanelClassConsumers,
} from './rules.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCSS_DIR = join(ROOT, 'src/scss');
const ENTRY = join(SCSS_DIR, 'index.scss');
const THEME_CSS = join(ROOT, 'theme.css');
const DECLARATIONS = join(SCSS_DIR, 'style-settings/_declarations.scss');

// 低于这个条数就判定解析器出了问题，而不是「主题变小了」。
// 当前主题约 1400 条选择器：宽松，但远高于 0——空映射再也过不了。
const MIN_SELECTORS = 1000;

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

function verifyBuild(goldenPath, css) {
  const golden = parseCss(readFileSync(goldenPath, 'utf8'));
  const fresh = parseCss(css);
  const diff = compareRuleMaps(golden, fresh, MIN_SELECTORS);
  if (!diff) {
    console.log(`✓ 构建等价：${fresh.size} 条选择器与 ${rel(goldenPath)} 全部一致`);
    return 0;
  }
  console.error(`✗ 构建不等价：${rel(goldenPath)} 与重建结果有实质差异`);
  console.error(`  ${diff}`);
  return 1;
}

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
  const scssFacts = readScssFacts(SCSS_DIR);
  const css = await compileScss(ENTRY);

  if (at !== -1) return verifyBuild(argv[at + 1] || THEME_CSS, css);

  const panel = readPanelFacts(readFileSync(DECLARATIONS, 'utf8'));

  const dupes = checkDuplicateDecls(scssFacts);
  const { dead, dynamic } = checkDeadVars(scssFacts);
  const literals = checkLiterals(scssFacts);
  const defaults = checkDefaults(scssFacts, panel);
  const danglingOptions = checkPanelClassConsumers(panel, classNamesFromCss(css));

  let code = 0;
  code += report('同一规则块内重复声明', dupes, true, (d) => `${d.file}:${d.line}  ${d.prop}  ← ${d.selector}`);
  code += report('Style Settings 默认值与令牌不一致', defaults, true, (d) => `${d.id}  ${d.why}`);
  code += report(
    '面板选项没有消费方（死开关）',
    danglingOptions,
    true,
    (d) => `${rel(DECLARATIONS)}:${d.line}  [${d.block}] ${d.id} → ${d.value}：${d.why}`
  );
  if (dynamic) console.log('· 检测到动态 var(--#{...})，死变量检查仅供提示');
  report('主题自有命名空间下的零引用变量', dead, false, (d) => `${d.file}:${d.line}  ${d.name}`);
  report('裸字面量（应按 README §4 收敛进令牌）', literals, false, (l) => `${l.file}  ${l.n} 处`);

  if (code) console.error('\n有阻断项，未通过。');
  else console.log('\n静态检查通过。');
  return code;
}

process.exit(await main());
