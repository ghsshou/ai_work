#!/usr/bin/env python3
"""把 stdin 中的一个附件流写入已绑定 session 的可信 staging 目录。"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys

try:
    import fcntl
except ImportError:  # pragma: no cover - 当前生产平台为 macOS/Linux
    fcntl = None

try:
    from attachment_writer_contract import (
        AttachmentWriterError,
        MAXIMUM_BYTES,
        READ_CHUNK_BYTES,
        unsafe_error as _unsafe,
        validate_config as _validate_config,
    )
except ModuleNotFoundError:  # importlib 测试从仓库根目录直接加载本文件
    from scripts.editor.attachment_writer_contract import (
        AttachmentWriterError,
        MAXIMUM_BYTES,
        READ_CHUNK_BYTES,
        unsafe_error as _unsafe,
        validate_config as _validate_config,
    )
STATX_MNT_ID = 0x00001000
AT_EMPTY_PATH = 0x00001000
AT_STATX_DONT_SYNC = 0x00004000


def _linux_mount_id(fd):
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        statx_call = libc.statx
    except AttributeError as error:  # pragma: no cover - 现代 glibc 应提供
        raise _unsafe("Linux 缺少 statx，无法验证 mount identity", error)
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
        raise _unsafe(f"statx mount identity 失败：{os.strerror(error_number)}")
    mask = struct.unpack_from("=I", buffer.raw, 0)[0]
    if not mask & STATX_MNT_ID:
        raise _unsafe("statx 未返回 mount identity")
    return struct.unpack_from("=Q", buffer.raw, 144)[0]


def _mount_identity(fd):
    info = os.fstat(fd)
    if sys.platform == "darwin":
        mount_id = os.fstatvfs(fd).f_fsid
    elif sys.platform.startswith("linux"):
        mount_id = _linux_mount_id(fd)
    else:  # pragma: no cover - 当前生产平台为 macOS/Linux
        raise _unsafe("当前平台不支持可靠 mount identity")
    return (str(info.st_dev), str(mount_id))


def _require_same_mount(parent_fd, child_fd):
    if _mount_identity(parent_fd) != _mount_identity(child_fd):
        raise _unsafe("拒绝跨 mount 边界写入附件")


def _trusted_fd_identity(fd):
    info = os.fstat(fd)
    mount_dev, mount_id = _mount_identity(fd)
    return {
        "dev": str(info.st_dev),
        "ino": str(info.st_ino),
        "mountDev": mount_dev,
        "mountId": mount_id,
    }


def _directory_flags():
    return (
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    )


def _open_absolute_directory_nofollow(identity, label):
    """逐级打开绝对路径，拒绝任一祖先目录为符号链接。"""
    path = Path(identity["path"])
    fd = os.open(os.path.sep, _directory_flags())
    try:
        for component in path.parts[1:]:
            next_fd = os.open(component, _directory_flags(), dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if (
            not stat.S_ISDIR(info.st_mode)
            or str(info.st_dev) != identity["dev"]
            or str(info.st_ino) != identity["ino"]
        ):
            raise _unsafe(f"{label} identity 与已绑定目录不一致")
        return fd
    except AttachmentWriterError:
        os.close(fd)
        raise
    except OSError as error:
        os.close(fd)
        raise _unsafe(f"无法安全打开 {label}：{error}", error)


def _open_child_directory(parent_fd, name, identity=None, *, create=False):
    created = False
    created_identity = None
    fd = None
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            created = True
            created_info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(created_info.st_mode):
                raise _unsafe("新建附件 staging 路径不是目录")
            created_identity = (created_info.st_dev, created_info.st_ino)
        except FileExistsError:
            pass
        except OSError as error:
            raise _unsafe(f"无法创建附件 staging 目录：{error}", error)
    try:
        fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode):
            raise _unsafe("附件子路径不是常规目录")
        if created_identity is not None and (
            info.st_dev, info.st_ino
        ) != created_identity:
            raise _unsafe("新建附件 staging 目录在打开期间被替换")
        if identity is not None and (
            str(info.st_dev) != identity["dev"] or str(info.st_ino) != identity["ino"]
        ):
            raise _unsafe("附件子目录 identity 与已绑定目录不一致")
        _require_same_mount(parent_fd, fd)
        # mkdir 后先持有并记录新目录 identity，再持久化父目录项。这样后续
        # fsync 失败时只能按 held fd 的 identity 尝试清理本次创建的空目录。
        if created:
            _trusted_fd_identity(fd)
            os.fsync(parent_fd)
        return fd, created
    except Exception as error:
        if created:
            try:
                current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                identity_matches = (
                    stat.S_ISDIR(current.st_mode)
                    and created_identity is not None
                    and (current.st_dev, current.st_ino) == created_identity
                )
                if fd is not None:
                    identity_matches = identity_matches and _same_directory_entry(
                        parent_fd, name, fd
                    )
                if identity_matches:
                    os.rmdir(name, dir_fd=parent_fd)
                    try:
                        os.fsync(parent_fd)
                    except OSError:
                        pass
            except (OSError, AttachmentWriterError):
                pass
        if fd is not None:
            os.close(fd)
        if isinstance(error, AttachmentWriterError):
            raise
        if isinstance(error, OSError):
            raise _unsafe(f"无法安全打开附件子目录：{error}", error)
        raise


def _same_directory_entry(parent_fd, name, held_fd):
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        held = os.fstat(held_fd)
    except OSError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and current.st_dev == held.st_dev
        and current.st_ino == held.st_ino
        and _mount_identity(parent_fd) == _mount_identity(held_fd)
    )


def _same_file_entry(parent_fd, name, held_fd, expected_identity):
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        held = os.fstat(held_fd)
    except OSError:
        return False
    return (
        stat.S_ISREG(current.st_mode)
        and current.st_nlink == 1
        and (current.st_dev, current.st_ino) == expected_identity
        and (held.st_dev, held.st_ino) == expected_identity
        and _mount_identity(parent_fd) == _mount_identity(held_fd)
    )


def _same_file_identity(parent_fd, name, expected_identity):
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISREG(current.st_mode) and (
        current.st_dev, current.st_ino
    ) == expected_identity


def _acquire_lifecycle_lock(attachments_fd):
    if fcntl is None:
        raise AttachmentWriterError(
            "当前平台不支持附件生命周期锁",
            code="SIDECAR_LOCK_UNSUPPORTED", stage="attachment-lock",
        )
    try:
        fcntl.flock(attachments_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise AttachmentWriterError(
            "附件 writer 或生命周期命令正在运行",
            code="ATTACHMENT_BUSY", stage="attachment-lock",
        ) from error


def _write_all(fd, chunk):
    view = memoryview(chunk)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError(errno.EIO, "附件写入没有取得进展")
        view = view[written:]


def write_attachment(raw_config, *, input_fd=0):
    config = _validate_config(raw_config)
    session_fd = None
    attachments_fd = None
    staging_fd = None
    upload_fd = None
    target_fd = None
    lock_held = False
    upload_created = False
    target_created = False
    target_creation_attempted = False
    target_identity = None
    active_error = None
    target_name = f"{config['attachmentId']}{config['suffix']}"
    try:
        session_fd = _open_absolute_directory_nofollow(config["session"], "session")
        attachments_fd, _ = _open_child_directory(
            session_fd, "attachments", config["attachments"]
        )
        _acquire_lifecycle_lock(attachments_fd)
        lock_held = True
        staging_fd, _ = _open_child_directory(
            attachments_fd, ".staging", config["attachmentStaging"]
        )
        upload_fd, upload_created = _open_child_directory(
            staging_fd, config["uploadId"], create=True
        )
        flags = (
            os.O_WRONLY | os.O_CREAT | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        )
        try:
            target_creation_attempted = True
            target_fd = os.open(target_name, flags, 0o600, dir_fd=upload_fd)
            target_created = True
        except OSError as error:
            raise AttachmentWriterError(f"无法安全创建附件目标：{error}") from error
        target_info = os.fstat(target_fd)
        target_identity = (target_info.st_dev, target_info.st_ino)
        if not stat.S_ISREG(target_info.st_mode) or target_info.st_nlink != 1:
            raise _unsafe("附件目标必须是 link count 为 1 的常规文件")
        _require_same_mount(upload_fd, target_fd)

        digest = hashlib.sha256()
        size = 0
        while True:
            try:
                chunk = os.read(input_fd, READ_CHUNK_BYTES)
            except InterruptedError:
                continue
            except OSError as error:
                raise AttachmentWriterError(f"读取附件输入流失败：{error}") from error
            if not chunk:
                break
            size += len(chunk)
            if size > config["maximumBytes"]:
                raise AttachmentWriterError(
                    "单个附件不得超过 25 MiB",
                    code="ATTACHMENT_TOO_LARGE", stage="attachment-limit",
                )
            digest.update(chunk)
            _write_all(target_fd, chunk)
        if size == 0:
            raise AttachmentWriterError(
                "附件不能是空文件",
                code="ATTACHMENT_EMPTY", stage="attachment-limit",
            )

        os.fsync(target_fd)
        final_info = os.fstat(target_fd)
        if (
            not stat.S_ISREG(final_info.st_mode)
            or final_info.st_nlink != 1
            or final_info.st_size != size
        ):
            raise _unsafe("附件文件 identity 或 size 在写入期间变化")
        _require_same_mount(upload_fd, target_fd)
        os.fsync(upload_fd)
        if (
            not _same_directory_entry(session_fd, "attachments", attachments_fd)
            or not _same_directory_entry(attachments_fd, ".staging", staging_fd)
            or not _same_directory_entry(staging_fd, config["uploadId"], upload_fd)
            or not _same_file_entry(
                upload_fd, target_name, target_fd, target_identity
            )
        ):
            raise _unsafe("附件目录或文件 identity 在写入期间变化")
        current_session_fd = _open_absolute_directory_nofollow(
            config["session"], "session"
        )
        os.close(current_session_fd)
        upload_identity = _trusted_fd_identity(upload_fd)
        file_identity = _trusted_fd_identity(target_fd)
        os.close(target_fd)
        target_fd = None
        target_created = False
        upload_created = False
        return {
            "ok": True,
            "uploadId": config["uploadId"],
            "attachmentId": config["attachmentId"],
            "suffix": config["suffix"],
            "path": os.path.join(
                config["attachmentStaging"]["path"], config["uploadId"], target_name
            ),
            "size": size,
            "sha256": digest.hexdigest(),
            "uploadIdentity": upload_identity,
            "fileIdentity": file_identity,
        }
    except AttachmentWriterError as error:
        active_error = error
        raise
    except OSError as error:
        wrapped = AttachmentWriterError(f"附件写入失败：{error}")
        wrapped.__cause__ = error
        active_error = wrapped
        raise wrapped
    finally:
        if target_fd is not None:
            try:
                os.close(target_fd)
            except OSError:
                pass
        target_cleanup_safe = not target_creation_attempted
        if target_created and upload_fd is not None and target_identity is not None:
            if _same_file_identity(upload_fd, target_name, target_identity):
                try:
                    os.unlink(target_name, dir_fd=upload_fd)
                    os.fsync(upload_fd)
                    target_cleanup_safe = True
                except OSError:
                    target_cleanup_safe = False
            else:
                target_cleanup_safe = False
        elif target_creation_attempted:
            target_cleanup_safe = False
        upload_cleanup_safe = False
        if upload_created and upload_fd is not None and staging_fd is not None:
            try:
                if _same_directory_entry(
                    staging_fd, config["uploadId"], upload_fd
                ):
                    os.rmdir(config["uploadId"], dir_fd=staging_fd)
                    os.fsync(staging_fd)
                    upload_cleanup_safe = True
            except (OSError, AttachmentWriterError):
                upload_cleanup_safe = False
        elif upload_fd is not None and staging_fd is not None:
            try:
                upload_cleanup_safe = _same_directory_entry(
                    staging_fd, config["uploadId"], upload_fd
                )
            except AttachmentWriterError:
                upload_cleanup_safe = False
        if active_error is not None:
            active_error.cleanup_safe = target_cleanup_safe and upload_cleanup_safe
        for fd in (upload_fd, staging_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if lock_held and attachments_fd is not None:
            try:
                fcntl.flock(attachments_fd, fcntl.LOCK_UN)
            except OSError:
                pass
        for fd in (attachments_fd, session_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def _emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) != 2 or argv[0] != "--config":
            raise AttachmentWriterError(
                "用法：attachment_writer.py --config <JSON>",
                code="ATTACHMENT_CONFIG_INVALID", stage="attachment-config",
            )
        try:
            config = json.loads(argv[1])
        except (TypeError, json.JSONDecodeError) as error:
            raise AttachmentWriterError(
                "attachment writer config 不是有效 JSON",
                code="ATTACHMENT_CONFIG_INVALID", stage="attachment-config",
            ) from error
        _emit(write_attachment(config))
        return 0
    except AttachmentWriterError as error:
        _emit({
            "ok": False,
            "code": error.code,
            "stage": error.stage,
            "message": str(error),
            "committed": False,
            "cleanupSafe": error.cleanup_safe,
        })
        return 1
    except Exception:
        _emit({
            "ok": False,
            "code": "ATTACHMENT_WRITE_FAILED",
            "stage": "attachment-write",
            "message": "附件写入失败",
            "committed": False,
            "cleanupSafe": False,
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
