#!/usr/bin/env python3
"""POSIX 与 Windows 附件 writer 共用的协议校验。"""

from __future__ import annotations

import os
import re


MAXIMUM_BYTES = 25 * 1024 * 1024
READ_CHUNK_BYTES = 1024 * 1024
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
SUFFIX = re.compile(r"^\.[a-z0-9]{1,16}$")


class AttachmentWriterError(RuntimeError):
    def __init__(self, message, *, code="ATTACHMENT_WRITE_FAILED", stage="attachment-write"):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.cleanup_safe = False


def unsafe_error(message, error=None):
    raised = AttachmentWriterError(
        message, code="UNSAFE_SIDECAR_IO", stage="attachment-identity"
    )
    if error is not None:
        raised.__cause__ = error
    return raised


def validate_identity(value, label):
    if (
        not isinstance(value, dict)
        or set(value) != {"path", "dev", "ino"}
        or any(not isinstance(value.get(key), str) for key in ("path", "dev", "ino"))
    ):
        raise unsafe_error(f"{label} identity 格式无效")
    path = value["path"]
    if (
        not os.path.isabs(path)
        or path != os.path.normpath(path)
        or path in {"", os.path.sep}
    ):
        raise unsafe_error(f"{label} identity path 必须是规范绝对路径")
    return {"path": path, "dev": value["dev"], "ino": value["ino"]}


def validate_config(value, *, same_path=None):
    expected = {
        "session", "attachments", "attachmentStaging", "uploadId",
        "attachmentId", "suffix", "maximumBytes",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise AttachmentWriterError(
            "附件写入配置格式无效",
            code="ATTACHMENT_CONFIG_INVALID", stage="attachment-config",
        )
    config = {
        "session": validate_identity(value["session"], "session"),
        "attachments": validate_identity(value["attachments"], "attachments"),
        "attachmentStaging": validate_identity(
            value["attachmentStaging"], "attachmentStaging"
        ),
        "uploadId": value["uploadId"],
        "attachmentId": value["attachmentId"],
        "suffix": value["suffix"],
        "maximumBytes": value["maximumBytes"],
    }
    if not isinstance(config["uploadId"], str) or not UUID_V4.fullmatch(config["uploadId"]):
        raise AttachmentWriterError(
            "uploadId 不是规范小写 UUID v4",
            code="ATTACHMENT_CONFIG_INVALID", stage="attachment-config",
        )
    if (
        not isinstance(config["attachmentId"], str)
        or not UUID_V4.fullmatch(config["attachmentId"])
    ):
        raise AttachmentWriterError(
            "attachmentId 不是规范小写 UUID v4",
            code="ATTACHMENT_CONFIG_INVALID", stage="attachment-config",
        )
    if not isinstance(config["suffix"], str) or not SUFFIX.fullmatch(config["suffix"]):
        raise AttachmentWriterError(
            "附件扩展名无效",
            code="ATTACHMENT_CONFIG_INVALID", stage="attachment-config",
        )
    if (
        not isinstance(config["maximumBytes"], int)
        or isinstance(config["maximumBytes"], bool)
        or config["maximumBytes"] != MAXIMUM_BYTES
    ):
        raise AttachmentWriterError(
            "附件大小上限配置无效",
            code="ATTACHMENT_CONFIG_INVALID", stage="attachment-config",
        )
    paths_equal = same_path or (lambda left, right: left == right)
    expected_attachments = os.path.join(config["session"]["path"], "attachments")
    expected_staging = os.path.join(expected_attachments, ".staging")
    if (
        not paths_equal(config["attachments"]["path"], expected_attachments)
        or not paths_equal(config["attachmentStaging"]["path"], expected_staging)
    ):
        raise unsafe_error("附件目录路径未严格绑定 session identity")
    return config
