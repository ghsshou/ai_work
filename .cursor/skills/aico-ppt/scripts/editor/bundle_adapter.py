from pathlib import Path
import hashlib
import importlib.util
import json
import os
import stat
import tempfile
import uuid

try:
    from product_paths import resolve_project_state_root
except ModuleNotFoundError:
    from scripts.editor.product_paths import resolve_project_state_root


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("eb", ROOT / "scripts/edit-bundle.py")
eb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(eb)
PATCH_SPEC = importlib.util.spec_from_file_location(
    "aico_ppt_patch_bundle", ROOT / "scripts/editor/patch_bundle.py"
)
patch_bundle = importlib.util.module_from_spec(PATCH_SPEC)
PATCH_SPEC.loader.exec_module(patch_bundle)

BEGIN = patch_bundle.BEGIN
END = patch_bundle.END
_block = patch_bundle.build_block


def _absolute_path(path):
    return Path(os.path.abspath(os.fspath(path)))


def _ensure_plain_directory(path, parent=None):
    path = _absolute_path(path)
    try:
        path.mkdir(mode=0o700, parents=parent is None, exist_ok=False)
    except FileExistsError:
        pass
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"目录必须是非符号链接的真实目录：{path}")
    real_path = Path(os.path.realpath(path))
    if parent is not None:
        real_parent = Path(os.path.realpath(parent))
        if real_path.parent != real_parent:
            raise RuntimeError(f"目录不在当前会话边界内：{path}")
    return path


def _identity_for(path, label):
    path = _absolute_path(path)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"{label} 必须是非符号链接的真实目录：{path}")
    return {
        "path": str(path),
        "realPath": os.path.realpath(path),
        "dev": str(info.st_dev),
        "ino": str(info.st_ino),
    }


def _require_identity(identity, name, path):
    if not isinstance(identity, dict) or not isinstance(identity.get(name), dict):
        raise RuntimeError(f"缺少启动时 {name} identity")
    expected = identity[name]
    required = {"path", "realPath", "dev", "ino"}
    if set(expected) != required or any(
        not isinstance(expected[key], str) for key in required
    ):
        raise RuntimeError(f"{name} identity 格式无效")
    current = _identity_for(path, name)
    if current != expected:
        raise RuntimeError(f"{name} identity 已在服务运行期间变化")
    return expected


def _ensure_sidecar_session(deck_path, session_dir, sidecar_identity=None):
    project_dir = deck_path.parent
    project_info = project_dir.lstat()
    if stat.S_ISLNK(project_info.st_mode) or not stat.S_ISDIR(project_info.st_mode):
        raise RuntimeError(f"Deck 项目目录必须是非符号链接的真实目录：{project_dir}")
    sidecar_root = resolve_project_state_root(project_dir)
    if session_dir.parent != sidecar_root:
        raise RuntimeError(f"session 必须直属 Deck 项目的 sidecar root：{session_dir}")
    if sidecar_identity is not None:
        _require_identity(sidecar_identity, "root", sidecar_root)
        _require_identity(sidecar_identity, "session", session_dir)
        return session_dir
    sidecar_root = _ensure_plain_directory(sidecar_root, parent=project_dir)
    return _ensure_plain_directory(session_dir, parent=sidecar_root)


def _normalize_transaction_id(transaction_id):
    if transaction_id is None:
        return str(uuid.uuid4())
    try:
        normalized = str(uuid.UUID(str(transaction_id)))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("transaction_id 必须是规范 UUID") from error
    if normalized != transaction_id:
        raise ValueError("transaction_id 必须是小写规范 UUID")
    return normalized


def _open_directory_fd(path, expected_identity=None):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        os.close(fd)
        raise RuntimeError(f"目录句柄不是常规目录：{path}")
    if expected_identity is not None and (
        str(info.st_dev) != expected_identity["dev"]
        or str(info.st_ino) != expected_identity["ino"]
    ):
        os.close(fd)
        raise RuntimeError(f"目录句柄 identity 与启动时不一致：{path}")
    return fd


def _identity_entry(identity, name):
    if not isinstance(identity, dict) or not isinstance(identity.get(name), dict):
        raise RuntimeError(f"缺少启动时 {name} identity")
    expected = identity[name]
    required = {"path", "realPath", "dev", "ino"}
    if set(expected) != required or any(
        not isinstance(expected[key], str) for key in required
    ):
        raise RuntimeError(f"{name} identity 格式无效")
    return expected


def _unsafe_project_error(message, cause=None):
    error = RuntimeError(message if cause is None else f"{message}：{cause}")
    error.deck_code = "UNSAFE_SIDECAR"
    error.deck_stage = "open-project"
    return error


def _open_project_fd(deck_path, sidecar_identity):
    project = deck_path.parent
    expected = None
    if sidecar_identity is not None:
        try:
            expected = _identity_entry(sidecar_identity, "project")
            if expected["path"] != str(project):
                raise RuntimeError("project identity 路径与 Deck 项目目录不一致")
        except Exception as error:
            raise _unsafe_project_error("启动时项目 identity 无效", error) from error
    try:
        return _open_directory_fd(project, expected)
    except Exception as error:
        raise _unsafe_project_error("Deck 项目目录身份已在服务运行期间变化", error) from error


def _read_regular_file_fd(directory_fd, name, label):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError(f"{label} 必须是非符号链接的常规文件")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def _write_new_file_fd(directory_fd, name, contents):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)


def _write_new_file(directory, name, contents, expected_identity=None):
    directory_fd = _open_directory_fd(directory, expected_identity)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _read_regular_file(directory, name, expected_identity=None):
    directory_fd = _open_directory_fd(directory, expected_identity)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(name, flags, dir_fd=directory_fd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise RuntimeError(f"备份必须是非符号链接的常规文件：{directory / name}")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                return stream.read()
        finally:
            os.close(fd)
    finally:
        os.close(directory_fd)


def _unlink_regular_file(directory, name, expected_identity=None):
    directory_fd = _open_directory_fd(directory, expected_identity)
    try:
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError(f"拒绝删除非常规事务记录：{directory / name}")
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _ensure_backup(backups, name, original_bytes, digest, expected_identity=None):
    try:
        _write_new_file(backups, name, original_bytes, expected_identity)
    except FileExistsError:
        pass

    try:
        backup_bytes = _read_regular_file(backups, name, expected_identity)
    except OSError as error:
        raise RuntimeError(
            f"备份必须是非符号链接的常规文件：{backups / name}"
        ) from error
    backup_digest = hashlib.sha256(backup_bytes).hexdigest()
    if backup_digest != digest or backup_bytes != original_bytes:
        raise RuntimeError(f"已有备份内容不一致或已损坏，拒绝继续：{backups / name}")
    directory_fd = _open_directory_fd(backups, expected_identity)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def write_patches(
    deck_path,
    patches,
    session_dir,
    expected_fingerprint=None,
    transaction_id=None,
    sidecar_identity=None,
    session_id=None,
):
    deck_path = _absolute_path(deck_path)
    session_dir = _absolute_path(session_dir)
    phase = "open-project"
    project_fd = None
    candidate_name = None
    candidate_bytes = None
    transaction_written = False
    try:
        project_fd = _open_project_fd(deck_path, sidecar_identity)
        deck_name = deck_path.name
        if not deck_name or deck_name in {".", ".."}:
            raise _unsafe_project_error("Deck 文件名不是安全的单段名称")

        phase = "sidecar"
        try:
            session_dir = _ensure_sidecar_session(
                deck_path, session_dir, sidecar_identity
            )
        except Exception as error:
            if sidecar_identity is not None:
                raise _unsafe_project_error(
                    "sidecar identity 已在服务运行期间变化", error
                ) from error
            raise
        transaction_id = _normalize_transaction_id(transaction_id)
        session_id = (
            _normalize_transaction_id(session_id) if session_id is not None else None
        )
        if sidecar_identity is None:
            backups = _ensure_plain_directory(
                session_dir / "backups", parent=session_dir
            )
            backup_identity = _identity_for(backups, "backups")
        else:
            backups = session_dir / "backups"
            try:
                backup_identity = _require_identity(
                    sidecar_identity, "backups", backups
                )
            except Exception as error:
                raise _unsafe_project_error(
                    "backups identity 已在服务运行期间变化", error
                ) from error

        phase = "read"
        original_bytes = _read_regular_file_fd(project_fd, deck_name, "Deck")
        digest = hashlib.sha256(original_bytes).hexdigest()
        if expected_fingerprint is not None and digest != expected_fingerprint:
            error = RuntimeError("Deck 指纹与保存请求基线不一致，拒绝覆盖")
            error.deck_code = "DECK_CHANGED"
            raise error

        phase = "backup"
        backup_name = f"{deck_path.stem}-{digest}.html"
        backup = backups / backup_name
        _ensure_backup(
            backups, backup_name, original_bytes, digest, backup_identity
        )

        phase = "decode"
        # edit-bundle 仍是唯一 bundle 编辑器；它只接触可信 dirfd 读出的系统临时副本。
        with tempfile.TemporaryDirectory(prefix="aico-ppt-editor-") as work_dir:
            work_path = Path(work_dir) / deck_name
            work_path.write_bytes(original_bytes)
            lines = eb.load(work_path)
            template = eb.get_template(lines)
            template = patch_bundle.replace_block(template, patches)
            eb.set_template(lines, template)

            phase = "temp-write"
            eb.save(work_path, lines)
            candidate_bytes = work_path.read_bytes()

            phase = "verify"
            eb.verify(work_path)
        written_fingerprint = hashlib.sha256(candidate_bytes).hexdigest()

        phase = "candidate-write"
        candidate_name = f".{deck_name}.{uuid.uuid4().hex}.tmp"
        _write_new_file_fd(project_fd, candidate_name, candidate_bytes)
        os.fsync(project_fd)

        phase = "fingerprint"
        if _read_regular_file_fd(project_fd, deck_name, "Deck") != original_bytes:
            error = RuntimeError("Deck 在写入期间已发生变化，拒绝覆盖")
            error.deck_code = "DECK_CHANGED"
            raise error

        phase = "transaction"
        if sidecar_identity is None:
            transactions = _ensure_plain_directory(
                session_dir / "transactions", parent=session_dir
            )
            transaction_identity = _identity_for(transactions, "transactions")
        else:
            transactions = session_dir / "transactions"
            try:
                transaction_identity = _require_identity(
                    sidecar_identity, "transactions", transactions
                )
            except Exception as error:
                raise _unsafe_project_error(
                    "transactions identity 已在服务运行期间变化", error
                ) from error
        transaction_name = f"{transaction_id}.json"
        transaction = transactions / transaction_name
        transaction_payload = {
            "version": 1,
            "transactionId": transaction_id,
            "deckPath": str(deck_path),
            "sessionDir": str(session_dir),
            "oldFingerprint": digest,
            "candidateFingerprint": written_fingerprint,
            "backup": str(backup),
        }
        if session_id is not None:
            transaction_payload["sessionId"] = session_id
        _write_new_file(
            transactions,
            transaction_name,
            json.dumps(
                transaction_payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8"),
            transaction_identity,
        )
        transaction_written = True

        phase = "fingerprint"
        if _read_regular_file_fd(project_fd, deck_name, "Deck") != original_bytes:
            _unlink_regular_file(
                transactions, transaction_name, transaction_identity
            )
            transaction_written = False
            error = RuntimeError("Deck 在 transaction 落盘后、replace 前发生变化，拒绝覆盖")
            error.deck_code = "DECK_CHANGED"
            raise error

        phase = "replace"
        if _read_regular_file_fd(
            project_fd, candidate_name, "Deck 候选文件"
        ) != candidate_bytes:
            raise RuntimeError("Deck 候选文件在 replace 前发生变化，拒绝覆盖")
        os.replace(
            candidate_name,
            deck_name,
            src_dir_fd=project_fd,
            dst_dir_fd=project_fd,
        )
        candidate_name = None
        os.fsync(project_fd)
    except Exception as error:
        if not hasattr(error, "deck_stage"):
            error.deck_stage = phase
        if isinstance(candidate_bytes, bytes):
            error.deck_candidate_bytes = candidate_bytes
        if transaction_written:
            error.deck_transaction = str(transaction)
        raise
    finally:
        if project_fd is not None:
            if candidate_name is not None:
                try:
                    os.unlink(candidate_name, dir_fd=project_fd)
                    os.fsync(project_fd)
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
            os.close(project_fd)

    return {
        "ok": True,
        "backup": str(backup),
        "fingerprint": written_fingerprint,
        "transaction": str(transaction),
    }


def write_patches_safe(
    deck_path,
    patches,
    session_dir,
    expected_fingerprint=None,
    transaction_id=None,
    sidecar_identity=None,
    session_id=None,
):
    """供 Node 服务调用的稳定结果封装；底层 write_patches 仍保留原异常类型便于测试。"""
    deck_path = _absolute_path(deck_path)
    session_dir = _absolute_path(session_dir)
    try:
        return write_patches(
            deck_path,
            patches,
            session_dir,
            expected_fingerprint=expected_fingerprint,
            transaction_id=transaction_id,
            sidecar_identity=sidecar_identity,
            session_id=session_id,
        )
    except Exception as error:
        stage = getattr(error, "deck_stage", "write")
        code = getattr(error, "deck_code", None)
        if code is None:
            code = "VERIFY_FAILED" if stage in {"decode", "verify"} else "WRITE_FAILED"
        recovery = {
            "DECK_CHANGED": "重新载入外部文件并在新基线上重放补丁，或另存为副本",
            "VERIFY_FAILED": "检查 bundle 结构和补丁定位器后重试",
            "WRITE_FAILED": "检查备份、目录权限和磁盘空间后重试",
            "UNSAFE_SIDECAR": "恢复启动时项目目录后重新启动编辑服务",
        }[code]
        result = {
            "ok": False,
            "code": code,
            "stage": stage,
            "message": str(error) or "写回 Deck 失败",
            "recovery": recovery,
        }
        if isinstance(getattr(error, "deck_transaction", None), str):
            result["transaction"] = error.deck_transaction
        if code == "UNSAFE_SIDECAR":
            return result
        try:
            safe_session = _ensure_sidecar_session(
                deck_path, session_dir, sidecar_identity
            )
            if sidecar_identity is None:
                diagnostics = _ensure_plain_directory(
                    safe_session / "write-errors", parent=safe_session
                )
                diagnostic_identity = _identity_for(diagnostics, "writeErrors")
            else:
                diagnostics = safe_session / "write-errors"
                diagnostic_identity = _require_identity(
                    sidecar_identity, "writeErrors", diagnostics
                )
            token = hashlib.sha256(os.urandom(32)).hexdigest()[:16]
            candidate_bytes = getattr(error, "deck_candidate_bytes", None)
            candidate_relative = None
            if isinstance(candidate_bytes, bytes):
                candidate_name = f"candidate-{token}.html"
                _write_new_file(
                    diagnostics, candidate_name, candidate_bytes, diagnostic_identity
                )
                candidate_relative = f"write-errors/{candidate_name}"
                result["candidate"] = candidate_relative
            diagnostic_name = f"write-{token}.json"
            diagnostic_relative = f"write-errors/{diagnostic_name}"
            diagnostic_payload = {
                "code": code,
                "stage": stage,
                "message": str(error),
                "errorType": type(error).__name__,
            }
            if candidate_relative is not None:
                diagnostic_payload["candidate"] = candidate_relative
            _write_new_file(
                diagnostics,
                diagnostic_name,
                json.dumps(
                    diagnostic_payload, ensure_ascii=False, indent=2
                ).encode("utf-8"),
                diagnostic_identity,
            )
            result["diagnostic"] = diagnostic_relative
        except Exception as diagnostic_error:
            result["diagnosticError"] = str(diagnostic_error)
        return result
