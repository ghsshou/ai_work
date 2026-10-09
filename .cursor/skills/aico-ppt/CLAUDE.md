# AICO-PPT 开发入口

开发前阅读并遵循 [AGENTS.md](AGENTS.md)，包括单文件 bundle 编辑规则、原装宿主边界、项目生命周期和验证要求。本文件不重复维护第二份开发规范。

在 Claude Code 中注册独立 Skill，使用 `python3 scripts/install.py repair --hosts claude-code --skill-only`；Windows 将 `python3` 换成 `py -3`。注册位置是 `~/.claude/skills/aico-ppt`，安装、修复和退出码见 [INSTALL.md](INSTALL.md)。
