# AICO-PPT

AICO-PPT 提供独立 Skill 和原装 DSH Desktop 的可视化演示插件，共用根目录 `SKILL.md`。**beta0.1 已发布**，包内版本 `0.1.26`，Windows x64 一个完整安装包，包含私有 Python 与浏览器。

当前源码版本为 `0.1.30`，本地 Windows 完整包增加配合 Harness dev.62 的重启检查与运行版本报告，修复无关标注增删改导致 Agent 编辑误报版本冲突，并保留此前局部编辑、截图复用与跨页撤销／重做修复；安装命令见[安装指南](INSTALL.md#本地优化包0130)。官网 Beta 包仍为此前发布版本。

当前固定原装社区版 Desktop 2.0.13 + DSH 0.1.5-rc.2，先安装 AICO-Harness，再安装 PPT。安装步骤和完整性核验见[安装指南](INSTALL.md)与[官网安装页](https://openx.huawei.com/project/7665/AICO-Plugin-Web_master/install.html)。公开 Beta 不代表最终包联合验收已经完成，macOS 桌面插件暂缓。

## 使用

桌面左侧使用原装对话，右侧运行 Editor；新建 Deck 时选择项目目录，修改时打开已有 HTML。可以直接编辑文字和布局，也可以跨页框选区域、添加说明，再将任务交给关联会话。发布保留工作项身份、工作区和会话关系；切换普通对话不会把在途任务转移到别的项目。

五套单文件 HTML 模板覆盖授课、技术分享、工作汇报、任职材料和项目评审。支持放映/滚动、逐步动画、撤销/重做、安全固化、参考材料提取和 PPTX 导出。当前文档入口：

- [快速开始](docs/user-guide/quick-start.md)、[创建 Deck](docs/user-guide/create-deck.md)、[编辑 Deck](docs/user-guide/edit-deck.md)。
- [预览与任务](docs/user-guide/preview-and-tasks.md)、[验证与导出](docs/user-guide/verify-and-export.md)、[故障排查](docs/user-guide/troubleshooting.md)。
- [制作流程](references/workflow.md)、[设计规范](references/design-system.md)、[配图与参考材料](references/artwork.md)。

![Deck 操作演示](docs/showcase/deck-demo.gif)

## 独立 Skill

从完整源码仓库注册；无需 Harness，制作和导出依赖按任务准备：

```bash
python3 scripts/install.py install --skill-only
python3 scripts/check_deps.py --profile editor-core --check-only
```

Windows 使用 `py -3 scripts\install.py install --skill-only`。安装器保留已有项目、工作副本和会话，不覆盖来源不明的同名目录。跨平台独立 Skill 与 Dev Shell 的能力不代表桌面插件已经发布相应平台包。

## 开发与维护

- [架构](docs/architecture.md)、[领域语言](CONTEXT.md)、[DSH 接口](integrations/dsh/README.md)。
- [项目生命周期](docs/design/project-lifecycle.md)、[会话管理及待完成项](docs/design/dsh-deck-workspace-session-management-design.md)。
- [Deck 身份、文件绑定与待完成增强](docs/design/editor-deck-identity-file-binding-design.md)。
- [开发约束](AGENTS.md)、[安装和开发依赖](INSTALL.md)、[Agent 执行入口](SKILL.md)。

运行 `npm run test:dsh-plugin` 检查插件接口；Editor 回归使用 `package.json` 中的 `test:editor:*` 命令。模板修改还需运行溢出检测、截图、逐拍验证和 bundle 结构检查。真实 Desktop、模型连接与发布包验收应单独记录，测试替身不能替代实机。

Windows 执行 Editor、Agent、工具和所有业务资源。WSL 只影响模型通信。安装与维护不依赖旧修改版 Harness 的 Electron 专用渲染服务，不修改 DSH 宿主。独立 Dev Shell 只用于开发和排障。

许可与素材使用范围见 [LICENSE](LICENSE) 和[品牌参考来源](assets/huawei-refs/README.md)。
