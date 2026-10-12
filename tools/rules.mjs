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

export const DEFAULT_BINDINGS = [
  { id: 'domye-radius', key: 'default', file: '_variables.scss', re: /\$radius-base:\s*([^;!]+)/ },
  { id: 'domye-font-size', key: 'default', file: '_variables.scss', re: /\$font-size-base:\s*([^;!]+)/ },
  { id: 'domye-heading-spacing', key: 'default', file: '_variables.scss', re: /\$heading-spacing:\s*([^;!]+)/ },
  { id: 'domye-border-width', key: 'default', file: '_variables.scss', re: /\$border-width:\s*([^;!]+)/ },
  { id: 'domye-accent', key: 'default', file: '_variables.scss', re: /\$accent:\s*([^;!]+)/ },
  { id: 'secondary-color', key: 'default-light', file: '_variables.scss', re: /--secondary-color:\s*([^;]+)/ },
];

export function checkDefaults(scssFacts, panelBlocks) {
  const entries = new Map(panelBlocks.flatMap((b) => b.entries.map((e) => [e.id, e])));
  const hits = [];
  for (const b of DEFAULT_BINDINGS) {
    const entry = entries.get(b.id);
    const yamlValue = entry?.defaults?.[b.key] ?? null;
    const sassValue = readSassDefault(scssFacts, b.file, b.re);
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

function readSassDefault(scssFacts, file, re) {
  const hit = scssFacts.find((s) => s.rel.endsWith(file));
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
