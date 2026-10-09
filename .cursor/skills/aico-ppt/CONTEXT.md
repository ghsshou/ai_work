# AICO-PPT Editor 工作管理

AICO-PPT Editor 工作管理描述本地 Deck 从创建、编辑到固化期间的身份、文件绑定和可恢复工作。它把用户看到的工作记录与文件系统中的 HTML 文件区分开，确保改名、移动或暂时丢失路径时编辑成果仍然可恢复。

## 工作与文档

**工作项（Work Item）**：
启动页中一条可继续、可命名、可隐藏的持久工作记录。工作项分为创建工作项和编辑工作项。
_Avoid_：任务、最近文件

**工作项标识（Work Item ID）**：
贯穿 Deck 创建、编辑、DSH 会话关联与页面切换的稳定工作项身份，代码字段固定为 `workId`。
_Avoid_：Deck 任务 ID、反馈任务 ID、文件路径

**创建工作项（Creation Work Item）**：
从需求对话开始并最终产出一份 Deck 的工作项。
_Avoid_：新建任务、Draft 卡片

**编辑工作项（Editing Work Item）**：
围绕一份已有 Deck 持续保存编辑会话、Agent 上下文和固化进度的工作项。
_Avoid_：最近 Deck、文件任务

**显示名称（Display Name）**：
用户用来识别工作项的名称，可以跟随 Deck 文件名，也可以由用户独立命名。修改显示名称不等于重命名文件。
_Avoid_：文件名、Deck 路径

**Deck**：
用户持续编辑的逻辑演示文档；它的身份不随源文件改名或路径变化而改变。
_Avoid_：HTML 路径、源文件

## 文件关系

**源文件（Source File）**：
Deck 当前固化到的独立 HTML 文件。源文件可以改名、移动、被替换或暂时不可访问。
_Avoid_：Deck、工作副本

**文件绑定（File Binding）**：
Deck 与当前源文件之间可变化的关联。绑定记录当前位置以及判断该位置是否仍指向同一文件所需的证据。
_Avoid_：Deck 身份、固定路径

**文件见证（File Witness）**：
Editor 用来判断改名前后是否仍为同一个物理文件的一组文件系统证据。文件见证只能支持判断，不能取代 Deck 身份。
_Avoid_：内容哈希、文件名

**重新绑定（Rebind）**：
在源文件位置变化后，把原 Deck 关联到经确认的新源文件。重新绑定不创建新的 Deck 或编辑工作项。
_Avoid_：重新导入、新建任务

## 编辑生命周期

**编辑会话（Edit Session）**：
一次可恢复的 Deck 编辑过程，包含结构修改、撤销历史、反馈任务和 Agent 上下文。
_Avoid_：浏览器窗口、源文件

**工作副本（Working Copy）**：
由 Editor 托管、承载尚未固化修改的 Deck 副本。源文件不可用时，工作副本仍然是编辑成果的安全载体。
_Avoid_：自动保存文件、源文件

**编辑租约（Edit Lease）**：
AICO-PPT Editor 体系内对一份 Deck 的独占写入资格。编辑租约用于避免多个 Editor 同时修改同一 Deck，不承诺阻止 macOS 外部程序重命名文件。
_Avoid_：操作系统强制锁、文件占用

**固化（Solidify）**：
验证工作副本并将其作为源文件的新版本安全发布。只有文件绑定明确且编辑租约有效时才允许固化。
_Avoid_：自动保存、导出

## 修改历史

**编辑时间线（Edit Timeline）**：
编辑会话内按实际发生顺序记录尚未固化修改的权威历史。人工编辑、Agent 动作和结构修改共享同一条编辑时间线。
_Avoid_：历史操作队列、撤销栈

**历史游标（History Cursor）**：
编辑时间线中已生效修改与可重做修改之间的唯一边界。新修改从游标位置产生，并放弃游标之后的旧重做分支。
_Avoid_：活动开关、任意启停

**补偿修改（Compensating Edit）**：
为撤回较早 Agent 任务的影响而追加的新修改；它保留该任务之后仍成立的修改，并且自身可以按时间顺序撤销和重做。
_Avoid_：定点撤销、跳过历史

**固化检查点（Solidification Checkpoint）**：
源文件成功发布后形成的稳定历史边界。检查点之前的编辑时间线进入归档，后续修改从新的空时间线开始。若源文件已原子发布但工作目录的文件见证写回遗漏，只有同一 `deckId`、当前源文件指纹与最近检查点全部一致时，检查点才可用于恢复文件绑定；任何不一致仍按外部替换处理。
_Avoid_：清空记录、自动保存点

## Agent 协作

**反馈任务（Feedback Task）**：
用户针对一个页面区域提出的一条原子修改要求，可以由 Agent 处理，也可以在提交前继续编辑或删除。
_Avoid_：工作项、最近任务

**执行批次（Execution Batch）**：
一次明确提交给 Agent 的、成员在提交瞬间冻结的反馈任务集合；后续产生的反馈任务不会自动加入该集合。
_Avoid_：当前待办、动态任务列表

**在途任务（In-flight Task）**：
属于当前活动执行批次、已经交由 Agent 负责但尚未结算的反馈任务。
_Avoid_：所有待处理任务、输入框中的任务

**下一批候选任务（Next-batch Candidate）**：
尚未归入任何执行批次、可在当前批次结束后组成下一执行批次的反馈任务。
_Avoid_：在途任务、自动追加任务

**批次剩余任务（Batch Residual）**：
执行批次结算后仍未完成的反馈任务；它保留原批次归属，只有用户明确重试或合并时才进入新的执行批次。
_Avoid_：下一批候选任务、自动重试任务

## DSH 协作

**DSH 工作区（DSH Workspace）**：
DSH 对一个规范项目目录的稳定登记，负责归组目录相同的原生会话；同一项目目录只对应一个 DSH 工作区。
_Avoid_：Editor Managed Workspace、Deck 工作副本、单个 Deck 任务

**DSH 会话（DSH Session）**：
DSH 原生对话及其 Agent 执行上下文；一个工作项可以关联多个 DSH 会话，一个 DSH 会话最多关联一个工作项。
_Avoid_：编辑会话、反馈任务、执行批次

**工作项会话关联（Work Session Link）**：
由明确用户动作建立的工作项标识与 DSH 会话标识关系，不能根据当前目录、页面、标题或提示词推断。
_Avoid_：当前会话、同目录会话、隐式关联

**会话创建意图（Session Start Intent）**：
用户从 DSH 统一“新会话”入口明确选择的启动方式：创建不关联任何工作项的普通会话，或从某个任务型插件的一行专属入口中选择确切工作项并创建任务会话。只要插件仍有可用工作项，其入口就不依赖 workbench 或关联会话是否处于活动状态；当前关联工作项或最近工作项是子菜单默认首项。任务意图携带 `workId` 与过期校验 key，普通意图绝不携带或推断工作项身份。
_Avoid_：自动关联、目录推断、标题推断

**活动工作会话（Active Work Session）**：
一个工作项当前接收后续 Deck 请求的 DSH 会话；已提交的在途任务仍固定在提交时的会话中。
_Avoid_：DSH 当前会话、最近会话

**普通 DSH 会话（Unlinked DSH Session）**：
没有工作项会话关联的 DSH 会话；切换到它不会改变任何工作项，但会收起当前 AICO-PPT Workbench，避免普通会话与隐藏的 Deck 上下文混用。
_Avoid_：空闲任务会话、默认 Deck 会话

## 参考材料读取

**PPTX 参考内容（PPTX Reference Content）**：
通过标准库工具 `scripts/extract-pptx.py` 提取的逐页标题、正文、备注、表格与内嵌原图，保留页序和图片关联，输出 `slides.json`、`slides.md` 与 `media/`。AI 直接读取内容文件、原图与原文件理解参考材料。图表、SmartArt 等未提取对象用逐页 `warnings` 说明；这些文件不代表完整的幻灯片视觉效果。
_Avoid_：PPTX 渲染、版式预览、转 PDF

**材料能力 Profile（Material Capability Profile）**：
`pptx-read` 只检查随包提取工具，不安装第三方依赖；`materials` 只检查 PyMuPDF 与 pypdf，后者负责 AcroForm 字段填写。PPTX 读取与截图打包只用标准库，附件图标使用 Pillow。桌面运行时只声明私有 Python，截图和验证复用 Host 的 Electron；独立 Skill 保留 Playwright 与本机 Chrome。

## 项目移除与恢复

**项目生命周期（Project Lifecycle）**：工作项的 `active → removing → removed` 与 `restoring → active` 状态独立于源文件是否存在。`removing` 持久保存操作标识和精确会话集合；Host 确认归档后才完成移除。重复请求复用操作标识。Host 明确忙碌可回退，网络结果不确定时保留移除记录以重试。历史会话恢复持久保存 `restoreOperation`，恢复期间阻止并发移除，失败可使用同一操作身份重试。

**项目恢复（Project Restore）**：明确重新打开源文件或点击“恢复项目”，恢复原 `workId`，保留归档历史，随后创建新会话。点击 Harness 归档列表中某一段会话的恢复按钮，只恢复该段及对应项目；其他历史会话保持归档。

**工作区登记修复（Workspace Registration Repair）**：每次明确创建或打开项目会话，按原项目规范目录确保登记存在；修复登记保留原会话与预留的会话创建身份。多个 Deck 共用目录时不能连带移除其他项目或会话。

跨插件的权威规则见 [Harness 插件项目生命周期规范](../upstream-old/AICO-Harness/docs/cookbook/plugin-project-lifecycle.zh.md)，本适配器实现记录见 [项目生命周期](docs/design/project-lifecycle.md)。
