// rules.mjs 的回归测试：规则只吃事实，所以每条都能喂假事实单测。
// 跑法：npm run test（node --test tools/）
//
// 这些用例存在的理由：面板与 SCSS 之间的契约以前只靠人肉对齐，
// 坏掉时的表现是「静默失效」（重命名选项值、拼错类名都不会有任何提示）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkAnimLiterals,
  checkDeadVars,
  checkDefaults,
  checkDuplicateDecls,
  checkLiterals,
  checkPanelClassConsumers,
  checkPanelTokenConsumers,
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

test('动效字面量：曲线与 0.3s 该写令牌，令牌定义处（_reset.scss）不报', () => {
  const decls = (value, line) => [{ prop: 'transition', value, line }];
  const facts = [
    scss('foundations/_reset.scss', { blocks: [{ selector: 'body', decls: decls('cubic-bezier(0.25, 0.8, 0.25, 1)', 1) }] }),
    scss('foundations/_typography.scss', {
      blocks: [{ selector: 'h1', decls: [...decls('color 0.3s ease', 3), ...decls('cubic-bezier(0.4, 0, 0.2, 1)', 4)] }],
    }),
    scss('components/_editor.scss', {
      blocks: [{ selector: '.x', decls: decls('transform 0.35s ease', 5) }],
    }),
  ];
  const hits = checkAnimLiterals(facts);
  assert.deepEqual(hits.map((h) => [h.file, h.line, h.want]), [
    ['foundations/_typography.scss', 3, 'var(--anim-duration-moderate)'],
    ['foundations/_typography.scss', 4, 'var(--anim-ease-standard)'],
  ]);
});

test('默认值漂移会报出，且读的是面板事实里的默认值', () => {
  // 令牌默认值也走事实层（不再由规则自己去源码里写正则抓）
  const facts = [scss('_variables.scss', { sassVars: [{ name: '$radius-base', value: '4px !default' }] })];
  const panel = [{ name: 'Editor', entries: [{ id: 'domye-radius', defaults: { default: '6' } }] }];
  const hit = checkDefaults(facts, panel).find((h) => h.id === 'domye-radius.default');
  assert.match(hit.why, /YAML=6 ↔ Sass=4px/);
});

test('令牌默认值两处一致时不报（!default 标志不算值）', () => {
  const facts = [scss('_variables.scss', { sassVars: [{ name: '$radius-base', value: '4px !default' }] })];
  const panel = [{ name: 'Editor', entries: [{ id: 'domye-radius', defaults: { default: '4px' } }] }];
  const hits = checkDefaults(facts, panel).map((h) => h.id);
  assert.equal(hits.includes('domye-radius.default'), false, `不该报：${hits.join(', ')}`);
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

test('会写变量的选项，主题里没有同名变量就是死选项', () => {
  const panel = [
    {
      name: 'Components',
      entries: [{ id: 'background-mod-left-CSS-light', type: 'variable-text', line: 525, options: [] }],
    },
  ];
  const hits = checkPanelTokenConsumers(panel, new Set());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 525);
  assert.match(hits[0].why, /--background-mod-left-CSS-light/);
});

test('主题里有同名变量（定义或引用）就不报', () => {
  const panel = [{ name: 'Editor', entries: [{ id: 'code-normal', type: 'variable-themed-color', options: [] }] }];
  assert.deepEqual(checkPanelTokenConsumers(panel, new Set(['--code-normal'])), []);
});

test('标了 # core-consumed 的选项不报（值交给 Obsidian core 读）', () => {
  const panel = [
    { name: 'Editor', entries: [{ id: 'graph-text', type: 'variable-themed-color', coreConsumed: true, options: [] }] },
  ];
  assert.deepEqual(checkPanelTokenConsumers(panel, new Set()), []);
});

test('class 类选项不参与「变量没人读」这条规则（它们写的是 body 上的类）', () => {
  const panel = [{ name: 'Editor', entries: [{ id: 'colorful-folder', type: 'class-toggle', options: [] }] }];
  assert.deepEqual(checkPanelTokenConsumers(panel, new Set()), []);
});
