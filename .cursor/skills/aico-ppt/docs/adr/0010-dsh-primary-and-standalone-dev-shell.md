# ADR-0010：DSH 是正式窗口壳，独立 Editor 降级为 Dev Shell

- 状态：已接受并实现
- 日期：2026-09-02
- 分支：`codex/dsh-web-plugin`

## 背景

AICO-PPT 同时需要满足两类使用方式：Codex、Claude Code 等 Agent 可直接加载 Skill；需要画布时，用户希望在 DSH 中保持左侧原生对话、右侧 Editor。仓库原有独立 Editor 自带 Agent PTY，若继续作为并列产品，会形成两套会话入口、两套审批心智和重复的安装要求。

## 决策

正式产品路径固定为：

```text
Skill（无窗口也可用）
  └─ DSH Plugin（正式窗口壳）
       └─ Editor Core（画布、任务、历史、固化、导出）

Standalone Dev Shell（开发、回归、故障排查）
  └─ Editor Core + Agent PTY
```

各模块责任如下：

| 模块 | 责任 | 依赖边界 |
|---|---|---|
| Skill | 制作方法、设计规范、脚本与质量闸门 | 不依赖窗口或 DSH |
| DSH Plugin | 侧栏入口、左右分屏、当前会话桥 | 不导入 PTY，不拥有 Deck 事务 |
| Editor Core | 页面栏、三种模式、画布、属性、任务、revision、撤销 / 重做、固化、导出 | `editor-core` Profile，不要求本机 Agent CLI |
| Standalone Dev Shell | 为开发和排障提供原本的本机 Agent 终端 | `dev-shell` Profile，按需加载 `node-pty` 与 xterm |

## 实现约束

1. `server.mjs` 和 `app-server.mjs` 不得顶层导入 `agent-terminal-session.mjs`；只有 Dev Shell 路径可通过 `agent-terminal-loader.mjs` 动态加载它。
2. DSH 模式不创建 `AgentTerminalSession`，不下发 xterm JS/CSS，也不开放可用的 `/agent-terminal` 会话。
3. DSH 的 Agent 请求始终通过 iframe 消息桥进入当前 `conversation.send()`，使用 `/aico-ppt`。
4. 独立页面显示 `DEV SHELL` 标识；DSH 嵌入页隐藏该标识。
5. `editor-core` 与 `dev-shell` 是不同依赖 Profile；缺少 Agent CLI、`node-pty` 或 xterm 不能让 DSH Editor Core 判定失败。
6. 独立 Dev Shell 继续复用同一 Editor Core，不允许复制页面状态、Mutation、history 或 solidify 实现。

## 结果

用户可以独立安装 Skill；所有面向用户的窗口编辑入口统一位于 AICO-Harness。维护者调试启动器收纳在 `tools/dev-shell/` 并明确命名为 Dev Shell，根目录不保留桌面入口，Windows 快捷方式也只生成在调试目录。默认 `scripts/install.py install` 只注册 Skill，`--skill-only` 兼容保留，只有显式 `--dev-shell` 才准备 PTY 与本机 Agent CLI。独立 Skill 通过无窗口 Managed Workspace 编辑、验证与固化，按用户要求交付 HTML，不自动打开 Dev Shell。
