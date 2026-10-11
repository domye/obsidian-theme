// css-map.mjs 的回归测试。跑法：npm run test（node --test tools/）
// 这些用例存在的理由：构建守卫唯一的安全性来自这个解析器，
// 而它坏掉时的表现是「两边都解析成空 → 报一致」。下面的用例会先失败。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compareRuleMaps, parseCss } from './css-map.mjs';

const decls = (map, sel) => map.get(sel);

test('解析单条规则', () => {
  const map = parseCss('a { color: red; }');
  assert.deepEqual(decls(map, 'a'), ['color: red']);
});

test('忽略注释，归一化多余空白', () => {
  const map = parseCss('/* 抬头 */\na\n{\n  color :   red ;\n}\n');
  assert.deepEqual(decls(map, 'a'), ['color: red']);
});

test('选择器列表按顶层逗号拆成多条', () => {
  const map = parseCss('a, b { color: red; }');
  assert.deepEqual(decls(map, 'a'), ['color: red']);
  assert.deepEqual(decls(map, 'b'), ['color: red']);
});

test(':is() / :not() 括号里的逗号不拆', () => {
  const map = parseCss('.x:is([data-id=a], [data-id=b]) { display: none; }');
  assert.deepEqual(decls(map, '.x:is([data-id=a], [data-id=b])'), ['display: none']);
});

test('不带引号的属性值按原样进 key', () => {
  const map = parseCss('p[data-task=i] { x: 1; }');
  assert.deepEqual(decls(map, 'p[data-task=i]'), ['x: 1']);
});

test('字符串里的花括号与分号不破坏层级', () => {
  const svg = "url('data:image/svg+xml;utf8,<svg><style>.a{fill:none;}</style></svg>')";
  const map = parseCss(`.x { background-image: ${svg}; color: red; }`);
  assert.equal(map.size, 1);
  assert.ok(decls(map, '.x')[0].startsWith('background-image: url('));
  assert.ok(decls(map, '.x')[0].endsWith('color: red'));
});

test('语句型 at-rule（@charset）不粘到下一个选择器上', () => {
  const map = parseCss('@charset "UTF-8";\nbody { color: red; }');
  assert.deepEqual([...map.keys()], ['body']);
});

test('@media 上下文进 key，规则不丢', () => {
  const map = parseCss('@media (max-width: 600px) { .x { color: red; } }');
  const keys = [...map.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes('@media (max-width: 600px)|.x'));
  assert.deepEqual(map.get(keys[0]), ['color: red']);
});

test('同一选择器的多条规则按先后顺序保留', () => {
  const map = parseCss('.x { color: red; }\n.x { color: blue; }');
  assert.deepEqual(decls(map, '.x'), ['color: red', 'color: blue']);
});

test('compareRuleMaps：相同返回 null，不同返回说明', () => {
  const a = parseCss('.x { color: red; }');
  const b = parseCss('.x { color: red; }');
  const c = parseCss('.x { color: blue; }');
  assert.equal(compareRuleMaps(a, b), null);
  assert.match(compareRuleMaps(a, c), /\.x/);
});

test('compareRuleMaps：空映射 + 下限，必须报异常而不是判等价', () => {
  const empty = parseCss('');
  assert.equal(empty.size, 0);
  const diff = compareRuleMaps(empty, empty, 1000);
  assert.ok(diff, '两边都解析成空时必须报错，否则守卫会空转通过');
  assert.match(diff, /解析结果异常/);
});

test('compareRuleMaps：低于下限的一侧同样要报', () => {
  const one = parseCss('.x { color: red; }');
  assert.equal(one.size, 1);
  assert.match(compareRuleMaps(one, one, 1000), /解析结果异常/);
});

test('冒烟：真实 theme.css 能解析出足够多的选择器', () => {
  const theme = parseCss(readFileSync(new URL('../theme.css', import.meta.url), 'utf8'));
  assert.ok(theme.size >= 1000, `只解析出 ${theme.size} 条选择器，解析器或产物有问题`);
  // 一条有代表性的、由 _visibility.scss 生成出来的规则
  const key = 'body:not(.border-focus-mode) .setting-item:is([data-id=line-active-bg], [data-id=line-normal-opacity])';
  assert.deepEqual(theme.get(key), ['display: none']);
});
