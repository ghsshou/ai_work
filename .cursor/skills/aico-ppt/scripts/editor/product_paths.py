"""AICO-PPT 状态目录与旧 Huawei Deck 数据的兼容路径。"""

from __future__ import annotations

import os
from pathlib import Path


PROJECT_STATE_DIRECTORY = ".aico-ppt-editor"
LEGACY_PROJECT_STATE_DIRECTORY = ".huawei-deck-editor"


def resolve_project_state_root(project_dir: Path) -> Path:
    """新项目使用新目录；已有旧 sidecar 原位继续使用，避免破坏活动锁。"""
    project_dir = Path(project_dir)
    current = project_dir / PROJECT_STATE_DIRECTORY
    if current.exists():
        return current
    legacy = project_dir / LEGACY_PROJECT_STATE_DIRECTORY
    return legacy if legacy.exists() else current


def resolve_user_state_root(environment=None, home: Path | None = None) -> Path:
    environment = os.environ if environment is None else environment
    override = environment.get("AICO_PPT_EDITOR_STATE_ROOT") \
        or environment.get("HUAWEI_DECK_EDITOR_STATE_ROOT")
    if override:
        return Path(override).resolve()
    home = Path.home() if home is None else Path(home)
    current = home / ".aico-ppt-editor"
    legacy = home / ".huawei-deck-editor"
    return current if current.exists() or not legacy.exists() else legacy
