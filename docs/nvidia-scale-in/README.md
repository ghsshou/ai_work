# NVIDIA Scale-in 网络基础设施

2026-08 公开口径的技术洞察：Scale-in 是 NVIDIA AI 网络第五支柱。**现行为 v2**：先交代 Spectrum-X / SuperNIC / DOCA / CMX 等产品分层，再说明 Scale-in 如何把过去的前端 / 南北向网络做成主机无关的加速基础设施域。v1 为初版归档，未删除。

| 版本 | 文件 | 说明 |
|---|---|---|
| **v2（现行）** | [洞察.md](./NVIDIA_Scale_in_网络基础设施洞察_v2.md) · [PPT 28 页](./NVIDIA_Scale_in_网络基础设施洞察_v2.pptx) | 补预备知识、书面语气、扩展来源 |
| v1（归档） | [洞察.md](./NVIDIA_Scale_in_网络基础设施洞察_v1.md) · [PPT 24 页](./NVIDIA_Scale_in_网络基础设施洞察_v1.pptx) | 基于 8/24–8/26 三天窗口的初版 |
| 生成脚本 | [build_pptx.py](./scripts/build_pptx.py)（v2）· [build_pptx_v1.py](./scripts/build_pptx_v1.py) | 分别写出对应版本 PPT |

## 重新生成 PPT

```bash
python3 docs/nvidia-scale-in/scripts/build_pptx.py      # v2
python3 docs/nvidia-scale-in/scripts/build_pptx_v1.py   # v1
```

## 相关目录

- [OpenAI Jalapeño](../jalapeno/)（前端网卡对照：Katsu 400G vs BF-4 800G）
- [超节点规模需求](../supernode-scale/)
- [UB / CXL](../ub-cxl/)
