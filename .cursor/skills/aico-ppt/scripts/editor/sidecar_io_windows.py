#!/usr/bin/env python3
"""Windows 的可信 sidecar 路径后端。

Windows 不能用 POSIX 方式把目录打开成 dirfd。本后端改为固定真实路径与
``dev/ino`` 身份，并在每次操作前后拒绝符号链接、junction/reparse point 与
身份变化；文件写入仍使用同目录临时文件、fsync 和 ``os.replace``。
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import uuid

try:
    from product_paths import resolve_project_state_root
except ModuleNotFoundError:
    from scripts.editor.product_paths import resolve_project_state_root

from sidecar_io import (
    MAX_AGENT_WORKSPACE_BYTES,
    MAX_AGENT_WORKSPACE_REQUEST_BYTES,
    MAX_AGENT_WORKSPACE_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
    MAX_SESSION_BYTES,
    MAX_SESSION_REQUEST_BYTES,
    MAX_WORKING_DECK_BYTES,
    CONTROL_REQUEST_BYTES,
    SidecarIOError,
    TRANSACTION_ID_RE,
    _require_name,
    _require_uuid,
)

try:
    import msvcrt
except ImportError:  # 测试可在 macOS/Linux 跑这个路径后端
    msvcrt = None
try:
    import fcntl
except ImportError:
    fcntl = None


def _filesystem_path(path):
    r"""为 Windows 文件 API 提供不受 MAX_PATH 限制的绝对路径。

    对外 identity 仍保留普通盘符/UNC 形式，避免把 ``\\?\`` 前缀泄露给
    Node 和持久化 registry；只在真正读写文件时转换。
    """
    value = os.path.abspath(path)
    if os.name != "nt" or value.startswith("\\\\?\\"):
        return value
    if value.startswith("\\\\"):
        return f"\\\\?\\UNC\\{value[2:]}"
    return f"\\\\?\\{value}"


def _public_path(path):
    value = str(path)
    if os.name != "nt":
        return value
    if value.startswith("\\\\?\\UNC\\"):
        return f"\\\\{value[8:]}"
    if value.startswith("\\\\?\\"):
        return value[4:]
    return value


def _canonical_path(path):
    return _public_path(os.path.realpath(_filesystem_path(path)))


def _same_path(left, right):
    return os.path.normcase(_canonical_path(left)) == os.path.normcase(_canonical_path(right))


def _exists(path):
    return os.path.exists(_filesystem_path(path))


def _listdir(path):
    return os.listdir(_filesystem_path(path))


def _lstat(path):
    return os.lstat(_filesystem_path(path))


def _unlink(path):
    return os.unlink(_filesystem_path(path))


def _replace(source, target):
    return os.replace(_filesystem_path(source), _filesystem_path(target))


def _replace_existing_file(replaced, replacement, backup):
    """只替换既有目标，并把旧目标原子移到 backup。

    Windows 生产路径使用 ReplaceFileW：若 Deck 已被外部改名，调用失败且不会
    重新创建旧路径。非 Windows 分支只供本机运行 Windows 后端契约测试。
    """
    replaced = _filesystem_path(replaced)
    replacement = _filesystem_path(replacement)
    backup = _filesystem_path(backup)
    if os.name == "nt":
        replace_file = ctypes.WinDLL("kernel32", use_last_error=True).ReplaceFileW
        replace_file.argtypes = [
            ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p,
            ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p,
        ]
        replace_file.restype = ctypes.c_int
        if not replace_file(replaced, replacement, backup, 0, None, None):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    if not os.path.isfile(replaced):
        raise FileNotFoundError(replaced)
    os.replace(replaced, backup)
    try:
        os.replace(replacement, replaced)
    except Exception:
        os.replace(backup, replaced)
        raise


def _portable_basename(path):
    """同时识别 POSIX 与 Windows 持久化路径中的文件名。"""
    return str(path).replace("\\", "/").rsplit("/", 1)[-1]


def _registry_entry_matches_deck(entry, deck_name, deck_real_path):
    """同一 sidecar 根内允许 macOS/Windows 对同一 Deck 使用不同绝对路径。"""
    if _same_path(entry["deckRealPath"], deck_real_path):
        return True
    expected_name = f"{Path(deck_name).stem}-{entry['initialFingerprint'][:8]}"
    return (
        _portable_basename(entry["deckRealPath"]) == deck_name
        and entry["sessionName"] == expected_name
    )


def _is_link_like(path):
    value = Path(_filesystem_path(path))
    return value.is_symlink() or bool(getattr(value, "is_junction", lambda: False)())


def _capture_directory(path):
    path = os.path.abspath(path)
    info = _lstat(path)
    if not stat.S_ISDIR(info.st_mode) or _is_link_like(path):
        raise SidecarIOError("可信目录不得是符号链接、junction 或其他重解析点")
    real_path = _canonical_path(path)
    if not _same_path(path, real_path):
        raise SidecarIOError("可信目录真实路径与入口路径不一致")
    return {
        "path": path, "realPath": real_path,
        "dev": str(info.st_dev), "ino": str(info.st_ino),
    }


def _assert_directory(identity):
    if not isinstance(identity, dict) or set(identity) != {"path", "realPath", "dev", "ino"}:
        raise SidecarIOError("目录 identity 格式无效")
    current = _capture_directory(identity["path"])
    if (
        not _same_path(current["realPath"], identity["realPath"])
        or current["dev"] != identity["dev"]
        or current["ino"] != identity["ino"]
    ):
        raise SidecarIOError("目录 identity 与启动时不一致")
    return current


def _assert_external_directory(identity):
    """校验 Node 传入的目录身份，并转换成 Python 自己的身份表示。

    Windows 上 Node.js 与 CPython 对同一 NTFS 卷给出的 ``st_dev`` 编码不同，
    但 ``st_ino``（Windows file ID）一致。跨运行时边界因此校验真实路径、
    file ID 和重解析点；进入本 helper 后仍由 ``_assert_directory`` 同时校验
    Python 的 dev/ino。
    """
    if not isinstance(identity, dict) or set(identity) != {"path", "realPath", "dev", "ino"}:
        raise SidecarIOError("目录 identity 格式无效")
    current = _capture_directory(identity["path"])
    dev_changed = os.name != "nt" and current["dev"] != identity["dev"]
    if (
        not _same_path(current["realPath"], identity["realPath"])
        or current["ino"] != identity["ino"]
        or dev_changed
    ):
        raise SidecarIOError("目录 identity 与启动时不一致")
    return current


def _child_directory(parent, name, *, create=False):
    _assert_directory(parent)
    name = _require_name(name)
    path = os.path.join(parent["path"], name)
    if create:
        os.mkdir(_filesystem_path(path)) if not _exists(path) else None
    child = _capture_directory(path)
    if child["dev"] != parent["dev"]:
        raise SidecarIOError("拒绝跨文件系统边界访问 sidecar 子路径")
    _assert_directory(parent)
    return child


def _safe_file_path(directory, name):
    _assert_directory(directory)
    return _filesystem_path(os.path.join(directory["path"], _require_name(name)))


def _read_file(directory, name, *, maximum=None):
    path = _safe_file_path(directory, name)
    before = _lstat(path)
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
        raise SidecarIOError("目标必须是非链接常规文件")
    with open(path, "rb") as source:
        opened = os.fstat(source.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise SidecarIOError("文件 identity 在打开期间变化")
        data = source.read((maximum + 1) if maximum is not None else -1)
    if maximum is not None and len(data) > maximum:
        raise SidecarIOError(
            f"文件超过 {maximum} 字节上限",
            code="SIDECAR_SESSION_TOO_LARGE", status_code=413,
        )
    after = _lstat(path)
    if (after.st_dev, after.st_ino, after.st_size) != (
        before.st_dev, before.st_ino, before.st_size
    ):
        raise SidecarIOError("文件 identity 在读取期间变化")
    _assert_directory(directory)
    return data


def _read_json(directory, name, *, maximum=None):
    return json.loads(_read_file(directory, name, maximum=maximum))


def _atomic_write(directory, name, contents, *, commit_scope):
    public_path = os.path.join(directory["path"], _require_name(name))
    path = _filesystem_path(public_path)
    temporary = _filesystem_path(
        os.path.join(directory["path"], f".{name}.{uuid.uuid4()}.tmp")
    )
    committed = False
    try:
        with open(temporary, "xb") as target:
            target.write(contents)
            target.flush()
            os.fsync(target.fileno())
        _assert_directory(directory)
        _replace(temporary, path)
        committed = True
        _assert_directory(directory)
        return {"path": public_path}
    except Exception as error:
        if isinstance(error, SidecarIOError):
            raise
        raise SidecarIOError(
            f"Windows sidecar 原子写入失败：{error}",
            stage=f"{commit_scope}-replace" if committed else f"{commit_scope}-write",
            committed=committed, commit_scope=commit_scope if committed else None,
        ) from error
    finally:
        if not committed:
            try:
                _unlink(temporary)
            except FileNotFoundError:
                pass


def _safe_unlink(directory, name):
    path = _safe_file_path(directory, name)
    try:
        info = _lstat(path)
    except FileNotFoundError:
        return {"removed": False}
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise SidecarIOError("拒绝删除非常规文件")
    _unlink(path)
    _assert_directory(directory)
    return {"removed": True}


def _safe_remove_tree(parent, name):
    directory = _child_directory(parent, name)
    for child in _listdir(directory["path"]):
        child_path = os.path.join(directory["path"], _require_name(child))
        info = _lstat(child_path)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SidecarIOError("受控附件目录只能包含非链接常规文件")
    for child in _listdir(directory["path"]):
        _unlink(os.path.join(directory["path"], child))
    _assert_directory(directory)
    os.rmdir(_filesystem_path(directory["path"]))
    _assert_directory(parent)


class WindowsPersistentHelper:
    def __init__(self):
        self.project = None
        self.root = None
        self.session = None
        self.snapshots = None
        self.backups = None
        self.transactions = None
        self.write_errors = None
        self.working = None
        self.working_versions = None
        self.attachments = None
        self.attachment_staging = None
        self.deck_name = None
        self.session_id = None
        self.session_name = None
        self.lock_file = None

    def close(self):
        if self.lock_file is not None:
            try:
                if msvcrt is not None:
                    self.lock_file.seek(0)
                    msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                elif fcntl is not None:
                    fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_UN)
            finally:
                self.lock_file.close()
                self.lock_file = None

    def _acquire_lock(self):
        path = os.path.join(self.root["path"], ".session.lock")
        handle = open(_filesystem_path(path), "a+b")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if msvcrt is not None:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            elif fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                raise OSError("缺少文件锁实现")
        except OSError as error:
            handle.close()
            raise SidecarIOError(
                "当前 Deck 已由另一编辑服务占用",
                stage="session-lock", code="SESSION_LOCKED", status_code=409,
            ) from error
        self.lock_file = handle

    @staticmethod
    def _validate_registry(value):
        if not isinstance(value, dict) or set(value) != {"version", "sessions"} \
                or value["version"] not in {1, 2} or not isinstance(value["sessions"], dict):
            raise SidecarIOError("sessions.json schema 无效")
        for session_id, entry in value["sessions"].items():
            if (
                not TRANSACTION_ID_RE.fullmatch(session_id)
                or not isinstance(entry, dict)
                or entry.get("sessionId") != session_id
                or entry.get("mode") not in {"fresh", "legacy"}
                or entry.get("status") not in {"preparing", "active"}
                or not re.fullmatch(r"[a-f0-9]{64}", entry.get("initialFingerprint", ""))
                or not isinstance(entry.get("deckRealPath"), str)
                or not isinstance(entry.get("sessionName"), str)
            ):
                raise SidecarIOError("sessions.json session 记录无效")
            deck_name = _portable_basename(entry["deckRealPath"])
            expected_name = f"{Path(deck_name).stem}-{entry['initialFingerprint'][:8]}"
            if value["version"] == 1 and entry["sessionName"] != expected_name:
                raise SidecarIOError("registry sessionName 未绑定 initialFingerprint")
        return value

    def rebind_deck(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"deckName", "expectedWitness"}:
            raise SidecarIOError("rebind-deck payload 无效")
        if self.session is None:
            raise SidecarIOError("rebind-deck 尚未绑定 session")
        deck_name = _require_name(payload["deckName"])
        witness = payload["expectedWitness"]
        if not deck_name.lower().endswith((".html", ".htm")) \
                or not isinstance(witness, dict) or set(witness) != {"dev", "ino"} \
                or not all(isinstance(witness.get(key), str) for key in ("dev", "ino")):
            raise SidecarIOError("rebind-deck 参数无效")
        path = _safe_file_path(self.project, deck_name)
        info = _lstat(path)
        dev_changed = os.name != "nt" and str(info.st_dev) != witness["dev"]
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) \
                or dev_changed or str(info.st_ino) != witness["ino"]:
            raise SidecarIOError(
                "重新绑定候选的文件见证不一致",
                code="DECK_BINDING_WITNESS_MISMATCH", status_code=409,
            )
        registry = self._validate_registry(_read_json(self.root, "sessions.json"))
        entry = registry["sessions"].get(self.session_id)
        if entry is None or entry["sessionName"] != self.session_name:
            raise SidecarIOError("rebind-deck 未绑定当前 registry session")
        deck_real_path = os.path.join(self.project["realPath"], deck_name)
        registry = {"version": 2, "sessions": dict(registry["sessions"])}
        registry["sessions"][self.session_id] = {**entry, "deckRealPath": deck_real_path}
        _atomic_write(
            self.root, "sessions.json",
            json.dumps(registry, ensure_ascii=False, indent=2).encode(),
            commit_scope="registry",
        )
        self.deck_name = deck_name
        return {"deckName": deck_name, "deckRealPath": deck_real_path}

    def initialize(self, payload):
        if not isinstance(payload, dict) or set(payload) not in ({"project"}, {"project", "root"}):
            raise SidecarIOError("initialize payload 格式无效")
        self.project = _assert_external_directory(payload["project"])
        if "root" in payload:
            self.root = _assert_external_directory(payload["root"])
        else:
            root_path = str(resolve_project_state_root(Path(self.project["path"])))
            os.makedirs(_filesystem_path(root_path), exist_ok=True)
            self.root = _capture_directory(root_path)
        if self.root["dev"] != self.project["dev"]:
            raise SidecarIOError("拒绝跨文件系统边界建立 sidecar")
        self._acquire_lock()
        return {"ready": True, "root": self.root, "backend": "windows-path"}

    def ensure_root(self, payload):
        if payload != {}:
            raise SidecarIOError("ensure-root payload 无效")
        _assert_directory(self.root)
        return {"created": False, "identity": self.root, "backend": "windows-path"}

    def discover(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"deckName"}:
            raise SidecarIOError("discover payload 无效")
        self.deck_name = _require_name(payload["deckName"])
        try:
            registry = self._validate_registry(_read_json(self.root, "sessions.json"))
        except FileNotFoundError:
            return {"registry": None, "sessions": []}
        deck_real = os.path.join(self.project["realPath"], self.deck_name)
        sessions = []
        for entry in registry["sessions"].values():
            if not _registry_entry_matches_deck(entry, self.deck_name, deck_real):
                continue
            path = os.path.join(self.root["path"], entry["sessionName"])
            if not _exists(path):
                kind = "missing"
            else:
                try:
                    _capture_directory(path)
                    kind = "directory"
                except (OSError, SidecarIOError):
                    kind = "unsafe"
            sessions.append({**entry, "kind": kind})
        return {"registry": registry, "sessions": sessions}

    def hash_deck(self, payload):
        if payload != {} or self.deck_name is None:
            raise SidecarIOError("hash-deck 状态无效")
        return {"fingerprint": hashlib.sha256(_read_file(self.project, self.deck_name)).hexdigest()}

    def inspect_legacy(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"deckName", "currentFingerprint"}:
            raise SidecarIOError("inspect-legacy payload 无效")
        prefix = f"{Path(payload['deckName']).stem}-"
        candidates = []
        for name in sorted(_listdir(self.root["path"])):
            if not name.startswith(prefix):
                continue
            session = _child_directory(self.root, name)
            transactions = _child_directory(session, "transactions")
            transaction_ids = []
            for item in _listdir(transactions["path"]):
                if item.endswith(".json"):
                    transaction_ids.append(_require_uuid(item[:-5], "transactionId"))
            candidates.append({
                "sessionName": name,
                "expectedCurrentName": name == f"{prefix}{payload['currentFingerprint'][:8]}",
                "transactionIds": sorted(transaction_ids),
                "sessionState": _read_json(session, "session.json", maximum=MAX_SESSION_BYTES),
            })
        return {"candidates": candidates}

    def prepare_session(self, payload):
        required = {"deckName", "sessionId", "initialFingerprint", "sessionName", "mode"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("prepare-session payload 无效")
        deck_name = _require_name(payload["deckName"])
        session_id = _require_uuid(payload["sessionId"], "sessionId")
        fingerprint = payload["initialFingerprint"]
        session_name = _require_name(payload["sessionName"])
        if not re.fullmatch(r"[a-f0-9]{64}", fingerprint) \
                or session_name != f"{Path(deck_name).stem}-{fingerprint[:8]}" \
                or payload["mode"] not in {"fresh", "legacy"}:
            raise SidecarIOError("prepare-session 参数未绑定 Deck")
        try:
            registry = self._validate_registry(_read_json(self.root, "sessions.json"))
        except FileNotFoundError:
            registry = {"version": 1, "sessions": {}}
        entry = {
            "sessionId": session_id,
            "deckRealPath": os.path.join(self.project["realPath"], deck_name),
            "initialFingerprint": fingerprint,
            "sessionName": session_name,
            "mode": payload["mode"], "status": "preparing",
        }
        registry["sessions"][session_id] = entry
        _atomic_write(
            self.root, "sessions.json",
            json.dumps(registry, ensure_ascii=False, indent=2).encode(),
            commit_scope="registry",
        )
        return entry

    def bind_session(self, payload):
        required = {"deckName", "sessionId", "sessionName", "create"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("bind-session payload 无效")
        registry = self._validate_registry(_read_json(self.root, "sessions.json"))
        entry = registry["sessions"].get(payload["sessionId"])
        deck_real = os.path.join(self.project["realPath"], payload["deckName"])
        if (
            entry is None
            or entry["sessionName"] != payload["sessionName"]
            or not _registry_entry_matches_deck(entry, payload["deckName"], deck_real)
        ):
            raise SidecarIOError("bind-session 未绑定 registry")
        self.deck_name = _require_name(payload["deckName"])
        self.session_id = _require_uuid(payload["sessionId"], "sessionId")
        self.session_name = _require_name(payload["sessionName"])
        self.session = _child_directory(self.root, self.session_name, create=payload["create"])
        identities = {"session": self.session}
        for key, name in (
            ("snapshots", "snapshots"), ("backups", "backups"),
            ("transactions", "transactions"), ("writeErrors", "write-errors"),
        ):
            value = _child_directory(self.session, name, create=payload["create"])
            setattr(self, "write_errors" if key == "writeErrors" else key, value)
            identities[key] = value
        self.working = _child_directory(self.session, "working", create=True)
        self.working_versions = _child_directory(self.working, "versions", create=True)
        identities["working"] = self.working
        identities["workingVersions"] = self.working_versions
        return {"sessionName": self.session_name, "identities": identities}

    def bind_attachments(self, payload):
        if payload != {} or self.session is None:
            raise SidecarIOError("bind-attachments 状态无效")
        self.attachments = _child_directory(self.session, "attachments", create=True)
        self.attachment_staging = _child_directory(self.attachments, ".staging", create=True)
        return {"identities": {
            "attachments": self.attachments,
            "attachmentStaging": self.attachment_staging,
        }}

    def assert_bound(self, payload):
        if payload != {} or self.session is None:
            raise SidecarIOError("assert-bound 状态无效")
        for value in (
            self.project, self.root, self.session, self.snapshots, self.backups,
            self.transactions, self.write_errors, self.working, self.working_versions,
            self.attachments, self.attachment_staging,
        ):
            if value is not None:
                _assert_directory(value)
        return {"safe": True}

    def read_session(self, payload):
        try:
            return _read_json(self.session, "session.json", maximum=MAX_SESSION_BYTES)
        except FileNotFoundError:
            if payload == {"missingOk": True}:
                return None
            raise

    def read_agent_workspace(self, payload):
        try:
            return _read_json(
                self.session, "agent-workspace.json", maximum=MAX_AGENT_WORKSPACE_BYTES
            )
        except FileNotFoundError:
            if payload == {"missingOk": True}:
                return None
            raise

    def write_session(self, payload):
        if payload.get("sessionId") != self.session_id:
            raise SidecarIOError("write-session sessionId 不一致")
        contents = base64.b64decode(payload["bytes"], validate=True)
        state = json.loads(contents)
        if state.get("sessionId") != self.session_id:
            raise SidecarIOError("session.json 未绑定当前 sessionId")
        return _atomic_write(self.session, "session.json", contents, commit_scope="session")

    def write_agent_workspace(self, payload):
        if payload.get("sessionId") != self.session_id:
            raise SidecarIOError("write-agent-workspace sessionId 不一致")
        contents = base64.b64decode(payload["bytes"], validate=True)
        state = json.loads(contents)
        if state.get("version") != 1 or state.get("deckSessionId") != self.session_id:
            raise SidecarIOError("agent-workspace.json 未绑定当前 sessionId")
        return _atomic_write(
            self.session, "agent-workspace.json", contents, commit_scope="agent-workspace"
        )

    def _archive_working_bytes(self, contents):
        fingerprint = hashlib.sha256(contents).hexdigest()
        name = f"{fingerprint}.html"
        try:
            existing = _read_file(self.working_versions, name, maximum=MAX_WORKING_DECK_BYTES)
            if existing != contents:
                raise SidecarIOError("working version 指纹碰撞或内容损坏")
        except FileNotFoundError:
            _atomic_write(
                self.working_versions, name, contents, commit_scope="working-deck"
            )
        return fingerprint

    def read_working_deck(self, payload):
        if not isinstance(payload, dict) or set(payload) not in (
            {"missingOk"}, {"missingOk", "ifFingerprint"}, {"missingOk", "versionFingerprint"}
        ) or not isinstance(payload.get("missingOk"), bool):
            raise SidecarIOError("read-working-deck payload 格式无效")
        version = payload.get("versionFingerprint")
        if version is not None and (not isinstance(version, str) or not re.fullmatch(r"[0-9a-f]{64}", version)):
            raise SidecarIOError("工作副本版本指纹无效")
        expected = payload.get("ifFingerprint")
        if expected is not None and (
            not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected)
        ):
            raise SidecarIOError("工作副本条件指纹无效")
        try:
            contents = _read_file(
                self.working_versions if version else self.working, f"{version}.html" if version else "deck.html", maximum=MAX_WORKING_DECK_BYTES
            )
        except FileNotFoundError:
            if payload["missingOk"]:
                return None
            raise
        fingerprint = hashlib.sha256(contents).hexdigest()
        if version and fingerprint != version:
            raise SidecarIOError("工作副本归档内容与指纹不一致")
        # 仍读取并校验真实文件；相同时避免跨进程复制整份大 HTML。
        if expected == fingerprint:
            return {"unchanged": True, "fingerprint": fingerprint}
        return {
            "bytes": base64.b64encode(contents).decode("ascii"),
            "fingerprint": fingerprint,
        }

    def write_working_deck(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "sessionId", "bytes", "expectedFingerprint"
        } or payload["sessionId"] != self.session_id:
            raise SidecarIOError("write-working-deck payload 无效")
        expected = payload["expectedFingerprint"]
        try:
            current = _read_file(
                self.working, "deck.html", maximum=MAX_WORKING_DECK_BYTES
            )
        except FileNotFoundError:
            current = None
        if current is None:
            if expected is not None:
                raise SidecarIOError(
                    "working Deck 不存在", code="WORKING_DECK_CHANGED", status_code=409
                )
        else:
            actual = hashlib.sha256(current).hexdigest()
            if expected != actual:
                raise SidecarIOError(
                    "working Deck 指纹已变化", code="WORKING_DECK_CHANGED", status_code=409
                )
            self._archive_working_bytes(current)
        contents = base64.b64decode(payload["bytes"], validate=True)
        if len(contents) > MAX_WORKING_DECK_BYTES:
            raise SidecarIOError("working Deck 超过大小上限", status_code=413)
        result = _atomic_write(
            self.working, "deck.html", contents, commit_scope="working-deck"
        )
        return {**result, "fingerprint": self._archive_working_bytes(contents)}

    def archive_working_deck(self, payload):
        expected = payload.get("expectedFingerprint") if isinstance(payload, dict) else None
        contents = _read_file(
            self.working, "deck.html", maximum=MAX_WORKING_DECK_BYTES
        )
        actual = hashlib.sha256(contents).hexdigest()
        if expected != actual:
            raise SidecarIOError(
                "working Deck 在归档前变化", code="WORKING_DECK_CHANGED", status_code=409
            )
        self._archive_working_bytes(contents)
        return {"fingerprint": actual}

    def restore_working_deck(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "fingerprint", "expectedFingerprint"
        }:
            raise SidecarIOError("restore-working-deck payload 无效")
        current = _read_file(
            self.working, "deck.html", maximum=MAX_WORKING_DECK_BYTES
        )
        actual = hashlib.sha256(current).hexdigest()
        if actual != payload["expectedFingerprint"]:
            raise SidecarIOError(
                "working Deck 在恢复前变化", code="WORKING_DECK_CHANGED", status_code=409
            )
        target = payload["fingerprint"]
        contents = _read_file(
            self.working_versions, f"{target}.html", maximum=MAX_WORKING_DECK_BYTES
        )
        if hashlib.sha256(contents).hexdigest() != target:
            raise SidecarIOError("working version 内容损坏")
        self._archive_working_bytes(current)
        _atomic_write(self.working, "deck.html", contents, commit_scope="working-deck")
        return {"fingerprint": target}

    def publish_working_deck(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "sessionId", "transactionId", "expectedDeckFingerprint",
            "expectedWorkingFingerprint",
        } or payload["sessionId"] != self.session_id:
            raise SidecarIOError("publish-working-deck payload 无效")
        transaction_id = _require_uuid(payload["transactionId"], "transactionId")
        original = _read_file(self.project, self.deck_name)
        actual = hashlib.sha256(original).hexdigest()
        if actual != payload["expectedDeckFingerprint"]:
            raise SidecarIOError(
                "真实 Deck 已被外部修改", code="DECK_CHANGED", status_code=409
            )
        candidate = _read_file(
            self.working, "deck.html", maximum=MAX_WORKING_DECK_BYTES
        )
        candidate_fingerprint = hashlib.sha256(candidate).hexdigest()
        if candidate_fingerprint != payload["expectedWorkingFingerprint"]:
            raise SidecarIOError(
                "working Deck 已变化", code="WORKING_DECK_CHANGED", status_code=409
            )
        backup_name = f"{Path(self.deck_name).stem}-{actual}.html"
        try:
            if _read_file(self.backups, backup_name) != original:
                raise SidecarIOError("真实 Deck 的既有备份已损坏")
        except FileNotFoundError:
            _atomic_write(self.backups, backup_name, original, commit_scope="deck-publish")
        candidate_name = f".{self.deck_name}.{uuid.uuid4().hex}.tmp"
        candidate_path = _atomic_write(
            self.project, candidate_name, candidate, commit_scope="deck-publish"
        )["path"]
        exchanged_name = f".{self.deck_name}.{uuid.uuid4().hex}.exchanged"
        exchanged_path = os.path.join(self.project["path"], exchanged_name)
        transaction_name = f"{transaction_id}.json"
        transaction_path = os.path.join(self.transactions["path"], transaction_name)
        backup_path = os.path.join(self.backups["path"], backup_name)
        deck_path = os.path.join(self.project["path"], self.deck_name)
        record = {
            "version": 1, "transactionId": transaction_id,
            "sessionId": self.session_id, "deckPath": deck_path,
            "sessionDir": self.session["path"], "oldFingerprint": actual,
            "candidateFingerprint": candidate_fingerprint, "backup": backup_path,
        }
        transaction_written = False
        exchanged = False
        published = False
        try:
            _atomic_write(
                self.transactions, transaction_name,
                json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode(),
                commit_scope="deck-publish",
            )
            transaction_written = True
            if hashlib.sha256(_read_file(self.project, self.deck_name)).hexdigest() != actual:
                raise SidecarIOError(
                    "真实 Deck 在发布前再次变化", code="DECK_CHANGED", status_code=409
                )
            _assert_directory(self.project)
            try:
                _replace_existing_file(deck_path, candidate_path, exchanged_path)
            except (FileNotFoundError, OSError) as error:
                raise SidecarIOError(
                    "真实 Deck 在固化交换前已移动或变化，拒绝重新创建旧路径",
                    code="DECK_CHANGED", status_code=409,
                ) from error
            exchanged = True
            exchanged_original = _read_file(self.project, exchanged_name)
            exchanged_candidate = _read_file(self.project, self.deck_name)
            if (
                hashlib.sha256(exchanged_original).hexdigest() != actual
                or hashlib.sha256(exchanged_candidate).hexdigest() != candidate_fingerprint
            ):
                raise SidecarIOError(
                    "真实 Deck 在原子交换期间发生身份变化，拒绝固化",
                    code="DECK_CHANGED", status_code=409,
                )
            _assert_directory(self.project)
            _unlink(exchanged_path)
            exchanged = False
            _assert_directory(self.project)
            published = True
            return {
                "ok": True, "fingerprint": candidate_fingerprint,
                "backup": backup_path, "transaction": transaction_path,
            }
        except Exception:
            if exchanged:
                try:
                    current = _read_file(self.project, self.deck_name)
                    held = _read_file(self.project, exchanged_name)
                    if (
                        hashlib.sha256(current).hexdigest() == candidate_fingerprint
                        and hashlib.sha256(held).hexdigest() == actual
                    ):
                        rollback_candidate = os.path.join(
                            self.project["path"],
                            f".{self.deck_name}.{uuid.uuid4().hex}.rollback",
                        )
                        _replace_existing_file(
                            deck_path, exchanged_path, rollback_candidate
                        )
                        exchanged = False
                        try:
                            _unlink(rollback_candidate)
                        except FileNotFoundError:
                            pass
                except Exception:
                    # 无法证明仍是本事务的两个版本时，保留 record 交给重启恢复。
                    pass
            if transaction_written and not exchanged:
                _safe_unlink(self.transactions, transaction_name)
                transaction_written = False
            raise
        finally:
            if not published and not exchanged:
                try:
                    _unlink(candidate_path)
                except FileNotFoundError:
                    pass

    def activate_session(self, payload):
        if payload != {"sessionId": self.session_id}:
            raise SidecarIOError("activate-session sessionId 无效")
        registry = self._validate_registry(_read_json(self.root, "sessions.json"))
        entry = registry["sessions"].get(self.session_id)
        state = self.read_session({"missingOk": False})
        if entry is None or state.get("sessionId") != self.session_id:
            raise SidecarIOError("activate-session 未绑定 preparing session")
        entry = {**entry, "status": "active"}
        registry["sessions"][self.session_id] = entry
        _atomic_write(
            self.root, "sessions.json", json.dumps(registry, ensure_ascii=False, indent=2).encode(),
            commit_scope="registry",
        )
        return entry

    @staticmethod
    def _validate_attachment_files(task_id, files):
        if not isinstance(files, list) or len(files) > 8:
            raise SidecarIOError("files 必须是最多 8 项的附件数组")
        normalized = []
        names = set()
        for item in files:
            if not isinstance(item, dict) or set(item) != {"id", "relativePath", "size"}:
                raise SidecarIOError("附件验证元数据无效")
            attachment_id = _require_uuid(item["id"], "attachmentId")
            relative = item["relativePath"]
            prefix = f"attachments/{task_id}/{attachment_id}"
            if not isinstance(relative, str) or not relative.startswith(prefix):
                raise SidecarIOError("附件 relativePath 未绑定 taskId/attachmentId")
            suffix = relative[len(prefix):]
            if not re.fullmatch(r"\.[a-z0-9]{1,16}", suffix):
                raise SidecarIOError("附件扩展名无效")
            if not isinstance(item["size"], int) or isinstance(item["size"], bool) \
                    or not 0 < item["size"] <= 25 * 1024 * 1024:
                raise SidecarIOError("附件 size 无效")
            name = f"{attachment_id}{suffix}"
            if name in names:
                raise SidecarIOError("附件文件名不得重复")
            names.add(name)
            normalized.append({"id": attachment_id, "name": name, "size": item["size"]})
        return normalized

    @staticmethod
    def _trusted_object_identity(info):
        value = str(info.st_dev)
        return {
            "dev": value, "ino": str(info.st_ino),
            "mountDev": value, "mountId": value,
        }

    def verify_task_attachments(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"taskId", "files"}:
            raise SidecarIOError("verify-task-attachments payload 无效")
        task_id = _require_uuid(payload["taskId"], "taskId")
        files = self._validate_attachment_files(task_id, payload["files"])
        if not files:
            return {"safe": True}
        directory = _child_directory(self.attachments, task_id)
        expected = {item["name"] for item in files}
        if set(_listdir(directory["path"])) != expected:
            raise SidecarIOError("任务附件文件集合不一致")
        for item in files:
            path = _safe_file_path(directory, item["name"])
            info = _lstat(path)
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) \
                    or info.st_size != item["size"]:
                raise SidecarIOError("任务附件 identity 或 size 不一致")
            with open(path, "rb") as source:
                opened = os.fstat(source.fileno())
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise SidecarIOError("任务附件在打开期间变化")
        _assert_directory(directory)
        return {"safe": True}

    def publish_attachments(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"uploadId", "taskId", "files"}:
            raise SidecarIOError("publish-attachments payload 无效")
        upload_id = _require_uuid(payload["uploadId"], "uploadId")
        task_id = _require_uuid(payload["taskId"], "taskId")
        if not isinstance(payload["files"], list) or not 1 <= len(payload["files"]) <= 8:
            raise SidecarIOError("publish files 数量无效")
        files = []
        names = set()
        for item in payload["files"]:
            if not isinstance(item, dict) or set(item) != {"id", "suffix", "size", "sha256"}:
                raise SidecarIOError("publish file 回执无效")
            attachment_id = _require_uuid(item["id"], "attachmentId")
            suffix = item["suffix"]
            if not isinstance(suffix, str) or not re.fullmatch(r"\.[a-z0-9]{1,16}", suffix):
                raise SidecarIOError("附件扩展名无效")
            if not isinstance(item["size"], int) or isinstance(item["size"], bool) \
                    or not 0 < item["size"] <= 25 * 1024 * 1024 \
                    or not isinstance(item["sha256"], str) \
                    or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                raise SidecarIOError("附件 writer 回执无效")
            name = f"{attachment_id}{suffix}"
            if name in names:
                raise SidecarIOError("附件文件名不得重复")
            names.add(name)
            files.append({**item, "name": name})
        upload = _child_directory(self.attachment_staging, upload_id)
        if set(_listdir(upload["path"])) != names:
            raise SidecarIOError("staging 文件集合与 writer 回执不一致")
        for item in files:
            contents = _read_file(upload, item["name"], maximum=25 * 1024 * 1024)
            if len(contents) != item["size"] or hashlib.sha256(contents).hexdigest() != item["sha256"]:
                raise SidecarIOError("staging 文件与 writer 回执不一致")
        target = os.path.join(self.attachments["path"], task_id)
        if _exists(target):
            raise SidecarIOError("task 附件目录已存在，拒绝覆盖")
        renamed = False
        try:
            _assert_directory(self.attachment_staging)
            _assert_directory(self.attachments)
            os.rename(_filesystem_path(upload["path"]), _filesystem_path(target))
            renamed = True
            published = _capture_directory(target)
            _assert_directory(self.attachments)
            if published["ino"] != upload["ino"] or published["dev"] != upload["dev"]:
                raise SidecarIOError("发布后的附件目录 identity 不一致")
        except Exception as error:
            if isinstance(error, SidecarIOError) and not renamed:
                raise
            raise SidecarIOError(
                f"Windows 附件目录发布失败：{error}",
                stage="attachment-publish", committed=renamed,
                commit_scope="attachments" if renamed else None,
            ) from error
        return [{
            "id": item["id"],
            "relativePath": f"attachments/{task_id}/{item['name']}",
            "size": item["size"],
        } for item in files]

    def discard_attachment_upload(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"uploadId", "uploadIdentity", "files"}:
            raise SidecarIOError("discard-attachment-upload payload 无效")
        upload_id = _require_uuid(payload["uploadId"], "uploadId")
        if not isinstance(payload["files"], list) or len(payload["files"]) > 8:
            raise SidecarIOError("discard files 回执无效")
        path = os.path.join(self.attachment_staging["path"], upload_id)
        if not _exists(path):
            return {"removed": False}
        directory = _capture_directory(path)
        identity = payload["uploadIdentity"]
        if not isinstance(identity, dict) or set(identity) != {"dev", "ino", "mountDev", "mountId"} \
                or identity["dev"] != directory["dev"] or identity["ino"] != directory["ino"]:
            raise SidecarIOError("upload identity 不一致")
        expected = set()
        for item in payload["files"]:
            if not isinstance(item, dict) or set(item) != {"id", "suffix", "size", "sha256", "identity"}:
                raise SidecarIOError("discard files 回执无效")
            attachment_id = _require_uuid(item["id"], "attachmentId")
            if not isinstance(item["suffix"], str) \
                    or not re.fullmatch(r"\.[a-z0-9]{1,16}", item["suffix"]):
                raise SidecarIOError("discard 附件扩展名无效")
            name = f"{attachment_id}{item['suffix']}"
            contents = _read_file(directory, name, maximum=25 * 1024 * 1024)
            info = _lstat(os.path.join(directory["path"], name))
            file_identity = item["identity"]
            if len(contents) != item["size"] or hashlib.sha256(contents).hexdigest() != item["sha256"] \
                    or not isinstance(file_identity, dict) \
                    or file_identity.get("dev") != str(info.st_dev) \
                    or file_identity.get("ino") != str(info.st_ino):
                raise SidecarIOError("discard 附件回执与文件不一致")
            expected.add(name)
        if set(_listdir(directory["path"])) != expected:
            raise SidecarIOError("discard staging 文件集合不一致")
        _safe_remove_tree(self.attachment_staging, upload_id)
        return {"removed": True}

    def delete_task_attachments(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"taskId"}:
            raise SidecarIOError("delete-task-attachments payload 无效")
        task_id = _require_uuid(payload["taskId"], "taskId")
        path = os.path.join(self.attachments["path"], task_id)
        if not _exists(path):
            return {"removed": False}
        _safe_remove_tree(self.attachments, task_id)
        return {"removed": True}

    def reconcile_attachments(self, payload):
        referenced = set(payload.get("referencedTaskIds", []))
        discarded = deleted = 0
        for name in list(_listdir(self.attachment_staging["path"])):
            _require_uuid(name, "uploadId")
            _safe_remove_tree(self.attachment_staging, name)
            discarded += 1
        for name in list(_listdir(self.attachments["path"])):
            if name == ".staging":
                continue
            _require_uuid(name, "taskId")
            if name not in referenced:
                _safe_remove_tree(self.attachments, name)
                deleted += 1
        return {"discardedUploads": discarded, "deletedTasks": deleted}

    def list_transactions(self, payload):
        if payload != {}:
            raise SidecarIOError("list-transactions payload 无效")
        values = []
        for name in _listdir(self.transactions["path"]):
            if name.endswith(".json"):
                values.append(_require_uuid(name[:-5], "transactionId"))
        return sorted(values)

    def read_transaction(self, payload):
        transaction_id = _require_uuid(payload.get("transactionId"), "transactionId")
        return _read_json(self.transactions, f"{transaction_id}.json")

    def delete_transaction(self, payload):
        value = _require_uuid(payload.get("transactionId"), "transactionId")
        return _safe_unlink(self.transactions, f"{value}.json")

    def prune_working_versions(self, payload):
        try:
            from working_version_gc import collect_working_versions
        except ModuleNotFoundError:
            from scripts.editor.working_version_gc import collect_working_versions
        self.assert_bound({})
        return collect_working_versions(
            payload, session_id=self.session_id, deck_name=self.deck_name, error_type=SidecarIOError,
            directories={"project": self.project, "session": self.session,
                         "working": self.working, "versions": self.working_versions,
                         "backups": self.backups, "transactions": self.transactions,
                         "writeErrors": self.write_errors},
            list_names=lambda directory: _listdir(directory["path"]),
            file_stat=lambda directory, name: _lstat(_safe_file_path(directory, name)),
            read_file=lambda directory, name, maximum: _read_file(directory, name, maximum=maximum),
            unlink=_safe_unlink, guard=lambda: self.assert_bound({}),
        )

    def prune_transactions(self, payload):
        maximum = payload.get("maximum", 32)
        names = sorted(
            (name for name in _listdir(self.transactions["path"]) if name.endswith(".json")),
            key=lambda name: _lstat(os.path.join(self.transactions["path"], name)).st_mtime_ns,
            reverse=True,
        )
        removed = 0
        for name in names[maximum:]:
            _require_uuid(name[:-5], "transactionId")
            _safe_unlink(self.transactions, name)
            removed += 1
        return {"removed": removed}

    def verify_backup(self, payload):
        fingerprint = payload.get("expectedFingerprint")
        expected = f"{Path(self.deck_name).stem}-{fingerprint}.html"
        if payload.get("backupName") != expected:
            raise SidecarIOError("backup 名称未绑定 Deck 指纹")
        actual = hashlib.sha256(_read_file(self.backups, expected)).hexdigest()
        if actual != fingerprint:
            raise SidecarIOError("备份指纹不一致")
        return {"fingerprint": actual}

    def write_snapshot(self, payload):
        snapshot_id = _require_uuid(payload.get("snapshotId"), "snapshotId")
        return _atomic_write(
            self.snapshots, f"{snapshot_id}.png",
            base64.b64decode(payload["bytes"], validate=True), commit_scope="snapshot",
        )

    def delete_snapshot(self, payload):
        snapshot_id = _require_uuid(payload.get("snapshotId"), "snapshotId")
        return _safe_unlink(self.snapshots, f"{snapshot_id}.png")

    def restore_bound_deck(self, payload):
        backup = _read_file(self.backups, payload["backupName"])
        current = hashlib.sha256(_read_file(self.project, self.deck_name)).hexdigest()
        if current == payload["oldFingerprint"]:
            return {"restored": False, "fingerprint": current}
        if current != payload["candidateFingerprint"]:
            raise SidecarIOError("Deck 已不是本次 candidate，拒绝恢复")
        _atomic_write(self.project, self.deck_name, backup, commit_scope="deck-restore")
        return {"restored": True, "fingerprint": hashlib.sha256(backup).hexdigest()}

    def dispatch(self, request):
        commands = {
            "initialize": self.initialize,
            "ensure-root": self.ensure_root,
            "discover": self.discover,
            "inspect-legacy": self.inspect_legacy,
            "prepare-session": self.prepare_session,
            "bind-session": self.bind_session,
            "bind-attachments": self.bind_attachments,
            "read-session": self.read_session,
            "read-agent-workspace": self.read_agent_workspace,
            "read-working-deck": self.read_working_deck,
            "assert-bound": self.assert_bound,
            "reconcile-attachments": self.reconcile_attachments,
            "read-transaction": self.read_transaction,
            "list-transactions": self.list_transactions,
            "verify-backup": self.verify_backup,
            "hash-deck": self.hash_deck,
            "rebind-deck": self.rebind_deck,
            "write-session": self.write_session,
            "write-agent-workspace": self.write_agent_workspace,
            "write-working-deck": self.write_working_deck,
            "archive-working-deck": self.archive_working_deck,
            "restore-working-deck": self.restore_working_deck,
            "publish-working-deck": self.publish_working_deck,
            "write-snapshot": self.write_snapshot,
            "delete-snapshot": self.delete_snapshot,
            "delete-transaction": self.delete_transaction,
            "prune-transactions": self.prune_transactions,
            "prune-working-versions": self.prune_working_versions,
            "restore-deck": self.restore_bound_deck,
            "activate-session": self.activate_session,
            "publish-attachments": self.publish_attachments,
            "discard-attachment-upload": self.discard_attachment_upload,
            "delete-task-attachments": self.delete_task_attachments,
            "verify-task-attachments": self.verify_task_attachments,
        }
        command = request.get("command") if isinstance(request, dict) else None
        if command == "close":
            return {"closed": True}
        if command not in commands:
            raise SidecarIOError("未知 Windows sidecar command")
        return commands[command](request.get("payload"))


def serve():
    helper = WindowsPersistentHelper()
    try:
        for line in sys.stdin.buffer:
            request = None
            try:
                request = json.loads(line)
                result = helper.dispatch(request)
                response = {"id": request["id"], "ok": True, "result": result}
            except Exception as error:
                response = {
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False, "message": str(error),
                    "code": getattr(error, "code", "UNSAFE_SIDECAR_IO"),
                    "statusCode": getattr(error, "status_code", 500),
                    "stage": getattr(error, "stage", "sidecar"),
                    "committed": bool(getattr(error, "committed", False)),
                    "commitScope": getattr(error, "commit_scope", None),
                }
            encoded = (json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8")
            sys.stdout.buffer.write(encoded)
            sys.stdout.buffer.flush()
            if isinstance(request, dict) and request.get("command") == "close":
                return
    finally:
        helper.close()


if __name__ == "__main__":
    if sys.argv[1:] != ["--serve"]:
        raise SystemExit("sidecar_io_windows.py 只支持受控 --serve 模式")
    serve()
