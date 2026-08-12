# LLM 推理学习资料

本目录集中存放基于 vLLM / vLLM-Ascend 的推理学习笔记。

## 文档列表

| 文件 | 说明 |
|------|------|
| [LLM推理学习_建议与问答梳理.md](./LLM推理学习_建议与问答梳理.md) | **主索引**：学习建议 + 后续问答 |
| [推理学习进度记录.md](./推理学习进度记录.md) | 进度快照与续学入口 |

## 相关技术资料

- [UB / CXL技术资料](../ub-cxl/)
- [超节点规模需求报告](../supernode-scale/)

## 本地同步方式

### 首次拉取整仓

```bash
git clone https://github.com/ghsshou/ai_work.git
cd ai_work/docs/llm-inference-learning
```

### 之后增量更新

```bash
cd ai_work
git pull origin main
```

### 只看本目录（GitHub 网页）

https://github.com/ghsshou/ai_work/tree/main/docs/llm-inference-learning

## 续学入口

打开主索引文档后，可回复：

- **A** — 继续 Scheduler（allocate_slots + 抢占）
- **B** — ModelRunner 组 batch
- **C** — AscendAttentionBackend
- **D** — platform 配置改写
- 「环境搭好了」— 跑第一个 benchmark
