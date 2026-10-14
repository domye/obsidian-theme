// theme-facts.mjs 的回归测试：面板解析与 class 提取是契约检查的输入端，
// 它们坏掉时的表现同样是「静默漏报」，所以钉住几组真实形状。
// 跑法：npm run test（node --test tools/）

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { classNamesFromCss, readPanelFacts, readScssFacts, scanScss, tokenNamesFromCss } from './theme-facts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DECLARATIONS = join(ROOT, 'src/scss/style-settings/_declarations.scss');

const BLOCK = (entries) => `/* @settings

name: 测试块
id: test
settings:
${entries}
*/

`;

test('解析面板块：条目 id / type / 选项值 / 默认值', () => {
  const src = BLOCK(`    - 
        id: my-select
        title: 选择
        type: class-select
        default: style-a
        options:
            -   label: A
                value: style-a
            -   label: B
                value: style-b
    - 
        id: my-toggle
        title: 开关
        type: class-toggle`);
  const [block] = readPanelFacts(src);
  assert.equal(block.name, '测试块');
  assert.equal(block.entries.length, 2);
  assert.deepEqual(block.entries[0].options, [
    { value: 'style-a', noStyle: false, comment: '' },
    { value: 'style-b', noStyle: false, comment: '' },
  ]);
  assert.equal(block.entries[0].defaults.default, 'style-a');
  assert.equal(block.entries[1].type, 'class-toggle');
});

test('`value: xxx  # no-style …` 被识别为刻意不写样式', () => {
  const src = BLOCK(`    - 
        id: my-select
        type: class-select
        options:
            -   label: 默认
                value: style-default  # no-style 默认样式不需要 class
            -   label: A
                value: style-a`);
  const [entry] = readPanelFacts(src)[0].entries;
  assert.equal(entry.options[0].noStyle, true);
  assert.equal(entry.options[1].noStyle, false);
});

test('条目行号可用于报错定位', () => {
  const src = BLOCK(`    - 
        id: my-toggle
        type: class-toggle`);
  assert.equal(readPanelFacts(src)[0].entries[0].line, 6);
});

test('class 提取只看选择器，不看声明值里的 data URI', () => {
  const css = '.a-x { background-image: url("data:image/svg+xml,<svg class=\'cls-1\'/>"); }\n.b-y { color: red; }';
  const names = classNamesFromCss(css);
  assert.deepEqual([...names].sort(), ['a-x', 'b-y']);
});

test('嵌套列表（alt-format）的 `-` 不算面板条目', () => {
  const src = BLOCK(`    - 
        id: bg
        type: variable-color
        alt-format:
            -
                id: accent-rgb
                format: rgb
    - 
        id: next-one
        type: variable-text`);
  const ids = readPanelFacts(src)[0].entries.map((e) => e.id);
  assert.deepEqual(ids, ['bg', 'next-one']);
});

test('`# core-consumed` 写在 id 那行，被解析为「由 core 消费」', () => {
  const src = BLOCK(`    - 
        id: graph-text  # core-consumed：Obsidian core 读它
        type: variable-themed-color
    - 
        id: my-token
        type: variable-text`);
  const [core, own] = readPanelFacts(src)[0].entries;
  assert.equal(core.id, 'graph-text');
  assert.equal(core.coreConsumed, true);
  assert.equal(own.coreConsumed, false);
});

test('tokenNamesFromCss：认得定义与 var() 引用，忽略注释里的变量名', () => {
  const css = '/* 这里提到 --commented-out 不算 */\n:root { --a: 1; }\n.x { color: var(--b); }\n';
  const names = tokenNamesFromCss(css);
  assert.deepEqual([...names].sort(), ['--a', '--b']);
});

test('冒烟：真实 declarations 能解析出 7 个面板块与足够多的条目', () => {
  const blocks = readPanelFacts(readFileSync(DECLARATIONS, 'utf8'));
  assert.equal(blocks.length, 7);
  const entries = blocks.flatMap((b) => b.entries);
  assert.ok(entries.length > 400, `条目数 ${entries.length}`);
  const withOptions = entries.filter((e) => e.options.length > 0);
  assert.ok(withOptions.length > 20, `带选项的条目 ${withOptions.length}`);
  // `accent-rgb` 是 alt-format 的嵌套 id，不是面板选项（以前它会被当成条目混进来）
  assert.equal(entries.some((e) => e.id === 'accent-rgb'), false);
  assert.ok(entries.some((e) => e.coreConsumed), '至少有一条 # core-consumed');
});

test('scanScss 记录块边界：嵌套规则里的同名声明不算同块重复', () => {
  const facts = scanScss('.a { --x: 1; .b { --x: 2; } }');
  assert.equal(facts.blocks.length, 2);
  assert.deepEqual(
    facts.blocks.map((b) => b.decls.map((d) => d.prop)),
    [['--x'], ['--x']]
  );
});

test('scanScss：自定义属性带 name+value，块里的 $局部变量不当成令牌默认值', () => {
  const facts = scanScss([':root { --secondary-color: #bd93f9; }', '$radius-base: 4px !default;', '.a { $local: 1px; }'].join('\n'));
  assert.deepEqual(facts.defs.map((d) => [d.name, d.value]), [['--secondary-color', '#bd93f9']]);
  assert.deepEqual(facts.sassVars.map((d) => [d.name, d.value]), [['$radius-base', '4px !default']]);
});

test('冒烟：真实 _variables.scss 能取出默认值（漂移检查的输入）', () => {
  const facts = readScssFacts(join(ROOT, 'src/scss'));
  const vars = facts.find((f) => f.rel === '_variables.scss');
  assert.equal(vars.sassVars.find((d) => d.name === '$radius-base').value, '4px !default');
  assert.equal(vars.defs.find((d) => d.name === '--secondary-color').value, '#bd93f9');
});
