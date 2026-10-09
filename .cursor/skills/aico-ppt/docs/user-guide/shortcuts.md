# 快捷键

## Editor

| 快捷键 | 作用 |
|---|---|
| `Cmd/Ctrl + Z` | 撤销最近一次 Deck 修改 |
| `Cmd/Ctrl + Shift + Z` | 重做 |
| `Ctrl + Y` | Windows 重做 |
| `Cmd/Ctrl + S` | 保存受控检查点，不发布真实 Deck |
| `Cmd/Ctrl + Enter` | 提交当前文字编辑 |
| `Delete` / `Backspace` | 从红色选框边缘点选整个元素后删除，可撤销；文字内部有光标时只删除文字 |
| 按住 `R` | 在编辑与区域标记间临时切换；按物理 `KeyR` 识别，中文输入法也有效 |
| `Esc` | 取消当前输入，或中断正在运行的 Agent 批次 |

输入框或直接文字编辑聚焦时，撤销和删除快捷键优先作用于输入内容，不触发 Deck 全局历史或整元素删除。内嵌 Agent 终端在 Windows / Linux 使用 `Ctrl+V` 粘贴一次剪贴板文字；有文字选区时 `Ctrl+C` 复制，未选中文字时 `Ctrl+C` 中断当前 CLI turn。macOS 使用原生 `Cmd+C` / `Cmd+V`。

## Deck 放映

| 快捷键 | 作用 |
|---|---|
| 空格 / `→` / 向下滚 | 前进一个节拍 |
| `←` / 向上滚 | 后退一个节拍 |
| `Cmd/Ctrl + 滚轮` | 缩放 slide canvas |
| `Cmd/Ctrl + +/-` | 缩放 slide canvas |
| 放大后按住空格 | 临时抓手拖动 |
