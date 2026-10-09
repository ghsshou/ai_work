"""sidecar 的可信 dirfd I/O 边界。

所有会改变 sidecar、事务记录或 Deck 的操作，都先打开启动时记录的目录
identity，再只使用单层文件名和 ``dir_fd`` 完成。这样即使路径在校验后被替换，
也不会把数据写进替换目录。
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid
import re
import struct

try:
    from product_paths import (
        LEGACY_PROJECT_STATE_DIRECTORY,
        PROJECT_STATE_DIRECTORY,
        resolve_project_state_root,
    )
except ModuleNotFoundError:
    from scripts.editor.product_paths import (
        LEGACY_PROJECT_STATE_DIRECTORY,
        PROJECT_STATE_DIRECTORY,
        resolve_project_state_root,
    )

try:
    import fcntl
except ImportError:  # pragma: no cover - 当前生产平台为 macOS/Linux
    fcntl = None


CONTROL_REQUEST_BYTES = 1024 * 1024
MAX_SESSION_BYTES = 32 * 1024 * 1024
MAX_SESSION_REQUEST_BYTES = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_WORKING_DECK_BYTES = 48 * 1024 * 1024
MAX_AGENT_WORKSPACE_BYTES = 2 * 1024 * 1024
MAX_AGENT_WORKSPACE_REQUEST_BYTES = 4 * 1024 * 1024
MAX_AGENT_WORKSPACE_RESPONSE_BYTES = 4 * 1024 * 1024
TRANSACTION_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
ATTACHMENT_FILE_RE = re.compile(
    r"^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
    r"(\.[a-z0-9]{1,16})$"
)
MAX_ATTACHMENTS = 8
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
STATX_MNT_ID = 0x00001000
AT_EMPTY_PATH = 0x00001000
AT_STATX_DONT_SYNC = 0x00004000


class SidecarIOError(RuntimeError):
    def __init__(
        self, message, *, stage="open", committed=False,
        commit_scope=None, code="UNSAFE_SIDECAR_IO", status_code=500,
        details=None,
    ):
        super().__init__(message)
        self.stage = stage
        self.committed = committed
        self.commit_scope = commit_scope
        self.code = code
        self.status_code = status_code
        self.details = details


def _require_name(name: str) -> str:
    if (
        not isinstance(name, str)
        or name in {"", ".", ".."}
        or os.path.basename(name) != name
        or "/" in name
        or "\\" in name
    ):
        raise SidecarIOError("I/O 文件名必须是单层相对名称")
    return name


def _require_uuid(value, label="ID"):
    if not isinstance(value, str) or not TRANSACTION_ID_RE.fullmatch(value):
        raise SidecarIOError(f"{label} 不是规范小写 UUID v4")
    return value


def _portable_basename(path):
    """同时识别 POSIX 与 Windows 持久化路径中的文件名。"""
    return str(path).replace("\\", "/").rsplit("/", 1)[-1]


def _registry_entry_matches_deck(entry, deck_name, deck_real_path):
    """同一 sidecar 根内允许 macOS/Windows 对同一 Deck 使用不同绝对路径。"""
    if entry["deckRealPath"] == deck_real_path:
        return True
    expected_name = f"{Path(deck_name).stem}-{entry['initialFingerprint'][:8]}"
    return (
        _portable_basename(entry["deckRealPath"]) == deck_name
        and entry["sessionName"] == expected_name
    )


def _validate_publish_files(value):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ATTACHMENTS:
        raise SidecarIOError(f"files 必须包含 1–{MAX_ATTACHMENTS} 个附件回执")
    normalized = []
    ids = set()
    for item in value:
        if (
            not isinstance(item, dict)
            or set(item) != {"id", "suffix", "size", "sha256"}
        ):
            raise SidecarIOError("附件回执格式无效")
        attachment_id = _require_uuid(item["id"], "attachmentId")
        suffix = item["suffix"]
        size = item["size"]
        digest = item["sha256"]
        if not isinstance(suffix, str) or not re.fullmatch(r"\.[a-z0-9]{1,16}", suffix):
            raise SidecarIOError("附件扩展名无效")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or not 0 < size <= MAX_ATTACHMENT_BYTES
        ):
            raise SidecarIOError("附件大小回执无效")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise SidecarIOError("附件 SHA-256 回执无效")
        if attachment_id in ids:
            raise SidecarIOError("附件回执 ID 不得重复")
        ids.add(attachment_id)
        normalized.append({
            "id": attachment_id, "suffix": suffix, "size": size,
            "sha256": digest,
        })
    return normalized


def _validate_verify_files(task_id, value):
    if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS:
        raise SidecarIOError(f"files 必须包含 0–{MAX_ATTACHMENTS} 个附件元数据")
    normalized = []
    names = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {
            "id", "relativePath", "size"
        }:
            raise SidecarIOError("附件验证元数据格式无效")
        attachment_id = _require_uuid(item["id"], "attachmentId")
        relative_path = item["relativePath"]
        size = item["size"]
        if not isinstance(relative_path, str):
            raise SidecarIOError("附件 relativePath 格式无效")
        expected_prefix = f"attachments/{task_id}/{attachment_id}"
        if not relative_path.startswith(expected_prefix):
            raise SidecarIOError("附件 relativePath 与 taskId/attachmentId 不一致")
        suffix = relative_path[len(expected_prefix):]
        if not re.fullmatch(r"\.[a-z0-9]{1,16}", suffix):
            raise SidecarIOError("附件 relativePath 扩展名无效")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or not 0 < size <= MAX_ATTACHMENT_BYTES
        ):
            raise SidecarIOError("附件验证 size 无效")
        name = f"{attachment_id}{suffix}"
        if name in names:
            raise SidecarIOError("附件验证文件名不得重复")
        names.add(name)
        normalized.append({"name": name, "size": size})
    return normalized


def _validate_attachment_object_identity(value, label):
    keys = {"dev", "ino", "mountDev", "mountId"}
    if not isinstance(value, dict) or set(value) != keys:
        raise SidecarIOError(f"{label} identity 格式无效")
    normalized = {}
    for key in keys:
        item = value[key]
        if not isinstance(item, str) or not re.fullmatch(r"-?[0-9]+", item):
            raise SidecarIOError(f"{label} identity 格式无效")
        if str(int(item)) != item:
            raise SidecarIOError(f"{label} identity 必须是规范十进制字符串")
        normalized[key] = item
    if int(normalized["dev"]) < 0 or int(normalized["ino"]) < 0:
        raise SidecarIOError(f"{label} identity 不得为负数")
    if normalized["dev"] != normalized["mountDev"]:
        raise SidecarIOError(f"{label} dev 与 mountDev 不一致")
    return normalized


def _validate_discard_files(value):
    if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS:
        raise SidecarIOError(f"files 必须包含 0–{MAX_ATTACHMENTS} 个可信附件回执")
    normalized = []
    ids = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {
            "id", "suffix", "size", "sha256", "identity"
        }:
            raise SidecarIOError("discard 附件回执格式无效")
        publish = _validate_publish_files([{key: item[key] for key in (
            "id", "suffix", "size", "sha256"
        )}])[0]
        if publish["id"] in ids:
            raise SidecarIOError("discard 附件回执 ID 不得重复")
        ids.add(publish["id"])
        normalized.append({
            **publish,
            "identity": _validate_attachment_object_identity(
                item["identity"], "附件文件"
            ),
        })
    return normalized


def _require_identity(identity: dict) -> dict:
    required = {"path", "realPath", "dev", "ino"}
    if (
        not isinstance(identity, dict)
        or set(identity) != required
        or any(not isinstance(identity.get(key), str) for key in required)
    ):
        raise SidecarIOError("目录 identity 格式无效")
    return identity


def _open_directory(identity: dict) -> int:
    identity = _require_identity(identity)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(identity["path"], flags)
    except OSError as error:
        raise SidecarIOError(f"无法打开可信目录：{error}") from error
    info = os.fstat(fd)
    if (
        not stat.S_ISDIR(info.st_mode)
        or str(info.st_dev) != identity["dev"]
        or str(info.st_ino) != identity["ino"]
    ):
        os.close(fd)
        raise SidecarIOError("目录句柄 identity 与启动时不一致")
    return fd


def _linux_mount_id(fd, *, statx_call=None):
    """从 statx(AT_EMPTY_PATH) 读取 Linux mount ID，避免同设备 bind mount。"""
    if statx_call is None:
        libc = ctypes.CDLL(None, use_errno=True)
        try:
            statx_call = libc.statx
        except AttributeError as error:  # pragma: no cover - 现代 glibc 都应提供
            raise SidecarIOError("Linux 缺少 statx，无法验证 mount identity") from error
        statx_call.argtypes = [
            ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p,
        ]
        statx_call.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(256)
    result = statx_call(
        fd, b"", AT_EMPTY_PATH | AT_STATX_DONT_SYNC, STATX_MNT_ID, buffer
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise SidecarIOError(
            f"statx mount identity 失败：{os.strerror(error_number)}"
        )
    mask = struct.unpack_from("=I", buffer.raw, 0)[0]
    if not mask & STATX_MNT_ID:
        raise SidecarIOError("statx 未返回 mount identity")
    return struct.unpack_from("=Q", buffer.raw, 144)[0]


def _mount_identity(fd):
    info = os.fstat(fd)
    if sys.platform == "darwin":
        mount_id = os.fstatvfs(fd).f_fsid
    elif sys.platform.startswith("linux"):
        mount_id = _linux_mount_id(fd)
    else:  # pragma: no cover - 当前生产平台为 macOS/Linux
        raise SidecarIOError("当前平台不支持可靠 mount identity")
    return (str(info.st_dev), str(mount_id))


def _matches_attachment_object_identity(fd, expected):
    info = os.fstat(fd)
    mount_dev, mount_id = _mount_identity(fd)
    return (
        str(info.st_dev) == expected["dev"]
        and str(info.st_ino) == expected["ino"]
        and mount_dev == expected["mountDev"]
        and mount_id == expected["mountId"]
    )


def _require_same_mount(parent_fd, child_fd):
    if _mount_identity(parent_fd) != _mount_identity(child_fd):
        raise SidecarIOError("拒绝跨 mount 边界访问 sidecar 子路径")


def _read_fd_file(directory_fd: int, name: str, *, max_bytes=None) -> bytes:
    flags = (
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    )
    fd = os.open(_require_name(name), flags, dir_fd=directory_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SidecarIOError("目标必须是非符号链接的常规文件")
        chunks = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            if max_bytes is not None and sum(map(len, chunks)) > max_bytes:
                raise SidecarIOError(
                    f"文件超过 {max_bytes} 字节上限",
                    code="SIDECAR_SESSION_TOO_LARGE", status_code=413,
                )
    finally:
        os.close(fd)


def _open_child_directory(parent_fd: int, name: str, *, create: bool) -> int:
    name = _require_name(name)
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        except FileExistsError:
            pass
    flags = (
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as error:
        raise SidecarIOError(f"无法打开可信 sidecar 子目录：{error}") from error
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        raise SidecarIOError("sidecar 子路径不是常规目录")
    try:
        _require_same_mount(parent_fd, fd)
    except Exception:
        os.close(fd)
        raise
    return fd


def _rename_directory_no_replace(source_fd, source, target_fd, target):
    """使用平台原生 no-replace rename 原子发布目录。"""
    source = os.fsencode(_require_name(source))
    target = os.fsencode(_require_name(target))
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = libc.renameatx_np
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                           ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(source_fd, source, target_fd, target, 0x00000004)
    elif sys.platform.startswith("linux"):
        try:
            rename = libc.renameat2
        except AttributeError as error:  # pragma: no cover - 现代 glibc 提供该入口
            raise SidecarIOError("当前平台缺少原子 no-replace rename") from error
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                           ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(source_fd, source, target_fd, target, 0x00000001)
    else:  # pragma: no cover - 当前生产平台为 macOS/Linux
        raise SidecarIOError("当前平台不支持原子附件目录发布")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), os.fsdecode(target))


def _exchange_file_entries(directory_fd, left, right):
    """原子交换两个既有文件名；任一名字消失时绝不创建替代路径。"""
    left = os.fsencode(_require_name(left))
    right = os.fsencode(_require_name(right))
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        exchange = libc.renameatx_np
        exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                             ctypes.c_uint]
        exchange.restype = ctypes.c_int
        result = exchange(directory_fd, left, directory_fd, right, 0x00000002)
    elif sys.platform.startswith("linux"):
        try:
            exchange = libc.renameat2
        except AttributeError as error:  # pragma: no cover - 现代 glibc 提供该入口
            raise SidecarIOError("当前平台缺少原子文件 exchange") from error
        exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                             ctypes.c_uint]
        exchange.restype = ctypes.c_int
        result = exchange(directory_fd, left, directory_fd, right, 0x00000002)
    else:  # pragma: no cover - Windows 使用独立 helper
        raise SidecarIOError("当前平台不支持原子文件 exchange")
    if result != 0:
        error_number = ctypes.get_errno()
        if sys.platform.startswith("linux") and os.environ.get("WSL_DISTRO_NAME") \
                and error_number in (errno.EINVAL, errno.ENOTSUP, errno.ENOSYS):
            from wsl_file_exchange import exchange as windows_exchange, ExchangeError
            try:
                return windows_exchange(directory_fd, os.fsdecode(left), os.fsdecode(right))
            except ExchangeError as error:
                raise SidecarIOError(str(error), code="WINDOWS_PUBLISH_FAILED",
                                     committed=error.committed,
                                     commit_scope="deck" if error.committed else None) from error
        raise OSError(error_number, os.strerror(error_number), os.fsdecode(right))


def _open_managed_attachment_directory(parent_fd, name):
    """打开单层 UUID 目录并确认打开前后的目录项 identity 一致。"""
    name = _require_uuid(name)
    fd = None
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode):
            raise SidecarIOError("附件目录必须是真实目录")
        fd = _open_child_directory(parent_fd, name, create=False)
        held = os.fstat(fd)
        after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISDIR(after.st_mode)
            or before.st_dev != held.st_dev
            or before.st_ino != held.st_ino
            or after.st_dev != held.st_dev
            or after.st_ino != held.st_ino
        ):
            os.close(fd)
            fd = None
            raise SidecarIOError("附件目录 identity 在打开期间变化")
        return fd
    except FileNotFoundError:
        if fd is not None:
            os.close(fd)
        raise
    except SidecarIOError:
        if fd is not None:
            os.close(fd)
        raise
    except OSError as error:
        if fd is not None:
            os.close(fd)
        raise SidecarIOError(f"无法安全打开附件目录：{error}") from error


def _file_stat_signature(info):
    return (
        info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_nlink,
        info.st_mtime_ns, info.st_ctime_ns,
    )


def _hash_open_file(fd, expected_size):
    if (
        not isinstance(expected_size, int)
        or isinstance(expected_size, bool)
        or not 1 <= expected_size <= MAX_ATTACHMENT_BYTES
    ):
        raise SidecarIOError("附件 hash size 超出允许范围")
    digest = hashlib.sha256()
    offset = 0
    while offset < expected_size:
        remaining = expected_size - offset
        chunk = os.pread(fd, min(1024 * 1024, remaining), offset)
        if not chunk:
            raise SidecarIOError("附件读取少于初始 size")
        if len(chunk) > remaining:
            raise SidecarIOError("附件读取超过初始 size")
        digest.update(chunk)
        offset += len(chunk)
    if os.pread(fd, 1, expected_size):
        raise SidecarIOError("附件在 hash 期间增长")
    return digest.hexdigest()


def _capture_file_baseline(directory_fd, fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise SidecarIOError("附件必须是 link count 为 1 的常规文件")
    if not 1 <= before.st_size <= MAX_ATTACHMENT_BYTES:
        raise SidecarIOError("附件文件大小超出允许范围")
    _require_same_mount(directory_fd, fd)
    mount_identity = _mount_identity(fd)
    digest = _hash_open_file(fd, before.st_size)
    after = os.fstat(fd)
    if (
        _file_stat_signature(before) != _file_stat_signature(after)
        or mount_identity != _mount_identity(fd)
    ):
        raise SidecarIOError("附件文件在读取 baseline 期间变化")
    return {
        "signature": _file_stat_signature(after),
        "mountIdentity": mount_identity,
        "sha256": digest,
        "size": after.st_size,
    }


def _scan_attachment_files(directory_fd, *, expected=None, keep_open=False):
    """只接受 UUID+短扩展名的常规文件；可保持 fd 供发布后复核。"""
    expected = None if expected is None else {
        f"{item['id']}{item['suffix']}": item for item in expected
    }
    names = os.listdir(directory_fd)
    if len(names) > MAX_ATTACHMENTS:
        raise SidecarIOError(f"附件目录最多允许 {MAX_ATTACHMENTS} 个文件")
    names.sort()
    ids = set()
    for name in names:
        match = ATTACHMENT_FILE_RE.fullmatch(name)
        if match is None or match.group(1) in ids:
            raise SidecarIOError("附件目录包含非规范文件名")
        ids.add(match.group(1))
    if expected is not None and set(names) != set(expected):
        raise SidecarIOError("staging 文件集合与可信 writer 回执不一致")
    opened = {}
    try:
        for name in names:
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                raise SidecarIOError("附件目录只允许非符号链接的常规文件")
            flags = (
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_NONBLOCK", 0)
            )
            fd = os.open(name, flags, dir_fd=directory_fd)
            try:
                held = os.fstat(fd)
                if (
                    not stat.S_ISREG(held.st_mode)
                    or held.st_dev != before.st_dev
                    or held.st_ino != before.st_ino
                ):
                    raise SidecarIOError("附件文件 identity 在打开期间变化")
                if expected is not None:
                    receipt = expected.get(name)
                    if receipt is None or held.st_size != receipt["size"]:
                        raise SidecarIOError("附件文件与可信 writer 回执不一致")
                baseline = _capture_file_baseline(directory_fd, fd)
                if (
                    expected is not None
                    and baseline["sha256"] != receipt["sha256"]
                ):
                    raise SidecarIOError("附件内容与可信 writer SHA-256 回执不一致")
            except Exception:
                if fd is not None:
                    os.close(fd)
                    fd = None
                raise
            if keep_open:
                opened[name] = {"fd": fd, "baseline": baseline}
            else:
                os.close(fd)
        return names, opened
    except Exception:
        for record in opened.values():
            os.close(record["fd"])
        raise


def _verify_open_attachment_files(directory_fd, opened):
    if set(os.listdir(directory_fd)) != set(opened):
        raise SidecarIOError("附件目录在发布期间发生变化")
    for name, record in opened.items():
        fd = record["fd"]
        entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        flags = (
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0)
        )
        current_fd = os.open(name, flags, dir_fd=directory_fd)
        try:
            current = os.fstat(current_fd)
            held = os.fstat(fd)
            if (
                not stat.S_ISREG(entry.st_mode)
                or not stat.S_ISREG(current.st_mode)
                or entry.st_dev != current.st_dev
                or entry.st_ino != current.st_ino
                or current.st_dev != held.st_dev
                or current.st_ino != held.st_ino
                or current.st_size != held.st_size
            ):
                raise SidecarIOError("附件文件 identity 在发布期间变化")
            _require_same_mount(directory_fd, current_fd)
            if _mount_identity(current_fd) != record["baseline"]["mountIdentity"]:
                raise SidecarIOError("附件文件 mount identity 在发布期间变化")
        finally:
            os.close(current_fd)
        if _capture_file_baseline(directory_fd, fd) != record["baseline"]:
            raise SidecarIOError("附件文件内容或元数据在发布期间变化")


def _verify_task_attachment_directory(parent_fd, task_id, expected_files):
    """只读验证已发布 task 目录；所有路径访问只基于可信 attachments dirfd。"""
    directory_fd = None
    opened = {}
    try:
        try:
            directory_fd = _open_managed_attachment_directory(parent_fd, task_id)
        except FileNotFoundError as error:
            raise SidecarIOError("任务附件目录不存在") from error
        directory_signature = _directory_stat_signature(os.fstat(directory_fd))
        directory_mount = _mount_identity(directory_fd)
        expected = {item["name"]: item for item in expected_files}
        names = os.listdir(directory_fd)
        if len(names) > MAX_ATTACHMENTS or set(names) != set(expected):
            raise SidecarIOError("任务附件文件集合与持久化元数据不一致")

        for name in names:
            item = expected[name]
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                raise SidecarIOError("任务附件只允许非符号链接的常规文件")
            flags = (
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_NONBLOCK", 0)
            )
            fd = os.open(name, flags, dir_fd=directory_fd)
            try:
                held = os.fstat(fd)
                if (
                    not stat.S_ISREG(held.st_mode)
                    or held.st_nlink != 1
                    or held.st_dev != before.st_dev
                    or held.st_ino != before.st_ino
                    or held.st_size != item["size"]
                ):
                    raise SidecarIOError("任务附件 identity 或 size 与持久化元数据不一致")
                _require_same_mount(directory_fd, fd)
                opened[name] = {
                    "fd": fd,
                    "signature": _file_stat_signature(held),
                    "mountIdentity": _mount_identity(fd),
                }
                fd = None
            finally:
                if fd is not None:
                    os.close(fd)

        if (
            not PersistentHelper._same_directory_entry(parent_fd, task_id, directory_fd)
            or _directory_stat_signature(os.fstat(directory_fd)) != directory_signature
            or _mount_identity(directory_fd) != directory_mount
            or set(os.listdir(directory_fd)) != set(expected)
        ):
            raise SidecarIOError("任务附件目录 identity 在验证期间变化")

        for name, record in opened.items():
            entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            flags = (
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_NONBLOCK", 0)
            )
            current_fd = os.open(name, flags, dir_fd=directory_fd)
            try:
                held = os.fstat(record["fd"])
                current = os.fstat(current_fd)
                if (
                    not stat.S_ISREG(entry.st_mode)
                    or not stat.S_ISREG(current.st_mode)
                    or current.st_nlink != 1
                    or entry.st_dev != current.st_dev
                    or entry.st_ino != current.st_ino
                    or current.st_dev != held.st_dev
                    or current.st_ino != held.st_ino
                    or _file_stat_signature(held) != record["signature"]
                    or _file_stat_signature(current) != record["signature"]
                ):
                    raise SidecarIOError("任务附件文件 identity 在验证期间变化")
                _require_same_mount(directory_fd, current_fd)
                if _mount_identity(current_fd) != record["mountIdentity"]:
                    raise SidecarIOError("任务附件 mount identity 在验证期间变化")
            finally:
                os.close(current_fd)
        return {"safe": True}
    except SidecarIOError:
        raise
    except OSError as error:
        raise SidecarIOError(f"无法安全验证任务附件：{error}") from error
    finally:
        for record in opened.values():
            os.close(record["fd"])
        if directory_fd is not None:
            os.close(directory_fd)


def _fsync_attachment_publish_parents(staging_fd, attachments_fd):
    errors = []
    for label, fd in (("staging", staging_fd), ("attachments", attachments_fd)):
        try:
            os.fsync(fd)
        except OSError as error:
            errors.append(f"{label}: {error}")
    if errors:
        raise SidecarIOError(
            "附件已发布但父目录 fsync 失败：" + "; ".join(errors),
            stage="attachment-directory-fsync", committed=True,
            commit_scope="attachments", code="ATTACHMENT_PUBLISH_FAILED",
        )


def _directory_stat_signature(info):
    return (
        info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
        info.st_mtime_ns, info.st_ctime_ns,
    )


def _capture_managed_attachment_directory(parent_fd, name):
    try:
        directory_fd = _open_managed_attachment_directory(parent_fd, name)
    except FileNotFoundError:
        return None
    files = {}
    try:
        names, files = _scan_attachment_files(directory_fd, keep_open=True)
        info = os.fstat(directory_fd)
        return {
            "name": name,
            "fd": directory_fd,
            "signature": _directory_stat_signature(info),
            "mountIdentity": _mount_identity(directory_fd),
            "names": names,
            "files": files,
        }
    except Exception:
        for file_record in files.values():
            os.close(file_record["fd"])
        os.close(directory_fd)
        raise


def _close_managed_attachment_record(record):
    if record is None:
        return
    for file_record in record["files"].values():
        os.close(file_record["fd"])
    os.close(record["fd"])


def _verify_managed_attachment_record(parent_fd, record):
    directory_fd = record["fd"]
    if not PersistentHelper._same_directory_entry(
        parent_fd, record["name"], directory_fd
    ):
        raise SidecarIOError("附件目录 identity 在预检后变化")
    current = os.fstat(directory_fd)
    if (
        _directory_stat_signature(current) != record["signature"]
        or _mount_identity(directory_fd) != record["mountIdentity"]
        or set(os.listdir(directory_fd)) != set(record["names"])
    ):
        raise SidecarIOError("附件目录树在预检后变化")
    _verify_open_attachment_files(directory_fd, record["files"])


def _verify_trusted_discard_record(record, upload_identity, files):
    if not _matches_attachment_object_identity(record["fd"], upload_identity):
        raise SidecarIOError("staging upload 与可信 writer identity 不一致")
    expected = {f"{item['id']}{item['suffix']}": item for item in files}
    if set(record["names"]) != set(expected):
        raise SidecarIOError("staging 文件集合与可信 writer 回执不一致")
    for name, file_record in record["files"].items():
        item = expected[name]
        if (
            not _matches_attachment_object_identity(
                file_record["fd"], item["identity"]
            )
            or file_record["baseline"]["size"] != item["size"]
            or file_record["baseline"]["sha256"] != item["sha256"]
        ):
            raise SidecarIOError("staging 文件与可信 writer baseline 不一致")


def _remove_preflighted_attachment_directory(parent_fd, record):
    _verify_managed_attachment_record(parent_fd, record)
    directory_fd = record["fd"]
    committed = False
    details = {
        "target": record["name"],
        "unlinkedFiles": 0,
        "directoryRemoved": False,
    }
    try:
        for child in record["names"]:
            os.unlink(child, dir_fd=directory_fd)
            committed = True
            details["unlinkedFiles"] += 1
        os.fsync(directory_fd)
        if not PersistentHelper._same_directory_entry(
            parent_fd, record["name"], directory_fd
        ):
            raise SidecarIOError("待删除附件目录 identity 已变化")
        os.rmdir(record["name"], dir_fd=parent_fd)
        committed = True
        details["directoryRemoved"] = True
        try:
            os.stat(record["name"], dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SidecarIOError("附件目录删除后同名条目再次出现")
        os.fsync(parent_fd)
        return {"removed": True}
    except (SidecarIOError, OSError) as error:
        if committed:
            raise SidecarIOError(
                f"附件目录删除已部分提交：{error}",
                stage="attachment-delete", committed=True,
                commit_scope="attachments", code="ATTACHMENT_DELETE_FAILED",
                details=details,
            ) from error
        if isinstance(error, SidecarIOError):
            raise
        raise SidecarIOError(f"无法安全删除附件目录：{error}", stage="unlink") from error


def _remove_managed_attachment_directory(parent_fd, name):
    record = _capture_managed_attachment_directory(parent_fd, name)
    if record is None:
        return {"removed": False}
    try:
        os.fsync(parent_fd)
        _verify_managed_attachment_record(parent_fd, record)
        return _remove_preflighted_attachment_directory(parent_fd, record)
    finally:
        _close_managed_attachment_record(record)


@contextmanager
def _attachment_lifecycle_lock(attachments_fd):
    if fcntl is None:
        raise SidecarIOError(
            "当前平台不支持附件生命周期锁",
            code="SIDECAR_LOCK_UNSUPPORTED", status_code=500,
        )
    try:
        fcntl.flock(attachments_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise SidecarIOError(
            "附件 writer 或生命周期命令正在运行",
            stage="attachment-lock", code="ATTACHMENT_BUSY", status_code=409,
        ) from error
    try:
        yield
    finally:
        fcntl.flock(attachments_fd, fcntl.LOCK_UN)


def _with_attachment_lifecycle_lock(method):
    def locked(self, payload):
        if self.attachments_fd is None or self.attachment_staging_fd is None:
            raise SidecarIOError(
                "尚未绑定可信 attachments",
                stage="attachment-bind", committed=False,
                code="ATTACHMENTS_NOT_BOUND", status_code=409,
            )
        with _attachment_lifecycle_lock(self.attachments_fd):
            return method(self, payload)
    return locked


def _decode_json_file(directory_fd: int, name: str, *, max_bytes=None):
    try:
        return json.loads(_read_fd_file(directory_fd, name, max_bytes=max_bytes))
    except json.JSONDecodeError as error:
        raise SidecarIOError(f"{name} 不是有效 JSON") from error


def _atomic_write_fd(directory_fd: int, name: str, contents: bytes, *, commit_scope: str):
    """仅在持久 helper 已持有的目录 fd 内原子发布文件。"""
    if commit_scope not in {
        "session", "snapshot", "registry", "agent-workspace", "working-deck",
        "deck-publish",
    }:
        raise SidecarIOError("原子写 commitScope 无效")
    name = _require_name(name)
    temporary = f".{name}.{uuid.uuid4()}.tmp"
    renamed = False
    fd = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(temporary, flags, 0o600, dir_fd=directory_fd)
        view = memoryview(contents)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        renamed = True
        os.fsync(directory_fd)
        return {"committed": True, "commitScope": commit_scope}
    except Exception as error:
        wrapped = SidecarIOError(
            str(error),
            stage=(
                f"{commit_scope}-directory-fsync"
                if renamed else f"{commit_scope}-write"
            ),
            committed=renamed,
            commit_scope=commit_scope,
            code=f"{commit_scope.upper().replace('-', '_')}_WRITE_FAILED",
        )
        raise wrapped from error
    finally:
        if fd is not None:
            os.close(fd)
        if not renamed:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError:
                pass


def _decode_bytes(value, *, max_bytes=None):
    if not isinstance(value, str):
        raise SidecarIOError("bytes 必须是 base64 字符串")
    if max_bytes is not None and len(value) > 4 * ((max_bytes + 2) // 3):
        raise SidecarIOError(
            f"bytes 解码后不得超过 {max_bytes} 字节",
            code="SIDECAR_SESSION_TOO_LARGE", status_code=413,
        )
    decoded = base64.b64decode(value, validate=True)
    if max_bytes is not None and len(decoded) > max_bytes:
        raise SidecarIOError(
            f"bytes 解码后不得超过 {max_bytes} 字节",
            code="SIDECAR_SESSION_TOO_LARGE", status_code=413,
        )
    return decoded


class PersistentHelper:
    """长期持有可信目录 fd 的生产 helper；只接受专用 JSONL 命令。"""

    def __init__(self):
        self.project_fd = None
        self.root_fd = None
        self.project_identity = None
        self.root_identity = None
        self.root_name = None
        self.root_locked = False
        self.deck_name = None
        self.session_id = None
        self.session_name = None
        self.session_fd = None
        self.snapshots_fd = None
        self.backups_fd = None
        self.transactions_fd = None
        self.write_errors_fd = None
        self.working_fd = None
        self.working_versions_fd = None
        self.attachments_fd = None
        self.attachment_staging_fd = None

    def close(self):
        if self.root_locked and self.root_fd is not None:
            if fcntl is not None:
                fcntl.flock(self.root_fd, fcntl.LOCK_UN)
            self.root_locked = False
        for name in (
            "attachment_staging_fd", "attachments_fd", "write_errors_fd",
            "working_versions_fd", "working_fd", "transactions_fd", "backups_fd",
            "snapshots_fd", "session_fd", "root_fd", "project_fd",
        ):
            fd = getattr(self, name)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)

    def _acquire_session_lock(self):
        if fcntl is None:
            raise SidecarIOError(
                "当前平台不支持 sidecar session lock",
                code="SIDECAR_LOCK_UNSUPPORTED", status_code=500,
            )
        try:
            fcntl.flock(self.root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SidecarIOError(
                "当前 Deck 已由另一编辑服务占用",
                stage="session-lock", code="SESSION_LOCKED", status_code=409,
            ) from error
        self.root_locked = True

    def _require_bound_session(self):
        if self.session_fd is None:
            raise SidecarIOError("尚未绑定可信 session")

    def bind_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "deckName", "sessionId", "sessionName", "create"
        }:
            raise SidecarIOError("bind-session payload 格式无效")
        if self.root_fd is None:
            raise SidecarIOError("尚未绑定可信 sidecar root")
        deck_name = _require_name(payload["deckName"])
        session_id = payload["sessionId"]
        if (
            not deck_name.endswith(".html")
            or not isinstance(session_id, str)
            or not TRANSACTION_ID_RE.fullmatch(session_id)
            or not isinstance(payload["create"], bool)
        ):
            raise SidecarIOError("bind-session 参数无效")
        session_name = _require_name(payload["sessionName"])
        try:
            registry = self._validate_registry(
                json.loads(_read_fd_file(self.root_fd, "sessions.json"))
            )
        except FileNotFoundError as error:
            raise SidecarIOError("bind-session 缺少 registry") from error
        entry = registry["sessions"].get(session_id)
        deck_real_path = str(Path(self.project_identity["realPath"]) / deck_name)
        expected_prefix = f"{Path(deck_name).stem}-"
        suffix = session_name.removeprefix(expected_prefix)
        legacy_name_invalid = registry["version"] == 1 and (
            not session_name.startswith(expected_prefix)
            or not re.fullmatch(r"[a-f0-9]{8}", suffix)
        )
        if (
            entry is None
            or entry["sessionName"] != session_name
            or legacy_name_invalid
            or not _registry_entry_matches_deck(entry, deck_name, deck_real_path)
            or entry["status"] not in {"preparing", "active"}
            or (
                payload["create"]
                and not (entry["status"] == "preparing" and entry["mode"] == "fresh")
            )
        ):
            raise SidecarIOError("bind-session 未绑定 registry 中的当前 sessionId")

        for name in (
            "attachment_staging_fd", "attachments_fd", "write_errors_fd",
            "working_versions_fd", "working_fd", "transactions_fd", "backups_fd",
            "snapshots_fd", "session_fd",
        ):
            fd = getattr(self, name)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)
        self.session_fd = _open_child_directory(
            self.root_fd, session_name, create=payload["create"]
        )
        try:
            self.snapshots_fd = _open_child_directory(
                self.session_fd, "snapshots", create=payload["create"]
            )
            self.backups_fd = _open_child_directory(
                self.session_fd, "backups", create=payload["create"]
            )
            self.transactions_fd = _open_child_directory(
                self.session_fd, "transactions", create=payload["create"]
            )
            self.write_errors_fd = _open_child_directory(
                self.session_fd, "write-errors", create=payload["create"]
            )
            # working copy 是新能力；恢复历史 session 时也允许在已绑定 session
            # 内创建这个受控子目录，不改变真实 Deck。
            self.working_fd = _open_child_directory(
                self.session_fd, "working", create=True
            )
            self.working_versions_fd = _open_child_directory(
                self.working_fd, "versions", create=True
            )
        except Exception:
            for name in (
                "attachment_staging_fd", "attachments_fd", "write_errors_fd",
                "working_versions_fd", "working_fd", "transactions_fd", "backups_fd",
                "snapshots_fd", "session_fd",
            ):
                fd = getattr(self, name)
                if fd is not None:
                    os.close(fd)
                    setattr(self, name, None)
            raise
        self.deck_name = deck_name
        self.session_id = session_id
        self.session_name = session_name
        identities = {}
        for key, fd, child in (
            ("session", self.session_fd, session_name),
            ("snapshots", self.snapshots_fd, f"{session_name}/snapshots"),
            ("backups", self.backups_fd, f"{session_name}/backups"),
            ("transactions", self.transactions_fd, f"{session_name}/transactions"),
            ("writeErrors", self.write_errors_fd, f"{session_name}/write-errors"),
            ("working", self.working_fd, f"{session_name}/working"),
            (
                "workingVersions", self.working_versions_fd,
                f"{session_name}/working/versions",
            ),
        ):
            identities[key] = self._identity_for_fd(
                fd,
                str(Path(self.root_identity["path"]) / child),
                str(Path(self.root_identity["realPath"]) / child),
            )
        return {"sessionName": session_name, "identities": identities}

    def _attachment_identities(self, attachments_fd, staging_fd):
        identities = {}
        for key, fd, child in (
            ("attachments", attachments_fd, f"{self.session_name}/attachments"),
            (
                "attachmentStaging", staging_fd,
                f"{self.session_name}/attachments/.staging",
            ),
        ):
            identities[key] = self._identity_for_fd(
                fd,
                str(Path(self.root_identity["path"]) / child),
                str(Path(self.root_identity["realPath"]) / child),
            )
        return {"identities": identities}

    def bind_attachments(self, payload):
        if payload != {}:
            raise SidecarIOError("bind-attachments payload 格式无效")
        self._require_bound_session()
        self._assert_bound_directories(include_attachments=False)
        existing = (
            self.attachments_fd is not None,
            self.attachment_staging_fd is not None,
        )
        if any(existing):
            if not all(existing):
                raise SidecarIOError("可信 attachments 绑定状态不完整")
            self._assert_bound_directories(include_attachments=True)
            with _attachment_lifecycle_lock(self.attachments_fd):
                self._assert_bound_directories(include_attachments=True)
            return self._attachment_identities(
                self.attachments_fd, self.attachment_staging_fd
            )

        attachments_fd = None
        staging_fd = None
        try:
            attachments_fd = _open_child_directory(
                self.session_fd, "attachments", create=True
            )
            # 任务 5 writer 必须打开同一 attachments identity 并持有同一 flock。
            with _attachment_lifecycle_lock(attachments_fd):
                staging_fd = _open_child_directory(
                    attachments_fd, ".staging", create=True
                )
                if (
                    not self._same_directory_entry(
                        self.session_fd, "attachments", attachments_fd
                    )
                    or not self._same_directory_entry(
                        attachments_fd, ".staging", staging_fd
                    )
                ):
                    raise SidecarIOError("attachments identity 在绑定期间变化")
                binding = self._attachment_identities(attachments_fd, staging_fd)
        except Exception:
            for fd in (staging_fd, attachments_fd):
                if fd is not None:
                    os.close(fd)
            raise
        self.attachments_fd = attachments_fd
        self.attachment_staging_fd = staging_fd
        return binding

    def read_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"missingOk"}:
            raise SidecarIOError("read-session payload 格式无效")
        self._require_bound_session()
        try:
            return _decode_json_file(
                self.session_fd, "session.json", max_bytes=MAX_SESSION_BYTES
            )
        except FileNotFoundError:
            if payload["missingOk"] is True:
                return None
            raise

    def read_agent_workspace(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"missingOk"}:
            raise SidecarIOError("read-agent-workspace payload 格式无效")
        if not isinstance(payload["missingOk"], bool):
            raise SidecarIOError("read-agent-workspace missingOk 必须是布尔值")
        self._require_bound_session()
        try:
            return _decode_json_file(
                self.session_fd,
                "agent-workspace.json",
                max_bytes=MAX_AGENT_WORKSPACE_BYTES,
            )
        except FileNotFoundError:
            if payload["missingOk"]:
                return None
            raise
        except SidecarIOError as error:
            if error.code == "SIDECAR_SESSION_TOO_LARGE":
                raise SidecarIOError(
                    str(error),
                    code="SIDECAR_AGENT_WORKSPACE_TOO_LARGE",
                    status_code=413,
                ) from error
            raise

    def _archive_working_bytes(self, contents):
        fingerprint = hashlib.sha256(contents).hexdigest()
        name = f"{fingerprint}.html"
        try:
            existing = _read_fd_file(
                self.working_versions_fd, name, max_bytes=MAX_WORKING_DECK_BYTES
            )
            if existing != contents:
                raise SidecarIOError("working version 指纹碰撞或内容损坏")
        except FileNotFoundError:
            _atomic_write_fd(
                self.working_versions_fd, name, contents,
                commit_scope="working-deck",
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
        self._require_bound_session()
        self._assert_bound_directories(include_attachments=False)
        try:
            contents = _read_fd_file(
                self.working_versions_fd if version else self.working_fd, f"{version}.html" if version else "deck.html", max_bytes=MAX_WORKING_DECK_BYTES
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
        required = {"sessionId", "bytes", "expectedFingerprint"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("write-working-deck payload 格式无效")
        self._require_bound_session()
        if payload["sessionId"] != self.session_id:
            raise SidecarIOError("write-working-deck sessionId 不一致")
        expected = payload["expectedFingerprint"]
        if expected is not None and (
            not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected)
        ):
            raise SidecarIOError("working Deck expectedFingerprint 无效")
        try:
            current = _read_fd_file(
                self.working_fd, "deck.html", max_bytes=MAX_WORKING_DECK_BYTES
            )
        except FileNotFoundError:
            current = None
        if current is None:
            if expected is not None:
                raise SidecarIOError(
                    "working Deck 不存在，无法匹配 expectedFingerprint",
                    code="WORKING_DECK_CHANGED", status_code=409,
                )
        else:
            current_fingerprint = hashlib.sha256(current).hexdigest()
            if expected != current_fingerprint:
                raise SidecarIOError(
                    "working Deck 指纹已变化，拒绝覆盖",
                    code="WORKING_DECK_CHANGED", status_code=409,
                )
            self._archive_working_bytes(current)
        contents = _decode_bytes(payload["bytes"], max_bytes=MAX_WORKING_DECK_BYTES)
        result = _atomic_write_fd(
            self.working_fd, "deck.html", contents, commit_scope="working-deck"
        )
        fingerprint = self._archive_working_bytes(contents)
        return {**result, "fingerprint": fingerprint}

    def archive_working_deck(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"expectedFingerprint"}:
            raise SidecarIOError("archive-working-deck payload 格式无效")
        expected = payload["expectedFingerprint"]
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise SidecarIOError("archive-working-deck fingerprint 无效")
        contents = _read_fd_file(
            self.working_fd, "deck.html", max_bytes=MAX_WORKING_DECK_BYTES
        )
        actual = hashlib.sha256(contents).hexdigest()
        if actual != expected:
            raise SidecarIOError(
                "working Deck 在归档前再次变化",
                code="WORKING_DECK_CHANGED", status_code=409,
            )
        self._archive_working_bytes(contents)
        return {"fingerprint": actual}

    def restore_working_deck(self, payload):
        required = {"fingerprint", "expectedFingerprint"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("restore-working-deck payload 格式无效")
        target = payload["fingerprint"]
        expected = payload["expectedFingerprint"]
        if not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
                   for value in (target, expected)):
            raise SidecarIOError("restore-working-deck fingerprint 无效")
        current = _read_fd_file(
            self.working_fd, "deck.html", max_bytes=MAX_WORKING_DECK_BYTES
        )
        actual = hashlib.sha256(current).hexdigest()
        if actual != expected:
            raise SidecarIOError(
                "working Deck 在恢复前再次变化",
                code="WORKING_DECK_CHANGED", status_code=409,
            )
        contents = _read_fd_file(
            self.working_versions_fd, f"{target}.html",
            max_bytes=MAX_WORKING_DECK_BYTES,
        )
        if hashlib.sha256(contents).hexdigest() != target:
            raise SidecarIOError("working version 内容损坏")
        self._archive_working_bytes(current)
        _atomic_write_fd(
            self.working_fd, "deck.html", contents, commit_scope="working-deck"
        )
        return {"fingerprint": target}

    def publish_working_deck(self, payload):
        required = {
            "sessionId", "transactionId", "expectedDeckFingerprint",
            "expectedWorkingFingerprint",
        }
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("publish-working-deck payload 格式无效")
        if payload["sessionId"] != self.session_id:
            raise SidecarIOError("publish-working-deck sessionId 不一致")
        transaction_id = _require_uuid(payload["transactionId"], "transactionId")
        expected_deck = payload["expectedDeckFingerprint"]
        expected_working = payload["expectedWorkingFingerprint"]
        if not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
                   for value in (expected_deck, expected_working)):
            raise SidecarIOError("publish-working-deck fingerprint 无效")
        self._assert_bound_directories(include_attachments=False)
        original = _read_fd_file(self.project_fd, self.deck_name)
        actual_deck = hashlib.sha256(original).hexdigest()
        if actual_deck != expected_deck:
            raise SidecarIOError(
                "真实 Deck 已被外部修改，拒绝固化",
                code="DECK_CHANGED", status_code=409,
            )
        candidate = _read_fd_file(
            self.working_fd, "deck.html", max_bytes=MAX_WORKING_DECK_BYTES
        )
        candidate_fingerprint = hashlib.sha256(candidate).hexdigest()
        if candidate_fingerprint != expected_working:
            raise SidecarIOError(
                "working Deck 已变化，拒绝固化",
                code="WORKING_DECK_CHANGED", status_code=409,
            )
        backup_name = f"{Path(self.deck_name).stem}-{actual_deck}.html"
        try:
            existing = _read_fd_file(self.backups_fd, backup_name)
            if existing != original:
                raise SidecarIOError("真实 Deck 的既有备份已损坏")
        except FileNotFoundError:
            _atomic_write_fd(
                self.backups_fd, backup_name, original, commit_scope="deck-publish"
            )
        candidate_name = f".{self.deck_name}.{uuid.uuid4().hex}.tmp"
        transaction_name = f"{transaction_id}.json"
        transaction_path = str(
            Path(self.root_identity["path"]) / self.session_name
            / "transactions" / transaction_name
        )
        backup_path = str(
            Path(self.root_identity["path"]) / self.session_name
            / "backups" / backup_name
        )
        deck_path = str(Path(self.project_identity["path"]) / self.deck_name)
        session_path = str(Path(self.root_identity["path"]) / self.session_name)
        record = {
            "version": 1,
            "transactionId": transaction_id,
            "sessionId": self.session_id,
            "deckPath": deck_path,
            "sessionDir": session_path,
            "oldFingerprint": actual_deck,
            "candidateFingerprint": candidate_fingerprint,
            "backup": backup_path,
        }
        transaction_written = False
        exchanged = False
        published = False
        try:
            _atomic_write_fd(
                self.project_fd, candidate_name, candidate, commit_scope="deck-publish"
            )
            _atomic_write_fd(
                self.transactions_fd,
                transaction_name,
                json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                commit_scope="deck-publish",
            )
            transaction_written = True
            if hashlib.sha256(_read_fd_file(self.project_fd, self.deck_name)).hexdigest() \
                    != actual_deck:
                raise SidecarIOError(
                    "真实 Deck 在固化发布前再次变化",
                    code="DECK_CHANGED", status_code=409,
                )
            try:
                _exchange_file_entries(self.project_fd, candidate_name, self.deck_name)
            except (FileNotFoundError, OSError) as error:
                raise SidecarIOError(
                    "真实 Deck 在固化交换前已移动或变化，拒绝重新创建旧路径",
                    code="DECK_CHANGED", status_code=409,
                ) from error
            exchanged = True
            exchanged_original = _read_fd_file(self.project_fd, candidate_name)
            exchanged_candidate = _read_fd_file(self.project_fd, self.deck_name)
            if (
                hashlib.sha256(exchanged_original).hexdigest() != actual_deck
                or hashlib.sha256(exchanged_candidate).hexdigest() != candidate_fingerprint
            ):
                raise SidecarIOError(
                    "真实 Deck 在原子交换期间发生身份变化，拒绝固化",
                    code="DECK_CHANGED", status_code=409,
                )
            os.fsync(self.project_fd)
            os.unlink(candidate_name, dir_fd=self.project_fd)
            exchanged = False
            os.fsync(self.project_fd)
            published = True
            return {
                "ok": True,
                "fingerprint": candidate_fingerprint,
                "backup": backup_path,
                "transaction": transaction_path,
            }
        except Exception as error:
            if getattr(error, "committed", False):
                exchanged = True
            if exchanged:
                try:
                    current = _read_fd_file(self.project_fd, self.deck_name)
                    held = _read_fd_file(self.project_fd, candidate_name)
                    if (
                        hashlib.sha256(current).hexdigest() == candidate_fingerprint
                        and hashlib.sha256(held).hexdigest() == actual_deck
                    ):
                        _exchange_file_entries(
                            self.project_fd, candidate_name, self.deck_name
                        )
                        exchanged = False
                        os.fsync(self.project_fd)
                except Exception:
                    # 无法证明仍是本事务的两个版本时，保留 record 交给重启恢复。
                    pass
            if transaction_written and not exchanged:
                self._unlink_bound(self.transactions_fd, transaction_name)
                transaction_written = False
            raise
        finally:
            if not published and not exchanged:
                try:
                    os.unlink(candidate_name, dir_fd=self.project_fd)
                except FileNotFoundError:
                    pass

    @staticmethod
    def _same_directory_entry(parent_fd, name, expected_fd):
        current_fd = _open_child_directory(parent_fd, name, create=False)
        try:
            current = os.fstat(current_fd)
            held = os.fstat(expected_fd)
            return (
                stat.S_ISDIR(current.st_mode)
                and current.st_dev == held.st_dev
                and current.st_ino == held.st_ino
                and _mount_identity(current_fd) == _mount_identity(expected_fd)
            )
        finally:
            os.close(current_fd)

    def _assert_bound_directories(self, *, include_attachments):
        checks = [
            (self.project_fd, self.root_name, self.root_fd),
            (self.root_fd, self.session_name, self.session_fd),
            (self.session_fd, "snapshots", self.snapshots_fd),
            (self.session_fd, "backups", self.backups_fd),
            (self.session_fd, "transactions", self.transactions_fd),
            (self.session_fd, "write-errors", self.write_errors_fd),
            (self.session_fd, "working", self.working_fd),
            (self.working_fd, "versions", self.working_versions_fd),
        ]
        if include_attachments:
            if self.attachments_fd is None or self.attachment_staging_fd is None:
                raise SidecarIOError("尚未绑定可信 attachments")
            checks.extend((
                (self.session_fd, "attachments", self.attachments_fd),
                (self.attachments_fd, ".staging", self.attachment_staging_fd),
            ))
        try:
            if not all(self._same_directory_entry(*check) for check in checks):
                raise SidecarIOError("sidecar 目录身份已变化")
        except OSError as error:
            raise SidecarIOError("sidecar 目录身份已变化") from error

    def assert_bound(self, payload):
        if payload != {}:
            raise SidecarIOError("assert-bound payload 格式无效")
        self._require_bound_session()
        self._assert_bound_directories(
            include_attachments=self.attachments_fd is not None
            or self.attachment_staging_fd is not None
        )
        return {"safe": True}

    @_with_attachment_lifecycle_lock
    def publish_attachments(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"uploadId", "taskId", "files"}:
            raise SidecarIOError("publish-attachments payload 格式无效")
        self.assert_bound({})
        upload_id = _require_uuid(payload["uploadId"], "uploadId")
        task_id = _require_uuid(payload["taskId"], "taskId")
        files = _validate_publish_files(payload["files"])
        upload_fd = None
        opened = {}
        renamed = False
        try:
            upload_fd = _open_managed_attachment_directory(
                self.attachment_staging_fd, upload_id
            )
            _, opened = _scan_attachment_files(
                upload_fd, expected=files, keep_open=True
            )
            if not self._same_directory_entry(
                self.attachment_staging_fd, upload_id, upload_fd
            ):
                raise SidecarIOError("staging upload identity 已变化")
            for record in opened.values():
                os.fsync(record["fd"])
            os.fsync(upload_fd)
            _rename_directory_no_replace(
                self.attachment_staging_fd, upload_id,
                self.attachments_fd, task_id,
            )
            renamed = True
            if not self._same_directory_entry(self.attachments_fd, task_id, upload_fd):
                raise SidecarIOError("原子发布后的 task 附件目录 identity 不一致")
            _verify_open_attachment_files(upload_fd, opened)
            _fsync_attachment_publish_parents(
                self.attachment_staging_fd, self.attachments_fd
            )
            return [{
                "id": item["id"],
                "relativePath": f"attachments/{task_id}/{item['id']}{item['suffix']}",
                "size": item["size"],
            } for item in files]
        except SidecarIOError as error:
            if renamed and not error.committed:
                raise SidecarIOError(
                    str(error), stage="attachment-publish", committed=True,
                    commit_scope="attachments", code=error.code,
                ) from error
            raise
        except OSError as error:
            message = (
                "task 附件目录已存在，拒绝覆盖"
                if error.errno in {errno.EEXIST, errno.ENOTEMPTY}
                else f"附件目录发布失败：{error}"
            )
            raise SidecarIOError(
                message,
                stage=("attachment-directory-fsync" if renamed else "attachment-publish"),
                committed=renamed,
                commit_scope="attachments" if renamed else None,
                code="ATTACHMENT_PUBLISH_FAILED" if renamed else "UNSAFE_SIDECAR_IO",
            ) from error
        finally:
            for record in opened.values():
                os.close(record["fd"])
            if upload_fd is not None:
                os.close(upload_fd)

    @_with_attachment_lifecycle_lock
    def discard_attachment_upload(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "uploadId", "uploadIdentity", "files"
        }:
            raise SidecarIOError("discard-attachment-upload payload 格式无效")
        self.assert_bound({})
        upload_id = _require_uuid(payload["uploadId"], "uploadId")
        upload_identity = _validate_attachment_object_identity(
            payload["uploadIdentity"], "upload"
        )
        files = _validate_discard_files(payload["files"])
        record = _capture_managed_attachment_directory(
            self.attachment_staging_fd, upload_id
        )
        if record is None:
            return {"removed": False}
        try:
            os.fsync(self.attachment_staging_fd)
            _verify_managed_attachment_record(self.attachment_staging_fd, record)
            _verify_trusted_discard_record(record, upload_identity, files)
            return _remove_preflighted_attachment_directory(
                self.attachment_staging_fd, record
            )
        finally:
            _close_managed_attachment_record(record)

    @_with_attachment_lifecycle_lock
    def delete_task_attachments(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"taskId"}:
            raise SidecarIOError("delete-task-attachments payload 格式无效")
        self.assert_bound({})
        return _remove_managed_attachment_directory(
            self.attachments_fd,
            _require_uuid(payload["taskId"], "taskId"),
        )

    @_with_attachment_lifecycle_lock
    def verify_task_attachments(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"taskId", "files"}:
            raise SidecarIOError("verify-task-attachments payload 格式无效")
        self.assert_bound({})
        task_id = _require_uuid(payload["taskId"], "taskId")
        files = _validate_verify_files(task_id, payload["files"])
        if not files:
            return {"safe": True}
        return _verify_task_attachment_directory(self.attachments_fd, task_id, files)

    @staticmethod
    def _preflight_managed_directories(parent_fd):
        records = []
        try:
            for name in sorted(os.listdir(parent_fd)):
                _require_uuid(name)
                record = _capture_managed_attachment_directory(parent_fd, name)
                if record is None:
                    raise SidecarIOError("附件目录在预检期间消失")
                records.append(record)
            return records
        except Exception:
            for record in records:
                _close_managed_attachment_record(record)
            raise

    @_with_attachment_lifecycle_lock
    def reconcile_attachments(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"referencedTaskIds"}:
            raise SidecarIOError("reconcile-attachments payload 格式无效")
        self.assert_bound({})
        referenced = payload["referencedTaskIds"]
        if not isinstance(referenced, list):
            raise SidecarIOError("referencedTaskIds 必须是 UUID 数组")
        normalized = [_require_uuid(value, "referencedTaskId") for value in referenced]
        if len(set(normalized)) != len(normalized):
            raise SidecarIOError("referencedTaskIds 不得重复")
        referenced_ids = set(normalized)

        # 先完整预检两棵受控树；发现未知条目时不先删除任何合法目录。
        attachment_entries = set(os.listdir(self.attachments_fd))
        if ".staging" not in attachment_entries:
            raise SidecarIOError("attachments 缺少已绑定 staging 目录")
        if not self._same_directory_entry(
            self.attachments_fd, ".staging", self.attachment_staging_fd
        ):
            raise SidecarIOError("attachment staging identity 已变化")
        task_records = []
        upload_records = []
        discarded = 0
        deleted = 0
        failed_target = None
        failed_operation = None
        try:
            for name in sorted(attachment_entries - {".staging"}):
                _require_uuid(name, "task attachment directory")
                record = _capture_managed_attachment_directory(self.attachments_fd, name)
                if record is None:
                    raise SidecarIOError("task 附件目录在预检期间消失")
                task_records.append(record)
            upload_records = self._preflight_managed_directories(
                self.attachment_staging_fd
            )

            # 在任何破坏前持久化观察点并整体复核；测试可在此之前注入竞态。
            os.fsync(self.attachments_fd)
            expected_attachment_entries = {".staging"} | {
                record["name"] for record in task_records
            }
            if set(os.listdir(self.attachments_fd)) != expected_attachment_entries:
                raise SidecarIOError("attachments 根在完整预检后变化")
            if set(os.listdir(self.attachment_staging_fd)) != {
                record["name"] for record in upload_records
            }:
                raise SidecarIOError("staging 根在完整预检后变化")
            for record in task_records:
                _verify_managed_attachment_record(self.attachments_fd, record)
            for record in upload_records:
                _verify_managed_attachment_record(
                    self.attachment_staging_fd, record
                )

            for record in upload_records:
                failed_target = record["name"]
                failed_operation = "discard-upload"
                _remove_preflighted_attachment_directory(
                    self.attachment_staging_fd, record
                )
                discarded += 1
            for record in task_records:
                if record["name"] in referenced_ids:
                    continue
                failed_target = record["name"]
                failed_operation = "delete-task"
                _remove_preflighted_attachment_directory(
                    self.attachments_fd, record
                )
                deleted += 1
            return {"discardedUploads": discarded, "deletedTasks": deleted}
        except (SidecarIOError, OSError) as error:
            error_committed = (
                isinstance(error, SidecarIOError) and error.committed
            )
            if error_committed or discarded or deleted:
                raise SidecarIOError(
                    f"附件 reconcile 已部分提交：{error}",
                    stage="attachment-reconcile", committed=True,
                    commit_scope="attachments", code="ATTACHMENT_RECONCILE_FAILED",
                    details={
                        "discardedUploads": discarded,
                        "deletedTasks": deleted,
                        "failedTarget": failed_target,
                        "failedOperation": failed_operation,
                        "targetProgress": getattr(error, "details", None),
                    },
                ) from error
            raise
        finally:
            for record in [*upload_records, *task_records]:
                _close_managed_attachment_record(record)

    def read_transaction(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"transactionId"}:
            raise SidecarIOError("read-transaction payload 格式无效")
        self._require_bound_session()
        transaction_id = payload["transactionId"]
        if not isinstance(transaction_id, str) or not TRANSACTION_ID_RE.fullmatch(transaction_id):
            raise SidecarIOError("transactionId 不是规范 UUID v4")
        return _decode_json_file(self.transactions_fd, f"{transaction_id}.json")

    def list_transactions(self, payload):
        if payload != {}:
            raise SidecarIOError("list-transactions payload 格式无效")
        self._require_bound_session()
        transaction_ids = []
        for name in sorted(os.listdir(self.transactions_fd)):
            if not name.endswith(".json"):
                continue
            transaction_id = name[:-5]
            if not TRANSACTION_ID_RE.fullmatch(transaction_id):
                raise SidecarIOError("transactions 目录包含无效 record-like JSON")
            info = os.stat(name, dir_fd=self.transactions_fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise SidecarIOError("transaction record 必须是非符号链接的常规文件")
            transaction_ids.append(transaction_id)
        return transaction_ids

    def verify_backup(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "backupName", "expectedFingerprint"
        }:
            raise SidecarIOError("verify-backup payload 格式无效")
        self._require_bound_session()
        fingerprint = payload["expectedFingerprint"]
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise SidecarIOError("backup fingerprint 无效")
        expected_name = f"{Path(self.deck_name).stem}-{fingerprint}.html"
        if payload["backupName"] != expected_name:
            raise SidecarIOError("backup 名称未严格绑定 Deck 指纹")
        actual = hashlib.sha256(_read_fd_file(self.backups_fd, expected_name)).hexdigest()
        if actual != fingerprint:
            raise SidecarIOError("备份指纹与写回前基线不一致")
        return {"fingerprint": actual}

    def hash_deck(self, payload):
        if payload != {}:
            raise SidecarIOError("hash-deck payload 格式无效")
        if self.deck_name is None:
            raise SidecarIOError("尚未选择 Deck")
        return {
            "fingerprint": hashlib.sha256(
                _read_fd_file(self.project_fd, self.deck_name)
            ).hexdigest()
        }

    def write_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"sessionId", "bytes"}:
            raise SidecarIOError("write-session payload 格式无效")
        self._require_bound_session()
        session_id = payload["sessionId"]
        if not isinstance(session_id, str) or not TRANSACTION_ID_RE.fullmatch(session_id):
            raise SidecarIOError("write-session sessionId 无效")
        if session_id != self.session_id:
            raise SidecarIOError("write-session sessionId 与已绑定 registry 不一致")
        contents = _decode_bytes(payload["bytes"], max_bytes=MAX_SESSION_BYTES)
        try:
            state = json.loads(contents)
        except json.JSONDecodeError as error:
            raise SidecarIOError("write-session bytes 不是有效 JSON") from error
        if not isinstance(state, dict) or state.get("sessionId") != session_id:
            raise SidecarIOError("session.json 未绑定当前 sessionId")
        return _atomic_write_fd(
            self.session_fd, "session.json", contents, commit_scope="session"
        )

    def write_agent_workspace(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"sessionId", "bytes"}:
            raise SidecarIOError("write-agent-workspace payload 格式无效")
        self._require_bound_session()
        session_id = payload["sessionId"]
        if not isinstance(session_id, str) or not TRANSACTION_ID_RE.fullmatch(session_id):
            raise SidecarIOError("write-agent-workspace sessionId 无效")
        if session_id != self.session_id:
            raise SidecarIOError(
                "write-agent-workspace sessionId 与已绑定 registry 不一致"
            )

        try:
            contents = _decode_bytes(
                payload["bytes"], max_bytes=MAX_AGENT_WORKSPACE_BYTES
            )
        except SidecarIOError as error:
            if error.code == "SIDECAR_SESSION_TOO_LARGE":
                raise SidecarIOError(
                    str(error),
                    code="SIDECAR_AGENT_WORKSPACE_TOO_LARGE",
                    status_code=413,
                ) from error
            raise
        try:
            state = json.loads(contents)
        except json.JSONDecodeError as error:
            raise SidecarIOError(
                "write-agent-workspace bytes 不是有效 JSON"
            ) from error
        if (
            not isinstance(state, dict)
            or state.get("version") != 1
            or state.get("deckSessionId") != session_id
        ):
            raise SidecarIOError(
                "agent-workspace.json 未绑定当前 sessionId 或 schema version"
            )

        try:
            existing = os.stat(
                "agent-workspace.json",
                dir_fd=self.session_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise SidecarIOError(
                "agent-workspace.json 必须是非符号链接的常规文件"
            )
        return _atomic_write_fd(
            self.session_fd,
            "agent-workspace.json",
            contents,
            commit_scope="agent-workspace",
        )

    @staticmethod
    def _unlink_bound(directory_fd, name):
        name = _require_name(name)
        try:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            return {"removed": False}
        if not stat.S_ISREG(info.st_mode):
            raise SidecarIOError("拒绝删除非常规文件", stage="unlink")
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
        return {"removed": True}

    def write_snapshot(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"snapshotId", "bytes"}:
            raise SidecarIOError("write-snapshot payload 格式无效")
        self._require_bound_session()
        snapshot_id = payload["snapshotId"]
        if not isinstance(snapshot_id, str) or not TRANSACTION_ID_RE.fullmatch(snapshot_id):
            raise SidecarIOError("snapshotId 不是规范 UUID v4")
        return _atomic_write_fd(
            self.snapshots_fd,
            f"{snapshot_id}.png",
            _decode_bytes(payload["bytes"]),
            commit_scope="snapshot",
        )

    def delete_snapshot(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"snapshotId"}:
            raise SidecarIOError("delete-snapshot payload 格式无效")
        self._require_bound_session()
        snapshot_id = payload["snapshotId"]
        if not isinstance(snapshot_id, str) or not TRANSACTION_ID_RE.fullmatch(snapshot_id):
            raise SidecarIOError("snapshotId 不是规范 UUID v4")
        return self._unlink_bound(self.snapshots_fd, f"{snapshot_id}.png")

    def delete_transaction(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"transactionId"}:
            raise SidecarIOError("delete-transaction payload 格式无效")
        self._require_bound_session()
        transaction_id = payload["transactionId"]
        if not isinstance(transaction_id, str) or not TRANSACTION_ID_RE.fullmatch(transaction_id):
            raise SidecarIOError("transactionId 不是规范 UUID v4")
        return self._unlink_bound(self.transactions_fd, f"{transaction_id}.json")

    def prune_working_versions(self, payload):
        try:
            from working_version_gc import collect_working_versions
        except ModuleNotFoundError:
            from scripts.editor.working_version_gc import collect_working_versions
        self.assert_bound({})
        return collect_working_versions(
            payload, session_id=self.session_id, deck_name=self.deck_name, error_type=SidecarIOError,
            directories={"project": self.project_fd, "session": self.session_fd,
                         "working": self.working_fd, "versions": self.working_versions_fd,
                         "backups": self.backups_fd, "transactions": self.transactions_fd,
                         "writeErrors": self.write_errors_fd},
            list_names=os.listdir,
            file_stat=lambda fd, name: os.stat(_require_name(name), dir_fd=fd, follow_symlinks=False),
            read_file=lambda fd, name, maximum: _read_fd_file(fd, _require_name(name), max_bytes=maximum),
            unlink=self._unlink_bound, guard=lambda: self.assert_bound({}),
        )

    def prune_transactions(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"maximum"}:
            raise SidecarIOError("prune-transactions payload 格式无效")
        maximum = payload["maximum"]
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 0 <= maximum <= 256:
            raise SidecarIOError("prune-transactions maximum 无效")
        self._require_bound_session()
        candidates = []
        for name in os.listdir(self.transactions_fd):
            if not name.endswith(".json"):
                continue
            if not TRANSACTION_ID_RE.fullmatch(name[:-5]):
                raise SidecarIOError("transactions 目录包含无效 record-like JSON")
            info = os.stat(name, dir_fd=self.transactions_fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise SidecarIOError("transaction record 必须是常规文件")
            candidates.append((info.st_mtime_ns, name))
        candidates.sort(reverse=True)
        removed = 0
        for _, name in candidates[maximum:]:
            self._unlink_bound(self.transactions_fd, name)
            removed += 1
        return {"removed": removed}

    def restore_bound_deck(self, payload):
        required = {"backupName", "oldFingerprint", "candidateFingerprint"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("restore-deck payload 格式无效")
        self._require_bound_session()
        old_fingerprint = payload["oldFingerprint"]
        candidate_fingerprint = payload["candidateFingerprint"]
        if (
            not isinstance(old_fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", old_fingerprint)
            or not isinstance(candidate_fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", candidate_fingerprint)
            or payload["backupName"]
            != f"{Path(self.deck_name).stem}-{old_fingerprint}.html"
        ):
            raise SidecarIOError("restore-deck 参数未绑定 Deck/fingerprint")
        backup = _read_fd_file(self.backups_fd, payload["backupName"])
        if hashlib.sha256(backup).hexdigest() != old_fingerprint:
            raise SidecarIOError("备份指纹与写回前基线不一致", stage="restore")
        current = _read_fd_file(self.project_fd, self.deck_name)
        current_fingerprint = hashlib.sha256(current).hexdigest()
        if current_fingerprint == old_fingerprint:
            return {"restored": False, "fingerprint": old_fingerprint}
        if current_fingerprint != candidate_fingerprint:
            raise SidecarIOError(
                "Deck 已不再是本次 writer candidate，拒绝自动恢复覆盖",
                stage="restore-conflict",
            )
        temporary = f".{self.deck_name}.{uuid.uuid4()}.restore.tmp"
        renamed = False
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(temporary, flags, 0o600, dir_fd=self.project_fd)
            try:
                view = memoryview(backup)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            latest = hashlib.sha256(
                _read_fd_file(self.project_fd, self.deck_name)
            ).hexdigest()
            if latest != candidate_fingerprint:
                raise SidecarIOError(
                    "Deck 在自动恢复期间发生外部变化，拒绝覆盖",
                    stage="restore-conflict",
                )
            os.replace(
                temporary, self.deck_name,
                src_dir_fd=self.project_fd, dst_dir_fd=self.project_fd,
            )
            renamed = True
            os.fsync(self.project_fd)
            return {"restored": True, "fingerprint": old_fingerprint}
        finally:
            if not renamed:
                try:
                    os.unlink(temporary, dir_fd=self.project_fd)
                except FileNotFoundError:
                    pass

    def initialize(self, payload):
        if not isinstance(payload, dict) or set(payload) not in (
            {"project"}, {"project", "root"}
        ):
            raise SidecarIOError("initialize payload 格式无效")
        self.project_identity = _require_identity(payload["project"])
        self.project_fd = _open_directory(self.project_identity)
        if "root" in payload:
            self.root_identity = _require_identity(payload["root"])
            self.root_name = Path(self.root_identity["path"]).name
            if self.root_name not in {
                PROJECT_STATE_DIRECTORY, LEGACY_PROJECT_STATE_DIRECTORY,
            }:
                raise SidecarIOError("sidecar root 名称不受支持")
            self.root_fd = _open_directory(self.root_identity)
            _require_same_mount(self.project_fd, self.root_fd)
        else:
            root_name = resolve_project_state_root(
                Path(self.project_identity["path"])
            ).name
            try:
                os.mkdir(root_name, 0o700, dir_fd=self.project_fd)
                os.fsync(self.project_fd)
            except FileExistsError:
                pass
            self.root_fd = _open_child_directory(
                self.project_fd, root_name, create=False
            )
            self.root_identity = self._identity_for_fd(
                self.root_fd,
                str(Path(self.project_identity["path"]) / root_name),
                str(Path(self.project_identity["realPath"]) / root_name),
            )
            self.root_name = root_name
        self._acquire_session_lock()
        return {"ready": True, "root": self.root_identity}

    @staticmethod
    def _identity_for_fd(fd, path, real_path):
        info = os.fstat(fd)
        return {
            "path": path,
            "realPath": real_path,
            "dev": str(info.st_dev),
            "ino": str(info.st_ino),
        }

    def ensure_root(self, payload):
        if payload != {} or self.project_fd is None or self.root_fd is None:
            raise SidecarIOError("ensure-root 状态或 payload 无效")
        return {"created": False, "identity": self.root_identity}

    def discover(self, payload):
        if (
            self.root_fd is None
            or not isinstance(payload, dict)
            or set(payload) != {"deckName"}
        ):
            raise SidecarIOError("discover payload 格式无效")
        deck_name = _require_name(payload["deckName"])
        if not deck_name.endswith(".html"):
            raise SidecarIOError("discover deckName 无效")
        self.deck_name = deck_name
        registry = None
        try:
            registry = self._validate_registry(
                json.loads(_read_fd_file(self.root_fd, "sessions.json"))
            )
        except FileNotFoundError:
            pass
        if registry is None:
            return {"registry": None, "sessions": []}
        deck_real_path = str(Path(self.project_identity["realPath"]) / deck_name)
        sessions = []
        for session_id, entry in sorted(registry["sessions"].items()):
            if not _registry_entry_matches_deck(entry, deck_name, deck_real_path):
                continue
            try:
                info = os.stat(
                    entry["sessionName"], dir_fd=self.root_fd, follow_symlinks=False
                )
                kind = "directory" if stat.S_ISDIR(info.st_mode) else "unsafe"
            except FileNotFoundError:
                kind = "missing"
            sessions.append({**entry, "kind": kind})
        return {"registry": registry, "sessions": sessions}

    def inspect_legacy(self, payload):
        if (
            self.root_fd is None
            or not isinstance(payload, dict)
            or set(payload) != {"deckName", "currentFingerprint"}
        ):
            raise SidecarIOError("inspect-legacy payload 格式无效")
        deck_name = _require_name(payload["deckName"])
        fingerprint = payload["currentFingerprint"]
        if (
            not deck_name.endswith(".html")
            or not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
        ):
            raise SidecarIOError("inspect-legacy 参数无效")
        prefix = f"{Path(deck_name).stem}-"
        candidates = []
        for session_name in sorted(os.listdir(self.root_fd)):
            if not session_name.startswith(prefix):
                continue
            info = os.stat(session_name, dir_fd=self.root_fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                raise SidecarIOError("legacy session 候选必须是真实目录")
            session_fd = _open_child_directory(self.root_fd, session_name, create=False)
            transactions_fd = None
            try:
                transactions_fd = _open_child_directory(
                    session_fd, "transactions", create=False
                )
                transaction_ids = []
                for name in sorted(os.listdir(transactions_fd)):
                    if not name.endswith(".json"):
                        continue
                    transaction_id = name[:-5]
                    if not TRANSACTION_ID_RE.fullmatch(transaction_id):
                        raise SidecarIOError("legacy transaction 名称无效")
                    transaction_info = os.stat(
                        name, dir_fd=transactions_fd, follow_symlinks=False
                    )
                    if not stat.S_ISREG(transaction_info.st_mode):
                        raise SidecarIOError("legacy transaction 必须是常规文件")
                    transaction_ids.append(transaction_id)
                candidates.append({
                    "sessionName": session_name,
                    "expectedCurrentName": (
                        session_name == f"{Path(deck_name).stem}-{fingerprint[:8]}"
                    ),
                    "transactionIds": transaction_ids,
                    "sessionState": _decode_json_file(
                        session_fd, "session.json", max_bytes=MAX_SESSION_BYTES
                    ),
                })
            finally:
                if transactions_fd is not None:
                    os.close(transactions_fd)
                os.close(session_fd)
        return {"candidates": candidates}

    def _validate_registry(self, registry):
        if (
            not isinstance(registry, dict)
            or set(registry) != {"version", "sessions"}
            or registry["version"] not in {1, 2}
            or not isinstance(registry["sessions"], dict)
        ):
            raise SidecarIOError("sessions.json schema 无效")
        normalized = {"version": registry["version"], "sessions": {}}
        for session_id, entry in registry["sessions"].items():
            if (
                not isinstance(session_id, str)
                or not TRANSACTION_ID_RE.fullmatch(session_id)
                or not isinstance(entry, dict)
                or set(entry) != {
                    "sessionId", "deckRealPath", "initialFingerprint", "sessionName",
                    "mode", "status",
                }
                or entry.get("sessionId") != session_id
                or not isinstance(entry.get("deckRealPath"), str)
                or not isinstance(entry.get("initialFingerprint"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", entry["initialFingerprint"])
                or not isinstance(entry.get("sessionName"), str)
                or entry.get("mode") not in {"fresh", "legacy"}
                or entry.get("status") not in {"preparing", "active"}
            ):
                raise SidecarIOError("sessions.json session 记录无效")
            deck_name = _portable_basename(entry["deckRealPath"])
            expected_name = f"{Path(deck_name).stem}-{entry['initialFingerprint'][:8]}"
            if registry["version"] == 1 and entry["sessionName"] != expected_name:
                raise SidecarIOError("registry sessionName 未绑定 initialFingerprint")
            normalized["sessions"][session_id] = dict(entry)
        return normalized

    def prepare_session(self, payload):
        required = {
            "deckName", "sessionId", "initialFingerprint", "sessionName", "mode"
        }
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("prepare-session payload 格式无效")
        if self.root_fd is None:
            raise SidecarIOError("尚未绑定可信 sidecar root")
        deck_name = _require_name(payload["deckName"])
        session_id = payload["sessionId"]
        fingerprint = payload["initialFingerprint"]
        session_name = _require_name(payload["sessionName"])
        mode = payload["mode"]
        if (
            not deck_name.endswith(".html")
            or not isinstance(session_id, str)
            or not TRANSACTION_ID_RE.fullmatch(session_id)
            or not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
            or session_name != f"{Path(deck_name).stem}-{fingerprint[:8]}"
            or mode not in {"fresh", "legacy"}
        ):
            raise SidecarIOError("prepare-session 参数未严格绑定 Deck/session")
        try:
            registry = self._validate_registry(
                json.loads(_read_fd_file(self.root_fd, "sessions.json"))
            )
        except FileNotFoundError:
            registry = {"version": 1, "sessions": {}}
        deck_real_path = str(Path(self.project_identity["realPath"]) / deck_name)
        entry = {
            "sessionId": session_id,
            "deckRealPath": deck_real_path,
            "initialFingerprint": fingerprint,
            "sessionName": session_name,
            "mode": mode,
            "status": "preparing",
        }
        existing = registry["sessions"].get(session_id)
        if existing is not None and existing != entry:
            raise SidecarIOError("sessionId 已绑定其他 session")
        for other_id, other in registry["sessions"].items():
            if other_id != session_id and other["sessionName"] == session_name:
                raise SidecarIOError("session 目录已绑定其他 sessionId")
        registry["sessions"][session_id] = entry
        _atomic_write_fd(
            self.root_fd,
            "sessions.json",
            json.dumps(registry, ensure_ascii=False, indent=2).encode("utf-8"),
            commit_scope="registry",
        )
        return entry

    def rebind_deck(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"deckName", "expectedWitness"}:
            raise SidecarIOError("rebind-deck payload 格式无效")
        self._require_bound_session()
        deck_name = _require_name(payload["deckName"])
        witness = payload["expectedWitness"]
        if (
            not deck_name.lower().endswith((".html", ".htm"))
            or not isinstance(witness, dict)
            or set(witness) != {"dev", "ino"}
            or not all(isinstance(witness[key], str) for key in ("dev", "ino"))
        ):
            raise SidecarIOError("rebind-deck 参数无效")
        info = os.stat(deck_name, dir_fd=self.project_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(info.st_mode)
            or str(info.st_dev) != witness["dev"]
            or str(info.st_ino) != witness["ino"]
        ):
            raise SidecarIOError(
                "重新绑定候选的文件见证不一致",
                code="DECK_BINDING_WITNESS_MISMATCH", status_code=409,
            )
        registry = self._validate_registry(
            json.loads(_read_fd_file(self.root_fd, "sessions.json"))
        )
        entry = registry["sessions"].get(self.session_id)
        if entry is None or entry["sessionName"] != self.session_name:
            raise SidecarIOError("rebind-deck 未绑定当前 registry session")
        deck_real_path = str(Path(self.project_identity["realPath"]) / deck_name)
        registry = {"version": 2, "sessions": dict(registry["sessions"])}
        registry["sessions"][self.session_id] = {**entry, "deckRealPath": deck_real_path}
        _atomic_write_fd(
            self.root_fd,
            "sessions.json",
            json.dumps(registry, ensure_ascii=False, indent=2).encode("utf-8"),
            commit_scope="registry",
        )
        self.deck_name = deck_name
        return {"deckName": deck_name, "deckRealPath": deck_real_path}

    def activate_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"sessionId"}:
            raise SidecarIOError("activate-session payload 格式无效")
        self._require_bound_session()
        session_id = payload["sessionId"]
        if not isinstance(session_id, str) or not TRANSACTION_ID_RE.fullmatch(session_id):
            raise SidecarIOError("activate-session sessionId 无效")
        registry = self._validate_registry(
            json.loads(_read_fd_file(self.root_fd, "sessions.json"))
        )
        entry = registry["sessions"].get(session_id)
        if (
            entry is None
            or entry["sessionName"] != self.session_name
            or entry["status"] not in {"preparing", "active"}
        ):
            raise SidecarIOError("activate-session 未绑定当前 preparing session")
        state = _decode_json_file(self.session_fd, "session.json")
        if (
            not isinstance(state, dict)
            or state.get("sessionId") != session_id
            or _portable_basename(state.get("deckPath", ""))
            != _portable_basename(entry["deckRealPath"])
            or state.get("deckFingerprint") != entry["initialFingerprint"]
        ):
            raise SidecarIOError("session.json 未严格绑定 preparing registry")
        if entry["status"] == "active":
            return entry
        active = {**entry, "status": "active"}
        registry["sessions"][session_id] = active
        _atomic_write_fd(
            self.root_fd,
            "sessions.json",
            json.dumps(registry, ensure_ascii=False, indent=2).encode("utf-8"),
            commit_scope="registry",
        )
        return active

    def dispatch(self, request):
        if not isinstance(request, dict) or set(request) != {"id", "command", "payload"}:
            raise SidecarIOError("helper request schema 无效")
        command = request["command"]
        if command == "initialize":
            return self.initialize(request["payload"])
        if command == "ensure-root":
            return self.ensure_root(request["payload"])
        if command == "discover":
            return self.discover(request["payload"])
        if command == "inspect-legacy":
            return self.inspect_legacy(request["payload"])
        if command == "prepare-session":
            return self.prepare_session(request["payload"])
        if command == "activate-session":
            return self.activate_session(request["payload"])
        if command == "bind-session":
            return self.bind_session(request["payload"])
        if command == "bind-attachments":
            return self.bind_attachments(request["payload"])
        if command == "read-session":
            return self.read_session(request["payload"])
        if command == "read-agent-workspace":
            return self.read_agent_workspace(request["payload"])
        if command == "read-working-deck":
            return self.read_working_deck(request["payload"])
        if command == "assert-bound":
            return self.assert_bound(request["payload"])
        if command == "publish-attachments":
            return self.publish_attachments(request["payload"])
        if command == "discard-attachment-upload":
            return self.discard_attachment_upload(request["payload"])
        if command == "delete-task-attachments":
            return self.delete_task_attachments(request["payload"])
        if command == "verify-task-attachments":
            return self.verify_task_attachments(request["payload"])
        if command == "reconcile-attachments":
            return self.reconcile_attachments(request["payload"])
        if command == "read-transaction":
            return self.read_transaction(request["payload"])
        if command == "list-transactions":
            return self.list_transactions(request["payload"])
        if command == "verify-backup":
            return self.verify_backup(request["payload"])
        if command == "hash-deck":
            return self.hash_deck(request["payload"])
        if command == "rebind-deck":
            return self.rebind_deck(request["payload"])
        if command == "write-session":
            return self.write_session(request["payload"])
        if command == "write-agent-workspace":
            return self.write_agent_workspace(request["payload"])
        if command == "write-working-deck":
            return self.write_working_deck(request["payload"])
        if command == "archive-working-deck":
            return self.archive_working_deck(request["payload"])
        if command == "restore-working-deck":
            return self.restore_working_deck(request["payload"])
        if command == "publish-working-deck":
            return self.publish_working_deck(request["payload"])
        if command == "write-snapshot":
            return self.write_snapshot(request["payload"])
        if command == "delete-snapshot":
            return self.delete_snapshot(request["payload"])
        if command == "delete-transaction":
            return self.delete_transaction(request["payload"])
        if command == "prune-working-versions":
            return self.prune_working_versions(request["payload"])
        if command == "prune-transactions":
            return self.prune_transactions(request["payload"])
        if command == "restore-deck":
            return self.restore_bound_deck(request["payload"])
        if command == "close":
            if request["payload"] != {}:
                raise SidecarIOError("close payload 格式无效")
            return {"closed": True}
        raise SidecarIOError("未知 persistent helper command")


def serve():
    helper = PersistentHelper()
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_SESSION_REQUEST_BYTES + 1)
            if not line:
                return
            if len(line) > MAX_SESSION_REQUEST_BYTES or not line.endswith(b"\n"):
                raise SidecarIOError("helper 输入超过上限")
            request = None
            try:
                request = json.loads(line)
                command = request.get("command") if isinstance(request, dict) else None
                request_limit = (
                    MAX_SESSION_REQUEST_BYTES
                    if command in {"write-session", "write-working-deck"}
                    else MAX_AGENT_WORKSPACE_REQUEST_BYTES
                    if command == "write-agent-workspace"
                    else CONTROL_REQUEST_BYTES
                )
                if len(line) > request_limit:
                    raise SidecarIOError(
                        "helper 控制命令输入超过上限",
                        code="SIDECAR_HELPER_INPUT_LIMIT", status_code=413,
                    )
                result = helper.dispatch(request)
                response = {"id": request["id"], "ok": True, "result": result}
            except Exception as error:
                response = {
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False,
                    "message": str(error),
                    "code": getattr(error, "code", "UNSAFE_SIDECAR_IO"),
                    "statusCode": getattr(error, "status_code", 500),
                    "stage": getattr(error, "stage", "sidecar"),
                    "committed": bool(getattr(error, "committed", False)),
                    "commitScope": getattr(error, "commit_scope", None),
                    "details": getattr(error, "details", None),
                }
            encoded = (json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8")
            response_limit = (
                MAX_RESPONSE_BYTES
                if isinstance(request, dict)
                and request.get("command") in {"read-session", "read-working-deck"}
                else MAX_AGENT_WORKSPACE_RESPONSE_BYTES
                if isinstance(request, dict)
                and request.get("command") == "read-agent-workspace"
                else CONTROL_REQUEST_BYTES
            )
            if len(encoded) > response_limit:
                encoded = (json.dumps({
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False,
                    "message": "helper 输出超过命令上限",
                    "code": "SIDECAR_HELPER_OUTPUT_LIMIT",
                    "statusCode": 500,
                    "stage": "sidecar",
                    "committed": False,
                }, ensure_ascii=False) + "\n").encode("utf-8")
            sys.stdout.buffer.write(encoded)
            sys.stdout.buffer.flush()
            if isinstance(request, dict) and request.get("command") == "close":
                return
    finally:
        helper.close()


if __name__ == "__main__":
    if sys.argv[1:] != ["--serve"]:
        raise SystemExit("sidecar_io.py 只支持受控 --serve 模式")
    serve()
