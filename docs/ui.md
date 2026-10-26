# UI 规范

新增或调整 renderer 界面时阅读。基调：**克制、简约、苹果风**。复用现有组件与语义 token，不为单个功能另造视觉体系。

## 视觉规则

- 浮层/卡片无边框：`rounded-xl bg-surface shadow-soft`，弹出层用 `shadow-pop`，以阴影分层。
- 状态只用一枚着色 glyph 表达；不使用大面积色底、徽章、左边条。info glyph 用 `ink-faint`。
- 文字层级：标题 13px/500 `ink-2`，正文 13px，元信息 11px `ink-faint`，详情 11.5px mono `ink-dim`；实际字号必须用下文 token。
- 操作用幽灵按钮：平时 `ink-faint`，hover 显 `bg-hover`，主操作文字加重；不用实心底色抢注意力。
- 行内选择器用胶囊 `rounded-full px-2.5 py-1`，形状仅在 hover/展开时显现。
- 颜色仅用 `styles/globals.css` 的语义 token 和 severity 变量，深浅主题各有定义，不写死具体色值。
- 非必要不画结构分隔线。滚动边界使用 `.edge-fade` + `lib/use-edge-fade.ts`，只在该方向还有内容时淡出；聊天下沿贴输入框，不淡。
- 必须画线时用 `.fade-rule` / `.fade-rule-v`，中段实、两头充分淡出，不用突兀的 1px 实线。

## 字号只有一套入口

组件使用 `styles/typography.css` 的 `text-ui-*`，禁止 `text-[13px]`、`text-xs/sm/lg` 和行内固定 px 字号。

- 可用 token：`text-ui-10/105/11/115/12/125/13/135/14/15/16/18/19`。
- 档位与夹紧规则在 shared `typography.ts`；DOM 变量接线在 renderer `lib/typography.ts`。
- `globals.css` 必须先 import Tailwind，再 import `typography.css`，否则 preflight 会压掉按钮、输入框等字号。
- Monaco 是 JS 度量例外，复用 `monacoFontSizeFor` / `monacoLineHeightFor`。当前 Markdown 库只在创建编辑器时应用字号，换档需要重建代码块，不要误以为 CSS 变量会自动更新它。
- 修改后运行现有 typography 守护测试；专项验收查 `scripts/check-font-size.mjs` 文件头。

## 快捷键可配（设置 → 快捷键）

底座在 shared `shortcuts.ts`（动作注册表 `SHORTCUT_SPECS`），设置页那一行由注册表迭代生成。新增一个可配快捷键：

1. `SHORTCUT_SPECS` 加一条（`id` + `defaultChord`）；
2. 按键入口用 `matchesChord(event, chord)` 分支（键位从 `useUiPreferencesStore((s) => s.shortcutBindings[id])` 取）；
3. 面板文案在 `ShortcutsPanel.tsx` 的 `ACTION_TEXT_KEYS` 登记 + zh/en 两条 i18n。

约定：

- 键位由用户**自由录制**：点设置页那一行进入录制态，直接按组合键录入，Esc 取消（录制期间在 window 上 capture 拦截并 `preventDefault`，否则 Esc 会先关掉设置面板、按键也会穿透到输入框）。
- 录制结果是 `KeyChord`（`KeyboardEvent.key` 小写 + 修饰键开关）。硬规则两条：`isRecordableChord`（**带至少一个修饰键，或单独 Enter**——单字母/空格会把输入抢走，纯修饰键不成键位）与 `chordOwner`（**动作之间键位不能重复**，面板在提交前就拦下并提示是谁占着，避免录进去又被归一化悄悄改回默认）。
- 手改 `ui-state.json` 的脏值按同一规则归一化（`main/ui-state.ts` 与渲染侧共用 `resolveShortcutBindings` + `normalizeChord`），非法键位回落出厂默认。
- 落盘只存**与出厂默认不同的**动作（`toShortcutOverrides`）：改默认键位时老文件自然跟随，文件也不会越用越大。
- 发送（默认裸 Enter）与换行（默认 Shift+Enter）**都能改**。`resolveComposerKey`（`composer/enter-key.ts`）的决策顺序：命中换行键位 → 换行；命中发送键位 → 发送；没被占用的 Enter → 换行（兜底，所以把发送挪到 Ctrl+Enter 后裸 Enter 不会误发消息）；其它键 → 不管。录的键位可以**不是 Enter**（如 Ctrl+Alt+K），所以匹配要按键位走，不能只看键名。
- 想换成「Ctrl+Enter 发送、Enter 换行」：两个动作各录一次（先改发送、再把换行录成 Enter）；只改换行会被互斥规则拦下。
- 换行统一走 Lexical 的 `INSERT_LINE_BREAK_COMMAND`（`ComposerEditorHandle.insertLineBreak`）。没被接管时 Lexical 会把「修饰键 + Enter」当成**新段落**（`<p>` 分裂），所以带修饰键的 Enter 必须显式接管成软换行。
- 桌面端专用；`lan-web`（手机页）不读这份设置。

## 浮层与交互

- fixed 浮层通过 `createPortal(..., document.body)` 挂载。`.edge-fade` 的 mask 会裁剪整个绘制子树，子元素 rect 正确也可能只绘制出一部分。
- 优先复用 `components/ui/` 的 Tooltip、ContextMenu、ConfirmDialog、Switch 等；新增提示不用原生 title。右缘 Tooltip 用 `align="end"`，避免撑出横向滚动。
- 弹层尺寸和方向按可用视口夹紧。越界元素的 autoFocus 可能带动根容器程序性横滚；只看截图不够，需验证真实命中与溢出。
- 不手动删除 React 管理的 DOM；退场动画、卸载与焦点接管必须协调。
- 拖动结束不只监听 pointerup，也要覆盖 pointercancel / lostpointercapture 等取消路径，避免窗口外松手后永久停在拖动态。
- 动画遵守 `prefers-reduced-motion`。避免通过逐帧改变布局宽度让聊天内容连续重排；优先固定尺寸 + transform。
- 文案用 `useT()`，同时维护 `i18n/zh.ts` 与 `en.ts`；第三方原名不强行翻译。

## 消息与图片的特殊边界

- UI 历史来自完整分支，而非压缩后的模型上下文，见 [架构](architecture.md)。
- 历史图片使用 `components/chat/history-image/` 资源层；稳定外盒、加载区门控、缩略图与原图预览各有归属，不在列表直接挂大量原图 data URL。资源释放与 worker 代次沿用现有服务，不在组件另建缓存。
- markstream/Monaco/Mermaid 的接入限制先查 `Markdown.tsx`、`MermaidBlock.tsx` 与现有测试；不要复制库内部实现。

实机调试与验收方法见 [UI 调试](ui-debugging.md)。
