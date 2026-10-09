# 维护者调试壳

AICO-PPT 的产品定位是独立 Skill 与 AICO-Harness 编辑器插件。用户先安装 AICO-Harness 独立应用，再从应用的插件商店安装 AICO-PPT；独立 Skill 不依赖 Harness，也不自动打开桌面编辑器。

本目录仅保留维护者开发、回归与故障排查需要的 Dev Shell。它复用 Editor Core，并额外启动本机 Agent PTY。Harness 的网页联调启动器位于相邻 AICO-Harness 仓库的 `tools/dev-web/`，默认开发数据目录为 `~/.aico-harness-dev-web`；本目录仍是 PPT 自身的独立 Editor 调试壳。两者都不属于普通用户入口，操作说明见[开发调试](../../INSTALL.md#开发调试)。

在仓库根目录准备调试依赖：

```bash
python3 scripts/install.py install --dev-shell
```

macOS 可双击本目录的 `AICO-PPT Dev Shell.app`；Windows 使用 `py -3 scripts\install.py install --dev-shell`，再双击 `AICO-PPT Dev Shell.cmd`。Windows 快捷方式也只生成在本目录。请保持目录结构，不能单独移动启动器。

独立 Skill 安装使用 `python3 scripts/install.py install`；只注册 Skill，不安装调试终端。无窗口编辑继续使用 `python3 scripts/deck-editor.py <deck.html> --headless-workspace`。正式插件安装见[安装指南](../../INSTALL.md)。
