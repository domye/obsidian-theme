// 规则层：只接收事实，只返回违规列表。没有 I/O、没有 sass、没有 console。
//
// 这样每条规则都能喂假事实做单测（tools/rules.test.mjs），CLI（tools/check-tokens.mjs）
// 只负责读事实、跑规则、打印。加一条规则 = 加一个函数 + 在 CLI 里挂一行。

// ── 同一规则块内重复声明 ───────────────────────────────────────────────────

export function checkDuplicateDecls(scssFacts) {
  const hits = [];
  for (const s of scssFacts) {
    for (const block of s.blocks) {
      const seen = new Map();
      for (const d of block.decls) {
        if (seen.has(d.prop)) {
          hits.push({
            file: s.rel,
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

// ── 死变量 ─────────────────────────────────────────────────────────────────
// 只查 --domye- / --phycat-：_variables.scss 与 _colors.scss 里大量变量是「覆盖
// Obsidian 官方 API」（--callout-* / --code-* / --tag-* …），由 core 消费，零引用属正常。

const OWN_PREFIX = /^--(domye|phycat)-/;

export function checkDeadVars(scssFacts) {
  const refs = new Set();
  let dynamic = false;
  for (const s of scssFacts) {
    s.refs.forEach((r) => refs.add(r.name));
    dynamic = dynamic || s.hasDynamicRef;
  }
  const dead = [];
  for (const s of scssFacts) {
    for (const d of s.defs) {
      // 名字本身带插值（如 --domye-radius-#{$name}）无法静态判定引用，交给 dynamic 提示
      if (d.name.includes('#')) continue;
      if (OWN_PREFIX.test(d.name) && !refs.has(d.name)) {
        dead.push({ file: s.rel, line: d.line, name: d.name });
      }
    }
  }
  return { dead, dynamic };
}

// ── 裸字面量（只报告）──────────────────────────────────────────────────────
// _variables.scss / _colors.scss 是令牌层，字面量本来就该住在这里（README §4）。

const LITERAL_HOME = /_(variables|colors)\.scss$/;

export function checkLiterals(scssFacts) {
  return scssFacts
    .filter((s) => !LITERAL_HOME.test(s.rel))
    .map((s) => ({ file: s.rel, n: s.literals.length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
}

// ── Style Settings 默认值 ↔ Sass 令牌默认值 ────────────────────────────────
// 两处写同一个数字就会漂移，所以把绑定关系写死成表：改了一边忘了另一边，跑 lint 就报。
// 表里写的是令牌名（`$radius-base` / `--secondary-color`），值从事实层取；
// 不在这里对源码重写正则——那种写法把「文件长什么样」编进了规则里。

export const DEFAULT_BINDINGS = [
  { id: 'domye-radius', key: 'default', file: '_variables.scss', token: '$radius-base' },
  { id: 'domye-font-size', key: 'default', file: '_variables.scss', token: '$font-size-base' },
  { id: 'domye-heading-spacing', key: 'default', file: '_variables.scss', token: '$heading-spacing' },
  { id: 'domye-border-width', key: 'default', file: '_variables.scss', token: '$border-width' },
  { id: 'domye-accent', key: 'default', file: '_variables.scss', token: '$accent' },
  { id: 'secondary-color', key: 'default-light', file: '_variables.scss', token: '--secondary-color' },
];

export function checkDefaults(scssFacts, panelBlocks) {
  const entries = new Map(panelBlocks.flatMap((b) => b.entries.map((e) => [e.id, e])));
  const hits = [];
  for (const b of DEFAULT_BINDINGS) {
    const entry = entries.get(b.id);
    const yamlValue = entry?.defaults?.[b.key] ?? null;
    const sassValue = readTokenDefault(scssFacts, b.file, b.token);
    if (yamlValue === null || sassValue === null) {
      hits.push({ id: `${b.id}.${b.key}`, why: '找不到对应值（声明项或令牌被改名/删除？）' });
      continue;
    }
    if (normalizeDefault(yamlValue) !== normalizeDefault(sassValue)) {
      hits.push({ id: `${b.id}.${b.key}`, why: `YAML=${yamlValue} ↔ Sass=${sassValue}` });
    }
  }
  return hits;
}

/// 从事实里取令牌的默认值：`$x`（文件顶层的 sass 变量）或 `--x`（自定义属性定义）。
function readTokenDefault(scssFacts, file, token) {
  const hit = scssFacts.find((s) => s.rel.endsWith(file));
  if (!hit) return null;
  const pool = token.startsWith('--') ? hit.defs : hit.sassVars;
  const def = (pool ?? []).find((d) => d.name === token);
  return def ? def.value : null;
}

function normalizeDefault(value) {
  return value
    .replace(/!\s*[a-z-]+/g, '') // sass 的 !default 标志不算值的一部分
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(px|rem|em)$/i, ''); // 4px 与 4 是同一个默认值
}

// ── 动效字面量 ────────────────────────────────────────────────────────────
// _reset.scss 里那几条动画令牌（--anim-duration-* / --anim-ease-*）就是「全站动效的旋钮」。
// 组件层再写一遍字面量，旋钮就只管控一半——而且写完之后没人能看出哪一半被控。

const ANIM_TOKEN_HOME = /_reset\.scss$/;

const ANIM_LITERALS = [
  { re: /(^|[^\d.])0\.3s\b/, want: 'var(--anim-duration-moderate)' },
  { re: /cubic-bezier\(0\.25, 0\.8, 0\.25, 1\)/, want: 'var(--anim-ease-smooth)' },
  { re: /cubic-bezier\(0\.4, 0, 0\.2, 1\)/, want: 'var(--anim-ease-standard)' },
  { re: /cubic-bezier\(0\.175, 0\.885, 0\.32, 1\.275\)/, want: 'var(--anim-ease-swing)' },
];

export function checkAnimLiterals(scssFacts) {
  const hits = [];
  for (const s of scssFacts) {
    if (ANIM_TOKEN_HOME.test(s.rel)) continue;
    for (const block of s.blocks) {
      for (const d of block.decls) {
        const hit = ANIM_LITERALS.find((x) => x.re.test(d.value));
        if (hit) hits.push({ file: s.rel, line: d.line, prop: d.prop, want: hit.want });
      }
    }
  }
  return hits;
}

// ── 面板契约：选项 id ↔ 主题里的同名变量 ─────────────────────────────
//
// 会写变量的选项（颜色 / 文本 / 滑块 / 数字）在运行时写进与 id 同名的 CSS 变量：
// `id: background-mod-left-CSS-light` ⇒ 该选项把值写进 `--background-mod-left-CSS-light`。
// 主题里找不到这个变量（既不定义也不 var() 引用）就只有两种可能：选项是死的，
// 或者它的值本来就是交给 Obsidian core / 第三方插件读的。后者要在 id 那行标
// `# core-consumed`——契约写在声明旁边，而不是散在检查器的白名单里。
//
// 为什么值得查：令牌名现在由 sass 函数生成（见 src/scss/_split-background.scss），
// 改个命名函数就会让面板上成批的滑块静默失效，而编译、类型、样式都不会有反应。

const WRITES_VARIABLE = new Set([
  'variable-text',
  'variable-color',
  'variable-themed-color',
  'variable-number',
  'variable-number-slider',
]);

export function checkPanelTokenConsumers(panelBlocks, cssTokens) {
  const hits = [];
  for (const block of panelBlocks) {
    for (const entry of block.entries) {
      if (!WRITES_VARIABLE.has(entry.type)) continue;
      if (entry.coreConsumed) continue;
      const token = `--${entry.id}`;
      if (cssTokens.has(token)) continue;
      hits.push({
        block: block.name,
        id: entry.id,
        line: entry.line,
        why: `主题里没有 ${token}：要么补消费方，要么在 id 那行标 \`# core-consumed 说明\``,
      });
    }
  }
  return hits;
}

// ── 面板契约：选项值 ↔ 消费方 ──────────────────────────────────────────────
//
// class-toggle 的 id、class-select 的每个 option value，在运行时都会变成 body 上的 class。
// 若编译产物里没有任何 `.该类名` 的选择器，这个开关就是死的——而且改动时静默失效：
// 重命名选项值、删掉消费方、拼错类名，都不会有任何提示。
//
// 刻意不写样式的选项（用默认样式、或只被 _visibility.scss 的守卫键引用）在该行标 `# no-style`：
// 契约因此写在声明旁边，而不是散在检查器的白名单里。
//
// 判定看编译产物的选择器，不看 SCSS 源码——类名可能是插值生成的
// （例：`.bg-pattern-#{$shape}` 展开成 `.bg-pattern-cross`，源码里 grep 不到）。

export function checkPanelClassConsumers(panelBlocks, cssClasses) {
  const hits = [];
  for (const block of panelBlocks) {
    for (const entry of block.entries) {
      for (const value of consumedValues(entry)) {
        if (cssClasses.has(value)) continue;
        hits.push({
          block: block.name,
          id: entry.id,
          value,
          line: entry.line,
          why: `编译产物里没有 .${value} 选择器：要么补样式，要么在该选项上标 \`# no-style\``,
        });
      }
    }
  }
  return hits;
}

function consumedValues(entry) {
  if (entry.type === 'class-toggle') return [entry.id];
  if (entry.type === 'class-select') {
    return entry.options.filter((o) => !o.noStyle).map((o) => o.value);
  }
  return [];
}
