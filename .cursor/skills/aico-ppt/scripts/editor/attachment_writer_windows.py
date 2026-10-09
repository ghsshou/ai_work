#!/usr/bin/env python3
"""Windows 可信路径后端的单附件 staging writer。"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys

from sidecar_io_windows import (
    SidecarIOError,
    _assert_directory,
    _capture_directory,
    _is_link_like,
    _same_path,
)

try:
    from attachment_writer_contract import (
        AttachmentWriterError,
        MAXIMUM_BYTES,
        READ_CHUNK_BYTES,
        unsafe_error as _unsafe,
        validate_config as _validate_shared_config,
    )
except ModuleNotFoundError:  # importlib 测试从仓库根目录直接加载本文件
    from scripts.editor.attachment_writer_contract import (
        AttachmentWriterError,
        MAXIMUM_BYTES,
        READ_CHUNK_BYTES,
        unsafe_error as _unsafe,
        validate_config as _validate_shared_config,
    )


def _validate_config(value):
    return _validate_shared_config(value, same_path=_same_path)


def _bound_directory(identity, label):
    try:
        current = _capture_directory(identity["path"])
    except (OSError, SidecarIOError) as error:
        raise _unsafe(f"无法安全打开 {label}：{error}", error) from error
    if current["dev"] != identity["dev"] or current["ino"] != identity["ino"]:
        raise _unsafe(f"{label} identity 与已绑定目录不一致")
    return current


def _trusted_identity(info):
    value = str(info.st_dev)
    return {
        "dev": value, "ino": str(info.st_ino),
        "mountDev": value, "mountId": value,
    }


def _same_file(path, expected):
    try:
        current = os.lstat(path)
    except OSError:
        return False
    return (
        stat.S_ISREG(current.st_mode)
        and not stat.S_ISLNK(current.st_mode)
        and (current.st_dev, current.st_ino) == expected
    )


def write_attachment(raw_config, *, input_stream=None):
    config = _validate_config(raw_config)
    input_stream = sys.stdin.buffer if input_stream is None else input_stream
    upload_path = os.path.join(config["attachmentStaging"]["path"], config["uploadId"])
    target_name = f"{config['attachmentId']}{config['suffix']}"
    target_path = os.path.join(upload_path, target_name)
    upload_created = False
    target_created = False
    target_identity = None
    active_error = None
    upload = None
    try:
        session = _bound_directory(config["session"], "session")
        attachments = _bound_directory(config["attachments"], "attachments")
        staging = _bound_directory(config["attachmentStaging"], "attachmentStaging")
        if attachments["dev"] != session["dev"] or staging["dev"] != attachments["dev"]:
            raise _unsafe("拒绝跨文件系统边界写入附件")
        try:
            os.mkdir(upload_path)
            upload_created = True
        except FileExistsError:
            pass
        upload = _capture_directory(upload_path)
        if upload["dev"] != staging["dev"]:
            raise _unsafe("拒绝跨文件系统边界创建 staging upload")
        _assert_directory(staging)

        digest = hashlib.sha256()
        size = 0
        try:
            with open(target_path, "xb") as target:
                target_created = True
                initial = os.fstat(target.fileno())
                target_identity = (initial.st_dev, initial.st_ino)
                if not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1:
                    raise _unsafe("附件目标必须是 link count 为 1 的常规文件")
                while True:
                    chunk = input_stream.read(READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > config["maximumBytes"]:
                        raise AttachmentWriterError(
                            "单个附件不得超过 25 MiB",
                            code="ATTACHMENT_TOO_LARGE", stage="attachment-limit",
                        )
                    digest.update(chunk)
                    target.write(chunk)
                if size == 0:
                    raise AttachmentWriterError(
                        "附件不能是空文件",
                        code="ATTACHMENT_EMPTY", stage="attachment-limit",
                    )
                target.flush()
                os.fsync(target.fileno())
                final = os.fstat(target.fileno())
                if (final.st_dev, final.st_ino) != target_identity \
                        or final.st_size != size or not stat.S_ISREG(final.st_mode):
                    raise _unsafe("附件文件 identity 或 size 在写入期间变化")
                file_identity = _trusted_identity(final)
        except FileExistsError as error:
            raise AttachmentWriterError(f"附件 staging 目标已存在：{error}") from error

        if not _same_file(target_path, target_identity):
            raise _unsafe("附件文件在写入完成前被替换")
        _assert_directory(session)
        _assert_directory(attachments)
        _assert_directory(staging)
        _assert_directory(upload)
        upload_identity = _trusted_identity(os.lstat(upload_path))
        target_created = False
        upload_created = False
        return {
            "ok": True,
            "uploadId": config["uploadId"],
            "attachmentId": config["attachmentId"],
            "suffix": config["suffix"],
            "path": target_path,
            "size": size,
            "sha256": digest.hexdigest(),
            "uploadIdentity": upload_identity,
            "fileIdentity": file_identity,
        }
    except AttachmentWriterError as error:
        active_error = error
        raise
    except (OSError, SidecarIOError) as error:
        wrapped = _unsafe(f"附件写入失败：{error}", error)
        active_error = wrapped
        raise wrapped from error
    finally:
        cleanup_safe = not target_created
        if target_created and target_identity is not None and _same_file(target_path, target_identity):
            try:
                os.unlink(target_path)
                cleanup_safe = True
            except OSError:
                cleanup_safe = False
        elif target_created:
            cleanup_safe = False
        if upload_created and upload is not None:
            try:
                _assert_directory(upload)
                if not os.listdir(upload_path):
                    os.rmdir(upload_path)
            except (OSError, SidecarIOError):
                cleanup_safe = False
        elif upload is not None:
            try:
                _assert_directory(upload)
            except SidecarIOError:
                cleanup_safe = False
        if active_error is not None:
            active_error.cleanup_safe = cleanup_safe


def _emit(value):
    encoded = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) != 2 or argv[0] != "--config":
            raise AttachmentWriterError(
                "用法：attachment_writer_windows.py --config <JSON>",
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
