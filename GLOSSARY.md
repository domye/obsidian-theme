# 术语表

主题的代码、注释、提交信息与 `npm run check` 的输出都按下面的词说话。新概念先加到这里，再写进代码。
架构讨论另用一套共享词汇：**module**（含 interface 与 implementation）、**depth**（深浅）、**seam**、**locality**、**leverage**。

## 区域背景（split background）

侧栏与主区各自可以选一种背景来源，靠 `body` 上的一组状态类驱动。

| 术语 | 含义 | 载体 |
|---|---|---|
| **区域** / area | `left` / `right` / `root` 三块 —— 左右侧栏与主区 | `src/scss/_split-background.scss` `$split-areas` |
| **模式** / mode | `light` / `dark`，与 `body.theme-*` 一一对应 | 同上 `$split-modes` |
| **背景来源** / source | `primary` / `secondary` / `transparent` / `customize` / `CSS` —— 面板上「区域背景」下拉的取值 | 同上 `$split-sources` |
| **背景令牌族** / token family | 一个来源能覆盖的令牌：`split` / `CSS` / `CSS-blend-mode` / `CSS-backdrop-filter` | 令牌名 = `--background-mod-{区域}-{族}[-{模式}]` |
| **卡片容器变体** / consumer | 卡片布局下三种会露出背景的容器：`.workspace-tab-container`、`.workspace-tabs.mod-top .workspace-tab-container`、`.workspace-tabs:not(.mod-top)` | `components/_workspace.scss` 的 `split-consumers()` |
| **状态类** | 面板选项落成 `body` 上的类：`mod-{区域}-split-background-{来源}-{模式}` | `split.state-class()` |

这张表有**两个消费者**，命名必须一致，所以两者都从 `_split-background.scss` 取：

- `components/_workspace.scss` —— 按来源给令牌赋值，卡片容器消费它
- `style-settings/_visibility.scss` —— 某个来源被选中时，隐藏同组其余来源的设置项

新增区域/来源只需改表：`_workspace.scss` 里漏了同名区域会在编译期 `@error`。

## 主题工程

| 术语 | 含义 |
|---|---|
| **令牌层** / token layer | 存放设计令牌的地方：`src/scss/_variables.scss`（非颜色令牌 + 模式色令牌）与 `foundations/_colors.scss`（调色板）。组件层不该裸写十六进制或圆角像素（README §4） |
| **动效令牌层** | `foundations/_reset.scss` 里的两张尺子：`--anim-duration-*`（以 `--anim-speed` 为除数，默认 75/150/300/600ms）与 `--anim-ease-*`（standard / smooth / swing 三条缓和曲线）。组件层写字面量会被 lint 报出 |
| **黄金守卫** / golden guard | `theme.css` 是构建产物，也是比对基准；`npm run verify` 按「选择器 → 声明」逐条比对重建结果与它（**不会**自动重建基准，否则它恒真）。它只比较**同一条选择器**的声明，跨选择器的规则顺序不在比较范围内（顺序变化要肉眼确认） |
| **事实层 / 规则层** | `tools/theme-facts.mjs` 把文件变成数据（唯一的 I/O 与解析边界），`tools/rules.mjs` 是只吃事实的纯规则（可喂假事实做单测），`tools/check-tokens.mjs` 只负责读事实、跑规则、打印 |
| **声明旁的标记** | 面板契约写在声明那一行：`value: xxx  # no-style 说明` = 这个选项刻意没有样式；`id: xxx  # core-consumed 说明` = 值由 Obsidian core / 插件读，主题不消费。两种标记都是 lint 允许的例外 |
