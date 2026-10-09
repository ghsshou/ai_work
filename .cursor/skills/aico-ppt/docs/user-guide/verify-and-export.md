# 验证与导出

桌面版从 Editor 直接验证和导出，截图复用 AICO Host 的 Electron，PPTX 由插件私有 Python 组装。新版插件要求 Host 支持 `apiVersion: 2` 发布与 `desktopRenderer: 1`；渲染服务缺失时启动或升级 Host，插件文件缺失时从商店重装插件。桌面脚本应沿用注入的运行时包装器与 `AICO_HOME`。

下面的依赖安装命令仅适用于独立 Skill 或源码开发环境；独立 Skill 使用 Playwright 与本机 Chrome。桌面版诊断使用相同 Profile 的 `--check-only`，不在应用资源目录执行 `--repair`。

## 启用质量验证

```bash
python3 scripts/check_deps.py --profile verify --repair
```

Windows：

```powershell
py -3 scripts\check_deps.py --profile verify --repair
```

## 验证三件套

```bash
node scripts/verify/measure_overflow.mjs my-deck.html --all
node scripts/verify/shot.mjs my-deck.html <页label> /tmp/page.jpg
node scripts/verify/steps.mjs my-deck.html <页label> /tmp/steps
```

- `measure_overflow`：检查全部页面是否超出 1920×1080 画布；
- `shot`：生成单页全显截图，供视觉检查；
- `steps`：按放映节拍生成逐拍截图，适用于动画页。

## 导出 PPTX

独立 Skill 先启用导出能力：

```bash
python3 scripts/check_deps.py --profile pptx-export --repair
```

在 Editor 中，点击画布工具栏右侧、画布尺寸之前的导出图标，选择格式后点击“开始导出”；默认推荐“可编辑 PPTX”。系统保存窗口默认当前项目目录，文件名沿用 Deck 名称，也可以另选位置。取消、Esc 或点击格式弹层外部均不启动转换。确认后按钮周围显示转圈，生成与保存期间不可重复点击；完成后显示“PPTX 已保存”，悬停状态文字可查看完整路径。导出使用点击时的当前工作副本快照，包含尚未固化的修改；导出本身不会固化修改，也不会清空撤销记录。

切换项目、刷新页面或收起 AICO-PPT 后，后台仍会完成导出并保存到已选位置；返回原项目时恢复进度和结果，其他项目不会显示这份导出的状态。退出整个 AICO 应用会取消未完成的导出，失败不会覆盖已有 PPTX。若桌面提示不支持保存窗口，需要同时更新 AICO-Harness。

| 格式 | 适用场景与限制 |
|---|---|
| 可编辑 PPTX | 文字、常见图形和表格可修改；复杂视觉保留图片，不保证全部元素可编辑 |
| 高清图片 PPTX | 优先还原外观，每页为高清图片；页面内部文字和图形不可分别编辑 |

两种模式都导出静态页面，不将动画和网页交互转换为 PowerPoint 动画；导出后需复核字体与排版。

导出会等待当前快照中的全部补丁应用完成，保留改字、字号、隐藏、移动和缩放等修改。若补丁目标失效、应用失败或超时，会中止导出并提示失败原因及补丁 ID，不会生成回滚后的旧内容；请先在编辑器中修复对应修改再重试。

可编辑模式按浏览器中的视觉行生成文本框，统一使用微软雅黑（Microsoft YaHei），保留字号比例、粗体、斜体和颜色。字号依据原始画布与局部缩放换算，按实际文字基线定位，不自动缩小文字。普通表格使用原生单元格，含合并单元格或复杂效果的表格保留图片。字体文件不会嵌入 PPTX；接收方未安装微软雅黑时，Office 仍会替换字体，字宽和表格换行可能变化。需要完全保持版面时请选择“高清图片 PPTX”。桌面可编辑导出需要支持透明截图的新 Host，旧版会提示升级；图片模式仍可使用。

命令行可编辑导出（改成 `--mode image` 选择高清图片；不传模式仍默认图片，以兼容原有脚本）：

```bash
python3 scripts/html2pptx/convert.py my-deck.html my-deck.pptx --mode editable
```

Windows：

```powershell
py -3 scripts\html2pptx\convert.py my-deck.html my-deck.pptx --mode editable
```

页内 layer 多标签页会自动展开为多张 PPTX 页面。只有用户明确需要 PPTX 时才导出；后续继续修改 HTML 不会自动重导。
