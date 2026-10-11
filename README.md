# domye —— Obsidian 主题

单文件 `theme.css` 已迁移为 SCSS 模块化工程，`theme.css` 现在是构建产物。

- 来源：**Border v1.13.9**（Akifyss）为主干 + **Phycat v0.3.7**（Xujilong）的列表/标题样式移植
- 迁移前的单文件可在 git 里取回：`git show bd31a17:.obsidian/themes/domye/theme.css`
  （下面各文件顶部的 `src: baseline L1234–L5678` 注释指的就是这份迁移前文件的行号，用于标记「哪段是上游原样搬过来的、哪段是本地改写的」）

## 目录结构

```
domye/
├── src/scss/
│   ├── index.scss               唯一入口，只写 @use，同时定义层叠顺序
│   ├── _variables.scss          设计令牌（$ 变量 + 输出为 CSS 变量）
│   ├── _mixins.scss             heading-icon()：h3–h6 装饰图标
│   ├── foundations/
│   │   ├── _colors.scss         accent HSL + .theme-light/.theme-dark 调色板
│   │   ├── _reset.scss          animations 基础动效令牌 / scrollbar
│   │   └── _typography.scss     段落、行高、两端对齐、内联标题、Phycat 标题层
│   ├── components/
│   │   ├── _workspace.scss      背景 / 布局 / 卡片 / 半透明窗口 / autohide / canvas / graph / 新标签页 / MOBILE
│   │   ├── _status-bar.scss     titlebar / status bar / ribbon
│   │   ├── _tabs.scss           tab 布局与样式 / 分隔线
│   │   ├── _sidebar.scss        outline / 文件面板 / 文件夹图标 / 空状态
│   │   ├── _modals.scss         setting modal / UI 控件 / notice / prompts
│   │   └── _editor.scss         编辑器、link、tag、高亮、复选框、callout、代码、表格、嵌入、Phycat 列表层
│   ├── plugins/_common.scss     DB Folder / Projects / Calendar / Make.md / Checklist / Text Generator / Callout Manager
│   └── style-settings/
│       ├── _index.scss          入口，只 @use
│       ├── _declarations.scss   @settings 的 YAML 声明 ×10（全是注释，不产出 CSS）
│       ├── _visibility.scss     「某状态下隐藏哪些设置项」，map + @each 生成
│       └── _panel.scss          设置面板本体的样式
├── tools/check-tokens.mjs       npm run lint（静态检查）+ npm run verify（构建等价性守卫）
├── theme.css                    构建产物（Obsidian 只读这个）
├── manifest.json
└── versions.json
```

`attachments`、`index` 等笔记目录不受影响；`node_modules/`、`package-lock.json` 已在 `.gitignore` 里。

## 开发与构建

```bash
npm install          # 只装 sass
npm run dev          # 监听 src/scss → theme.css
npm run build        # 一次性构建（expanded）
npm run build:min    # 压缩版
npm run lint         # 静态检查：同块重复声明（error）、默认值漂移（error）、零引用变量、裸字面量
npm run verify       # 重建并守卫 theme.css：按「选择器 → 声明」逐条比对，容忍注释与选择器列表的拆分
npm run test         # 检查工具自身的解析器回归测试（node --test）
npm run check        # lint + test + verify
```

**构建产物就是主题本身**：`theme.css` 与 `manifest.json` 同目录，Obsidian 只认这两个文件，`src/`、`tools/`、`package.json` 不会被加载。

改了样式后在 Obsidian 里让主题重载：`设置 → 外观 → 主题` 来回切一次，或直接 `Ctrl+P → Reload app without saving`。

## 编写约定

1. **不写具体样式到 `index.scss`**；只加 `@use`。
2. `@use` 的顺序 = 最终 CSS 的层叠顺序，不要随意调换。
3. 颜色令牌写在 `body.theme-light` / `body.theme-dark`，非颜色令牌写在 `body`。
4. 新增令牌先进 `_variables.scss`，不要在组件文件里裸写十六进制或圆角像素值；主题自有的圆角用 `var(--domye-radius-*)`。
5. `@settings` 的 YAML 一律用 `/* ... */` 普通注释即可；若要改成 `--style=compressed` 构建，必须写成 `/*!`，否则注释会被压掉、Style Settings 面板失效。
6. 同一属性不要在同一个规则块里写两遍——`npm run lint` 会把第二种作为 error 报出来（后写的静默生效，先写的是死代码）。

## Style Settings

面板里新增两块：

| 块 | 项 | 驱动 |
|---|---|---|
| 🎨 Domye Appearance | 强调色来源 | `--domye-accent`（默认 `hsl(var(--accent-h)…)`，即跟随 Obsidian 强调色） |
| | 圆角大小 | `--domye-radius`，派生 `--domye-radius-xs…xl`（0.5/0.75/1/1.5/2 倍） |
| | 正文字号 | `--font-text-size`（Obsidian 官方变量） |
| | 标题间距 | `--heading-spacing` |
| | 边框粗细 | `--domye-border-width`（h4 实心点 / h5 空心点 / 设置面板缩进线） |
| 🐱 Phycat colors | H1 左对齐装饰条 | `--secondary-color` |

这几项的默认值刻意等于迁移前的字面量，不动滑块时渲染结果与迁移前完全一致。

## 迁移时一并修掉的已知缺陷

- **死变量**：`--glow-shadow-text/box`、`--glow-color`、`--h2-shadow-color/hover`、`--phycat-h1-box-shadow`、`--phycat-h2-text-shadow`、`--phycat-h2-hover-box-shadow`、`--light-lighter` 全部零引用（阴影/光效在此前的提交里已被移除），连同对应的 6 个 `@settings` 项一起删除。
- **重复声明**：`body` 块里 `--h1/h2/h3-line-height` 各写了两遍（第一遍是死代码）；`--domye-accent`、`--phycat-primary-color` 在两个 `body` 块里各写了一遍。现在只保留生效值，并集中到 `_variables.scss` 由 `$headings` map 生成。
- **Style Settings 里被吞掉的值**：`.obsidian/plugins/obsidian-style-settings/data.json` 里有 `phycat-colors@@secondary-color@@light = #387bb9`，但主题里没有 `phycat-colors` 这个 `@settings` 块，插件的逻辑是「设置块不存在就跳过」，所以这个值一直没生效，主题硬编码的 `#bd93f9` 反而赢了。现已补回该设置块（默认 `#bd93f9`，与你原来的硬编码一致），你存的值从下次载入开始生效。
  > `phycat-colors@@bg-color`、`@@text-color`、`@@text-color-secondary` 三个残留键仍然无效（主题里已改用 Border 的 `--background-primary` / `--text-normal` / `--text-muted`）。要么在 Style Settings 里手动改回去，要么从 data.json 里删掉这三个键。
- **图标遮罩重复**：h3–h6 的装饰图标原本 `-webkit-mask-image` / `mask-image` 各写 8 遍，现由 `heading-icon()` mixin 统一输出。

## 未决事项（需要你拍板，不是漏做）

`src/scss/foundations/_typography.scss` 里 **Phycat 标题层的 `.theme-light` / `.theme-dark` 两段不是「复制粘贴后跑偏」，而是两套不同设计**：

先做过配对分析（把选择器去掉模式前缀后逐对比较声明）：**23 对规则里只有 3 对声明完全相同，20 对存在差异**，且差异是设计级的，例如

| 选择器 | light | dark |
|---|---|---|
| `.markdown-preview-view h3` | `width: fit-content`，transition `cubic-bezier(0.25,0.8,0.25,1)` | `display: block`，transition `ease` |
| `.markdown-preview-view h4::before` | `position: absolute` + `top/left/transform`，10×10px，带 1px 描边 | 走 flex 布局，8×8px，无描边 |
| `.markdown-preview-view h1::after`（下划线） | `background: var(--h2-bg-gradient)` + hover 拉满宽度 | `background: var(--h1-underline-color)`，无 hover 动画 |

合并它们 = 决定哪一套设计胜出（或做成混合），属于改设计而不是重构，**必须在 Obsidian 里对着两种模式肉眼确认**，所以没有在迁移里顺手合掉。要合的话建议按这个路子：结构声明写一次（保持 `body.theme-light` 级选择器不降级），把两套的差异值收敛到 `--phycat-*` 变量里，两种模式各给一组值。

## 已知局限

- 迁移等价性是用脚本按「属性:值」多重集 + 选择器多重集对迁移前单文件做结构比对验证的（结论：所有差异都属于上面那几类已知修复与 sass 的括号/转义重排）。**这不能替代渲染验证**，请在浅色/深色 × 阅读视图/源码视图下各扫一眼。
- `color-mix()`、`:is()`、CSS 嵌套都要求 Obsidian ≥ 1.0（Electron 25+）；`manifest.json` / `versions.json` 里的 `minAppVersion` 已改为 `1.0.0`，与这个要求一致。
