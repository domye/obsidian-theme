// rules.mjs 的回归测试：规则只吃事实，所以每条都能喂假事实单测。
// 跑法：npm run test（node --test tools/）
//
// 这些用例存在的理由：面板与 SCSS 之间的契约以前只靠人肉对齐，
// 坏掉时的表现是「静默失效」（重命名选项值、拼错类名都不会有任何提示）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkDeadVars,
  checkDefaults,
  checkDuplicateDecls,
  checkLiterals,
  checkPanelClassConsumers,
} from './rules.mjs';

const scss = (rel, extra) => ({ rel, src: '', defs: [], refs: [], literals: [], blocks: [], ...extra });

test('同块内同属性写两遍会被报出（嵌套块不算同块）', () => {
  const facts = [
    scss('a.scss', {
      blocks: [
        { selector: '.a', decls: [{ prop: '--x', line: 1 }, { prop: '--x', line: 2 }] },
        { selector: '.b', decls: [{ prop: '--x', line: 3 }] },
      ],
    }),
  ];
  const hits = checkDuplicateDecls(facts);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].prop, '--x');
});

test('只报主题自有命名空间下的零引用变量', () => {
  const facts = [
    scss('a.scss', {
      defs: [{ name: '--domye-dead', line: 1 }, { name: '--phycat-dead', line: 2 }, { name: '--callout-x', line: 3 }],
      refs: [],
    }),
  ];
  const { dead } = checkDeadVars(facts);
  assert.deepEqual(
    dead.map((d) => d.name),
    ['--domye-dead', '--phycat-dead']
  );
});

test('名字带插值的定义不参与死变量判定，只给 dynamic 提示', () => {
  const facts = [
    scss('a.scss', { defs: [{ name: '--domye-radius-#{$name}', line: 1 }], hasDynamicRef: true }),
  ];
  const { dead, dynamic } = checkDeadVars(facts);
  assert.equal(dead.length, 0);
  assert.equal(dynamic, true);
});

test('令牌层文件不报裸字面量，组件文件才报', () => {
  const facts = [
    scss('_variables.scss', { literals: [{ line: 1, value: '#fff' }] }),
    scss('components/_editor.scss', { literals: [{ line: 1, value: '#fff' }, { line: 2, value: 'rgba(0,0,0,.5)' }] }),
  ];
  assert.deepEqual(checkLiterals(facts), [{ file: 'components/_editor.scss', n: 2 }]);
});

test('默认值漂移会报出，且读的是面板事实里的默认值', () => {
  const facts = [scss('_variables.scss', { src: '$radius-base: 4px;' })];
  const panel = [{ name: 'Editor', entries: [{ id: 'domye-radius', defaults: { default: '6' } }] }];
  const hit = checkDefaults(facts, panel).find((h) => h.id === 'domye-radius.default');
  assert.match(hit.why, /YAML=6 ↔ Sass=4px/);
});

test('绑定表里的条目或令牌整个找不到，也算违规（改名/删除时会报）', () => {
  const hit = checkDefaults([], []).find((h) => h.id === 'secondary-color.default-light');
  assert.equal(hit.why, '找不到对应值（声明项或令牌被改名/删除？）');
});

test('class-select 的每个选项值都必须有消费方', () => {
  const panel = [
    {
      name: 'Editor',
      entries: [
        {
          id: 'style-select',
          type: 'class-select',
          options: [{ value: 'style-a' }, { value: 'style-b' }],
        },
      ],
    },
  ];
  const hits = checkPanelClassConsumers(panel, new Set(['style-a']));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, 'style-b');
});

test('标了 # no-style 的选项不算死开关', () => {
  const panel = [
    {
      name: 'Editor',
      entries: [
        { id: 's', type: 'class-select', options: [{ value: 'x-default', noStyle: true }] },
      ],
    },
  ];
  assert.deepEqual(checkPanelClassConsumers(panel, new Set()), []);
});

test('class-toggle 的 id 本身必须是消费方用的类名', () => {
  const panel = [{ name: 'Editor', entries: [{ id: 'my-toggle', type: 'class-toggle', options: [] }] }];
  assert.equal(checkPanelClassConsumers(panel, new Set()).length, 1);
  assert.equal(checkPanelClassConsumers(panel, new Set(['my-toggle'])).length, 0);
});

test('非 class 类条目（颜色/文本/滑块）不参与该规则', () => {
  const panel = [
    {
      name: 'Editor',
      entries: [
        { id: 'link-color', type: 'variable-themed-color', options: [] },
        { id: 'radius', type: 'variable-number-slider', options: [] },
      ],
    },
  ];
  assert.deepEqual(checkPanelClassConsumers(panel, new Set()), []);
});
