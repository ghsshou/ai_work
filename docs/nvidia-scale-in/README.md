# NVIDIA Scale-in 网络基础设施

2026-08 公开口径的技术洞察：Scale-in 是 NVIDIA AI 网络第五支柱。文稿先交代 Spectrum-X / SuperNIC / DOCA / CMX 等产品分层，再说明 Scale-in 如何把过去的前端 / 南北向网络做成主机无关的加速基础设施域。

| 文件 | 内容 |
|---|---|
| [NVIDIA_Scale_in_网络基础设施洞察.pptx](./NVIDIA_Scale_in_网络基础设施洞察.pptx) | 28 页浅色演示文稿：预备知识、定义、变化、原理、芯片、用例、边界与影响 |
| [NVIDIA_Scale_in_网络基础设施洞察.md](./NVIDIA_Scale_in_网络基础设施洞察.md) | 同结构文字版，含出处和未公开清单 |
| [scripts/build_pptx.py](./scripts/build_pptx.py) | PPT 生成脚本 |

## 重新生成 PPT

```bash
python3 docs/nvidia-scale-in/scripts/build_pptx.py
```

## 相关目录

- [OpenAI Jalapeño](../jalapeno/)（前端网卡对照：Katsu 400G vs BF-4 800G）
- [超节点规模需求](../supernode-scale/)
- [UB / CXL](../ub-cxl/)
