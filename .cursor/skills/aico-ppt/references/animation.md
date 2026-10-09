# animation.md — 动画机制（build / layer / SMIL）

模板第 14–18 页（`动画·build逐步` / `动画·layer切换` / `动画·混合链` / `动画·SMIL运动` / `动画·多组切换`）是这套机制的**活教材**：页面正文就在讲解写法，放映着过一遍比读十遍文档都快。本文给出完整规则。

## 0. 总原则

- **所有动画都靠讲者手动推进**（点击空白 / 空格 / 方向键），**绝不自动循环播放**——动画的目的是控制讲课节奏，不是炫技。SMIL 装饰动效是唯一例外（循环但不占节拍、不抢注意力）。
- **不写任何操作提示文字**。「点击查看」「点击切换」「点击下方流程」之类一律不写——讲者知道怎么推进，听众不需要知道机制。真实功能控件的简短标签（如「复制链接」「新窗口打开」）不算操作提示，可以写；模板 03 章动画机制页正文里的「点击」是教学主题本身，同样豁免——别把它们当成可抄的文案范例。

## 1. 进入放映与键位

deck 打开时默认**滚动模式**（鼠标滚轮浏览全部页）。**右上角玻璃工具条**有两枚图标钮：**显示器图标 = 放映模式**（点击切入，同时自动尝试进入浏览器全屏）、上下箭头图标 = 滚动模式。缩放快捷键在两种模式都生效，翻页快捷键只在放映模式生效：

| 操作 | 效果 |
|---|---|
| `→` / `PageDown` / 空格 / 点击页面空白 | 前进一拍（当前页拍完则翻下一页） |
| `←` / `PageUp` | 回退一拍（清掉已显示状态；本页回完则翻回上一页） |
| 放映态向下 / 向上滚轮 | 等同前进 / 回退方向键；一段连续手势只触发一次，停止约 180ms 后重新响应 |
| `F` | 切换浏览器全屏（任一模式可用） |
| `Esc` | 关闭已打开的缩略图侧栏 / 笔记面板（退出全屏是浏览器原生 Esc 行为） |
| `Ctrl/Cmd + 滚轮` | 以 10% 步长缩放幻灯片内容（50%–250%）；工具条不缩放，滚动态锁定当前页位置 |
| `Ctrl/Cmd + +` / `Ctrl/Cmd + -` | 放大 / 缩小幻灯片内容 |
| `Ctrl/Cmd + 0` | 恢复自动适配大小 |
| 放大后按住空格 + 鼠标拖动 | 临时抓手；松开空格恢复点击模式 |
| 放大后点击 glass 小手 | 锁定 / 解除抓手模式；抓手态单击空白不推进页面 |
| 刷新页面 | 自动回到上次所在页（localStorage 记忆） |

普通滚轮在滚动模式下仍用于浏览页面；放映模式下复用方向键的逐拍 / 翻页逻辑，并用 48px 累积阈值 + 180ms 手势结束判定过滤触控板惯性。右侧滚动条默认透明，滚动时显示 6px 细滑块，停止 800ms 后淡出。左上侧边预览入口固定使用 `图标 + x/yy` 的 108×48 glass 胶囊，页码在放映翻页、滚动定位、缩略图跳页和刷新恢复时同步。

只有按住 `Ctrl/Cmd` 的滚轮才缩放并阻止导航。倍率写入 `localStorage`；非 100% 时顶部导航展开四角百分比复位控件，**只有倍率大于 100%** 时才同时显示小手。小手可锁定抓手，空格可临时抓手；放映态通过 `--pan-x/--pan-y` 平移画布，滚动态拖动 `stage.scrollLeft/scrollTop`。平移必须限制在放大画面的可视边界，换页或恢复 100% 时复位。小手和四角按钮点击后必须 `blur()`，CSS 同时覆盖 `:focus/:focus-visible`，不得留下黑色焦点圈。用户点击右上角模式按钮时仍先恢复 100%，初始化模式不得清除刷新恢复倍率。

点击推进只在放映模式生效，按钮 / 链接 / iframe 等交互元素自行处理；抓手锁定时单击空白也不得推进。进页 `level = 0`，每前进一拍 `level + 1`。公共运行时修改必须同步三套模板并提升版本标记，不能只改某一份 deck；公共外壳 hash 会自动触发历史 Deck 重组，无需为单项功能编写 probe。

## 2. 机制一：build 逐步揭示

```html
<div class="build" data-step="0">第 1 拍出现</div>
<div class="build" data-step="1">第 2 拍出现</div>
<div class="build" data-step="1">同拍齐现（同一 data-step 的多个元素一起出）</div>
```

- 规则：放映态下 `.build` 默认隐藏（`opacity:0`），当前 `level > data-step` 时引擎给它 `data-shown` → 显示。`data-step="0"` 即第 1 次点击出现。
- **初始就该显示、不参与动画的元素不要加 `class="build"`。**
- `data-reveal="#id"` 可让某 build 元素显现时联动点亮另一个元素。
- 活例：模板第 14 页；第 9 页（密集多栏）演示「一拍点亮一组」。

## 3. 机制二：layer 层切换（页内多画面的唯一协议）

一个区域多个面板互斥切换（tab / 方案 / 阶段视图）：

```html
<!-- 按钮：同 key 同组配对面板；首个 data-active 且不写 data-step（=默认层） -->
<div class="layerbtn" data-layer-btn="a" data-layer-group="G" data-active="">标签A</div>
<div class="layerbtn" data-layer-btn="b" data-layer-group="G" data-step="0">标签B</div>
<div class="layerbtn" data-layer-btn="c" data-layer-group="G" data-step="1">标签C</div>
<!-- 面板：与按钮同 key 同组；首个 data-active -->
<div class="layerpanel" data-layer-panel="a" data-layer-group="G" data-active="">面板A</div>
<div class="layerpanel" data-layer-panel="b" data-layer-group="G">面板B</div>
<div class="layerpanel" data-layer-panel="c" data-layer-group="G">面板C</div>
```

- `.layerbtn` / `.layerpanel` / `[data-active]` 的样式模板 CSS 已内置（红底白字高亮、面板 `display:none` ↔ `block`）。
- 点按钮直接跳到该层；**给按钮加 `data-step` 才能被方向键推进**。
- **引擎规则**：组内当前 active = `data-step < level` 的按钮中 **data-step 最大者**；没有满足者就回到**组内第一个按钮**（默认层）。所以首个按钮不写 data-step，其余按 0,1,2… 递增。
- 同组按钮 / 面板靠 `data-layer-group` 隔离，跨组互不干扰。**一页可以放多个组**：按钮挂 data-step 的组并入 build 点击线，全部不挂的组则完全靠手点（第 18 页更进一步演示了「build 走完后由某组接管点击」——那是该页运行时按 data-label 定制的逻辑，复制需同步改运行时判断，见 `template-pages.md` 第 18 页条目）。
- 活例：模板第 15 页（4 标签一组）、第 18 页（一页两组）。

目录、标签页、方案对比、阶段视图、同一页的“下一屏”等功能，本质上都是页内互斥画面，**全部使用这一套 layer 协议**。三套模板的目录页也是活例：组名统一为 `toc`。模板画廊里的四个按钮 / 面板只是示例；新建，或修改涉及目录 / 章节结构时，必须按当前实际大纲重建为真实章数，并让全部按钮、面板从首屏开始固定存在于 DOM。

### 3.1 稳定 DOM 契约

1. 每个状态必须同时有一个按钮和一个面板，二者 `data-layer-group` 与 key 完全一致；每组恰有一个默认按钮和默认面板带 `data-active`。
2. 按钮、面板和被编辑器定位的业务元素必须在页面初始 DOM 中固定存在。切换状态只允许增删 `data-active`，不得在点击时通过 `innerHTML` / `outerHTML` / `replaceChildren` 重建整组内容。
3. 不得为同类功能再造 `_cur`、`_stepView`、`data-mod` 等私有状态机。`data-step` 只负责把 layer 纳入放映节拍，当前画面仍以 `data-active` 为唯一权威。
4. 动态图表可以在初始化时向既有面板内部填充一次内容，但不能在状态切换时替换按钮、面板或整页根节点；需要频繁更新数据时，只修改既有子节点的文本、属性或绘图数据。
5. 历史 Deck 的 `data-mod` 只由公共运行时和编辑器兼容读取；新模板、新页面和 Agent 生成代码不得再写这种结构。

这个契约让四条工具链共用同一状态语义：放映引擎按 level 推进、编辑器随区域任务保存/恢复画面、`steps.mjs` 逐拍验证、`html2pptx` 逐状态展开。任何自建状态机都会绕开至少一条工具链。

### 3.2 新建与目录结构修改共用的自适应契约

目录不是“替换四个占位标题”即可完成。新建 Deck 一律执行本节；修改已有 Deck 时，只要涉及章数、章名、章节目标、页序、目录 DOM 或目录动画，也执行完全相同的契约。当前确认大纲的每章都要同时落到导航、目录 DOM 和专属动画：

- 数量严格相等：`chapters[]`、`data-layer-btn`、`data-layer-panel`、`data-toc-visual-index`、`tocBuilders` 都等于实际章数。
- key 使用 `chapter-01`、`chapter-02`…；首章按钮 / 面板唯一带 `data-active` 且按钮不写 `data-step`，后续按钮从 `data-step="0"` 连续编号。
- 每个按钮、面板、动画容器都写同一个 `data-toc-chapter-id`；按钮的 `.toc-layer-name` 与面板的 `data-toc-title` 写真实章名，动画容器的 `data-toc-animation-topic` 写本章目标。
- 每章新建一个具名动画函数，返回的 SVG / HTML 根节点同时写 `data-toc-animation-chapter` 与 `data-toc-animation-topic`。动画应直接表达本章对象、关系或过程；不能保留模板的 `animNN` / `animAlgo` / `animMethod` / `animInfra`，不能只改函数名，也不能给不同章节返回同一画面。
- 若实际章数与模板示例不同，可在目录外层框内调整间距或分栏，但不得靠低于字号下限的文字硬塞；最后由 overflow 和逐拍截图共同验收。

最小结构示例：

```html
<button data-layer-btn="chapter-01" data-layer-group="toc"
  data-toc-chapter-id="context" data-active>
  <span class="toc-layer-name">背景与约束</span>
</button>
<div data-layer-panel="chapter-01" data-layer-group="toc"
  data-toc-chapter-id="context" data-toc-title="背景与约束" data-active>
  <div data-toc-visual-index="0" data-toc-chapter-id="context"
    data-toc-animation-topic="讲清适用边界"></div>
</div>
<script>
const tocContext = () => {
  return '<svg data-toc-animation-chapter="context" data-toc-animation-topic="讲清适用边界">…</svg>';
};
const tocBuilders = [tocContext];
</script>
```

Editor 新建流程会从已确认大纲自动写出 `*.toc-contract.json`。直接使用 Skill 新建，或修改已有 Deck 的目录 / 章节结构时，也要写入或更新同格式文件：

```json
{"version":1,"chapters":[{"chapterId":"context","title":"背景与约束","objective":"讲清适用边界"}]}
```

完成后必须运行两道目录专属校验：

```bash
python3 scripts/verify/toc_contract.py my-deck.html \
  --contract my-deck.toc-contract.json \
  --template assets/training-deck.html
node scripts/verify/steps.mjs my-deck.html 目录 /tmp/toc-steps
```

## 4. 机制三：SMIL 连续运动

```html
<circle r="11" fill="#b5333b" cx="110" cy="92">
  <animate attributeName="cx" dur="3.4s" repeatCount="indefinite" values="110;400;110"></animate>
</circle>
```

- 写在 SVG 元素内部的 `<animate>` / `<animateTransform>` / `<animateMotion>`，`repeatCount="indefinite"`。
- 随当前页激活自动播放，离页被 `pauseAnimations()` 冻结——**不占节拍、不参与点击计数**，适合数据流、光带扫过这类持续示意。
- 在脚本里读动画中的值要用 `el.cx.animVal.value`；`getAttribute` 拿到的是基值。
- 活例：模板第 17 页（21 个 animate）、第 2 页议程页的靶心装饰。

## 5. 三条铁律

1. **版块的「外层背景框」也要挂 build**，不能只给框内内容挂——否则进页时空灰框先露出来，节拍就穿帮了（对照模板第 8 页：整行连框一起出现）。
2. **切勿用 `:has()` 控制 opacity**。本运行时里 opacity 级联有怪异表现（已踩坑）；要隐藏 / 显示容器就用 build 机制或 `visibility`。
3. **SVG 元素既是 `.build` 又带 `transform="rotate(…)"` 时，把 transform 移到非 build 的外层 `<g>` 上**。放映态 CSS `.build[data-shown]{transform:none}` 会清掉元素自身的 transform，导致放映模式错位而滚动模式正常。

## 6. 共享 level 与混合链

同一页的 build 和 layer **共享同一个 level 计数**，可以串成一条点击线：layer 按钮吃掉前几拍（整版切换），某个面板内部的 build 用更大的 data-step 接着逐条出现。总拍数 = 页内最大 `data-step` + 2（进页空场 1 拍 + 讲完翻页 1 拍）。活例：模板第 16 页（5 标签 + 面板内 3 个 build = 8 拍）。

## 7. 「先排拍后编号」方法

给一页设计动画时，别边写 HTML 边编号：

1. 先把这页的**讲稿节拍**列成一张表：第 1 拍讲什么、出现哪些元素；第 2 拍……直到讲完。一个「知识节拍」里相关的 bullet、连接箭头、caption 应归入**同一拍**（同一 data-step），别把一句话拆成三次点击。
2. 再把表翻译成编号：每拍一个 data-step 值，从 0 开始连续递增；layer 按钮先占位，面板内 build 接在其后。
3. 检查：进页空场（level=0）该显示什么？没挂 build 的元素就是空场内容，确认它们确实该提前可见。

## 8. 用 steps.mjs 验证节拍

改完动画不要凭感觉，在 skill 根目录跑逐拍截图（模拟放映引擎，规则与运行时一致）：

```bash
node scripts/verify/steps.mjs my-deck.html 动画·混合链 /tmp/steps-out
```

- 输出 `step-00.jpg`、`step-01.jpg`……每拍一张，并在终端**逐拍打印新出现的元素摘要**——对着讲稿核对每拍内容是否如设计。
- 页面无动画时打印提示后正常退出（exit 0）；label 不存在时列出全部可用 label（exit 1）。
- 拍数对不上时，通常是 data-step 编号跳号 / 重复，或该挂 build 的元素漏挂。

逐页动画拍数清单见 `template-pages.md` 开头的总表。
