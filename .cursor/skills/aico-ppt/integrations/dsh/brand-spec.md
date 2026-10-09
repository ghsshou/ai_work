# AICO-PPT DSH Client 品牌规格

本文件记录 DSH Client Adapter 实际复用的仓库品牌源，避免用临时图形代替品牌资产。

| 项目 | 规范来源 |
|---|---|
| 横版 Logo | `../../assets/huawei-refs/logos/huawei-横版logo-透明.png` |
| 主品牌红 | `#c7000b` |
| 深品牌红 | `#a80009` |
| 工作台底色 | `#eef0f3` |
| 主文字 | `#191919` |
| 次文字 | `#6a6d73` |
| 字体 | `AICO-PPT UI` 可用时优先；DSH Adapter 当前回退到 `Noto Sans SC` / `Microsoft YaHei` |
| 间距 | 4px 基数，面板间距 8px，内容常用 12px / 16px |
| 圆角 | 控件 7–10px，面板 14px，整体外壳 18px |
| 阴影 | 低对比冷灰，面板 2–8px，画布 18–55px |
| 动效 | 160–200ms ease；当前工作台已遵守 `prefers-reduced-motion` |

Host 在启动时把真实 PNG 编码为只读 `__AICO_PPT_BRAND__` 输入；Client 用 `<img>` 渲染，不把 Logo 重画为 CSS 或 SVG。占位框只用于 Host 输入异常时明确暴露问题，不视为完成态。
