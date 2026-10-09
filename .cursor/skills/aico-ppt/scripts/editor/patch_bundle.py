"""AICO-PPT 离线补丁区块的唯一编解码实现。"""

from pathlib import Path
import json
import re


ROOT = Path(__file__).resolve().parents[2]
# 这些名称已经写入历史 Deck，属于不可重命名的文件格式 wire ID。
BEGIN = "<!-- huawei-deck-editor:begin -->"
END = "<!-- huawei-deck-editor:end -->"
PATCH_SCRIPT_ID = "huawei-deck-editor-patches"
STATUS_GLOBAL = "HuaweiDeckEditorPatchStatus"

_PATCH_SCRIPT_RE = re.compile(
    r'<script\b(?=[^>]*\btype=["\']application/json["\'])'
    r'(?=[^>]*\bid=["\']huawei-deck-editor-patches["\'])[^>]*>'
    r'(.*?)</script>',
    re.S,
)


class PatchBundleError(ValueError):
    """补丁区块结构或 JSON 不满足唯一性不变量。"""


def _bounds(template):
    begin_count = template.count(BEGIN)
    end_count = template.count(END)
    if begin_count == 0 and end_count == 0:
        return None
    if begin_count != 1 or end_count != 1:
        raise PatchBundleError("Deck 补丁标记必须各恰好出现一次")
    start = template.index(BEGIN)
    end_start = template.index(END)
    if start >= end_start:
        raise PatchBundleError("Deck 补丁标记顺序错误")
    return start, end_start + len(END)


def extract_patches(template):
    """返回补丁数组；无区块时返回 None，畸形区块直接拒绝。"""
    bounds = _bounds(template)
    if bounds is None:
        return None
    block = template[bounds[0]:bounds[1]]
    matches = _PATCH_SCRIPT_RE.findall(block)
    if len(matches) != 1 or block.count(f'id="{PATCH_SCRIPT_ID}"') != 1:
        raise PatchBundleError("Deck 补丁区块必须包含唯一补丁 JSON script")
    try:
        patches = json.loads(matches[0])
    except json.JSONDecodeError as error:
        raise PatchBundleError(f"Deck 补丁 JSON 无效：{error.msg}") from error
    if not isinstance(patches, list) or any(not isinstance(item, dict) for item in patches):
        raise PatchBundleError("Deck 补丁 JSON 顶层必须是对象数组")
    return patches


def strip_block(template):
    """删除唯一补丁区块；无区块时原样返回。"""
    bounds = _bounds(template)
    if bounds is None:
        return template
    # 删除前强制解析，避免升级或写回把损坏区块静默抹掉。
    extract_patches(template)
    end = bounds[1]
    # replace_block 在新插入区块与 </body> 之间放一行分隔；剥离时同步移除，
    # 让“加区块再剥离”严格恢复原模板，公共外壳 hash 不受补丁存在与否影响。
    if template[end:end + 1] == "\n" and template.startswith("</body>", end + 1):
        end += 1
    return template[:bounds[0]] + template[end:]


def build_block(patches, runtime_source=None):
    """用当前补丁运行时构造可观测、可验证的唯一离线区块。"""
    if not isinstance(patches, list) or any(not isinstance(item, dict) for item in patches):
        raise PatchBundleError("待写入补丁必须是对象数组")
    runtime = runtime_source
    if runtime is None:
        runtime = (ROOT / "scripts/editor/runtime/patch-runtime.js").read_text(
            encoding="utf-8"
        )
    data = json.dumps(
        patches, ensure_ascii=False, separators=(",", ":")
    ).replace("</", "<\\u002F")
    return (
        f'{BEGIN}\n<script type="application/json" '
        f'id="{PATCH_SCRIPT_ID}">{data}</script>\n'
        f"<script>{runtime}\n"
        ";(() => {\n"
        f"  const status={{state:\"waiting\",expected:{len(patches)},applied:0,"
        "adopted:0,error:null};\n"
        f"  window.{STATUS_GLOBAL}=status;\n"
        "  const deckEditorApplyWhenStable=()=>{\n"
        "    const patches=JSON.parse(document.getElementById("
        f"\"{PATCH_SCRIPT_ID}\").textContent);\n"
        "    let previous=null;\n"
        "    const check=()=>{\n"
        "      const canvases=[...document.querySelectorAll("
        "\".stage .slide-canvas\")];\n"
        "      const signature=JSON.stringify(canvases.map((canvas,index)=>{\n"
        "        const section=canvas.querySelector(\"section[data-label]\");\n"
        "        return [index,section?.dataset.label??\"\",section?.outerHTML??\"\"];\n"
        "      }));\n"
        "      if(canvases.length&&signature===previous){\n"
        "        try{\n"
        "          const results=window.HuaweiDeckPatchRuntime.applyAll(patches,{"
        "rebaseActionIds:patches.map(patch=>patch.id)});\n"
        "          status.applied=results.length;\n"
        "          status.adopted=window.HuaweiDeckPatchRuntime.adoptActiveAsBaseline();\n"
        "          status.state=\"applied\";\n"
        "        }catch(error){\n"
        "          status.state=\"failed\";\n"
        "          status.error={code:String(error?.code??\"PATCH_APPLY_FAILED\"),"
        "message:String(error?.message??error),"
        "failedActionId:String(error?.failedActionId??\"\")};\n"
        "          throw error;\n"
        "        }\n"
        "        return;\n"
        "      }\n"
        "      previous=signature;\n"
        "      setTimeout(check,100);\n"
        "    };\n"
        "    check();\n"
        "  };\n"
        "  deckEditorApplyWhenStable();\n"
        "})();</script>\n"
        f"{END}"
    )


def replace_block(template, patches, runtime_source=None):
    """替换现有区块或在唯一 </body> 前插入；绝不追加第二个区块。"""
    block = build_block(patches, runtime_source=runtime_source)
    bounds = _bounds(template)
    if bounds is not None:
        extract_patches(template)
        result = template[:bounds[0]] + block + template[bounds[1]:]
    else:
        if template.count("</body>") != 1:
            raise PatchBundleError("Deck 模板必须恰好包含一个精确 </body> 插入点")
        result = template.replace("</body>", block + "\n</body>", 1)
    if result.count(BEGIN) != 1 or result.count(END) != 1:
        raise PatchBundleError("构造后的 Deck 补丁标记必须各恰好出现一次")
    return result
