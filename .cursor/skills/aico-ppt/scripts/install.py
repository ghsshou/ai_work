#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AICO-PPT 跨平台安装器。

当前实现面向 Developer Link：把本仓库安全注册到一个或多个 Agent Skill
目录；默认只注册 Skill，--dev-shell 才检查或修复开发调试依赖。安装器不会覆盖来源不明的目标，
卸载也只移除 install-state.json 中登记且仍指向本仓库的链接或 junction。

用法：
  python3 scripts/install.py inspect
  python3 scripts/install.py install
  python3 scripts/install.py repair
  python3 scripts/install.py uninstall

Windows PowerShell 把 python3 换成 py -3。
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid


REPO = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = 1
PRODUCT_VERSION = "0.1.0-dev"
HOST_TARGETS = {
    "codex": Path(".agents/skills/aico-ppt"),
    "claude-code": Path(".claude/skills/aico-ppt"),
    "codex-legacy": Path(".codex/skills/aico-ppt"),
}
LEGACY_HOST_TARGETS = {
    "codex": Path(".agents/skills/huawei-deck"),
    "claude-code": Path(".claude/skills/huawei-deck"),
    "codex-legacy": Path(".codex/skills/huawei-deck"),
}


class InstallError(RuntimeError):
    """可安全展示并带稳定错误码的安装错误。"""

    def __init__(self, code: str, message: str, *, details: str = ""):
        super().__init__(message)
        self.code = code
        self.details = details


class InstallAction:
    def __init__(self, kind, host=None, target=None, method=None):
        self.kind = kind
        self.host = host
        self.target = target
        self.method = method

    def to_dict(self):
        return {
            key: value for key, value in {
                "kind": self.kind,
                "host": self.host,
                "target": self.target,
                "method": self.method,
            }.items() if value is not None
        }


def _utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def default_state_file(*, platform=sys.platform, home: Path | None = None, env=None):
    home = Path(home or Path.home()).resolve()
    env = env or os.environ
    if platform == "darwin":
        root = home / "Library" / "Application Support" / "AICO-PPT"
    elif platform == "win32":
        local = env.get("LOCALAPPDATA")
        root = Path(local) / "AICO-PPT" if local else home / "AppData" / "Local" / "AICO-PPT"
    else:
        state_root = env.get("XDG_STATE_HOME")
        root = Path(state_root) / "aico-ppt" if state_root else home / ".local" / "state" / "aico-ppt"
    return root / "install-state.json"


def legacy_state_file(*, platform=sys.platform, home: Path | None = None, env=None):
    home = Path(home or Path.home()).resolve()
    env = env or os.environ
    if platform == "darwin":
        root = home / "Library" / "Application Support" / "Huawei Deck"
    elif platform == "win32":
        local = env.get("LOCALAPPDATA")
        root = Path(local) / "Huawei Deck" if local else home / "AppData" / "Local" / "Huawei Deck"
    else:
        state_root = env.get("XDG_STATE_HOME")
        root = Path(state_root) / "huawei-deck" if state_root else home / ".local" / "state" / "huawei-deck"
    return root / "install-state.json"


def _lexists(path: Path):
    return os.path.lexists(path)


def _same_target(target: Path, root: Path):
    if not _lexists(target):
        return False
    try:
        return target.resolve(strict=True) == root.resolve(strict=True)
    except (OSError, RuntimeError):
        return False


def _same_entry_path(left: Path, right: Path):
    """比较目录项本身，不跟随最终 symlink；兼容 macOS /var 与 /private/var。"""
    try:
        return left.parent.resolve() / left.name == right.parent.resolve() / right.name
    except (OSError, RuntimeError):
        return left == right


def _registration_method(target: Path, *, platform=sys.platform):
    if platform == "win32":
        return "junction"
    return "symlink" if target.is_symlink() else "unknown"


def _atomic_write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent,
        prefix=f".{path.name}.", suffix=".tmp", delete=False,
    )
    temporary = Path(handle.name)
    try:
        with handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _load_state(path: Path):
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise InstallError("INSTALL_STATE_INVALID", "安装记录损坏，无法继续", details=str(error)) from error
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION:
        raise InstallError("INSTALL_STATE_INVALID", "安装记录版本不受支持")
    return value


def _create_registration(target: Path, root: Path, method: str):
    target.parent.mkdir(parents=True, exist_ok=True)
    if method == "symlink":
        target.symlink_to(root, target_is_directory=True)
        return
    if method == "junction":
        command = [
            os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c",
            f'mklink /J "{target}" "{root}"',
        ]
        completed = subprocess.run(command, capture_output=True, text=True)
        if completed.returncode != 0:
            raise InstallError(
                "INSTALL_REGISTRATION_FAILED",
                f"无法创建 Windows Skill junction：{target}",
                details=(completed.stderr or completed.stdout or "").strip(),
            )
        return
    raise InstallError("INSTALL_METHOD_UNSUPPORTED", f"不支持的注册方式：{method}")


def _remove_registration(target: Path, method: str):
    if method == "junction":
        completed = subprocess.run(
            [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", f'rmdir "{target}"'],
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise InstallError(
                "UNINSTALL_FAILED", f"无法移除 Windows Skill junction：{target}",
                details=(completed.stderr or completed.stdout or "").strip(),
            )
        return
    target.unlink()


class InstallationManager:
    """隐藏注册路径、所有权记录、幂等修复与安全卸载的 Deep Module。"""

    def __init__(
        self,
        *,
        root: Path = REPO,
        home: Path | None = None,
        hosts=("codex",),
        state_file: Path | None = None,
        platform=sys.platform,
    ):
        self.root = Path(root).resolve()
        self.home = Path(home or Path.home()).resolve()
        self.hosts = tuple(hosts)
        self.platform = platform
        self.state_file = Path(state_file) if state_file else default_state_file(
            platform=platform, home=self.home,
        )
        self.legacy_state_file = None if state_file else legacy_state_file(
            platform=platform, home=self.home,
        )
        if not (self.root / "SKILL.md").is_file():
            raise InstallError("INSTALL_ROOT_INVALID", f"安装根目录缺少 SKILL.md：{self.root}")
        unknown = [host for host in self.hosts if host not in HOST_TARGETS]
        if unknown:
            raise InstallError("INSTALL_HOST_UNSUPPORTED", "不支持的 Agent host：" + "、".join(unknown))

    def target_for(self, host: str):
        return self.home / HOST_TARGETS[host]

    def _record(self):
        state = _load_state(self.state_file)
        if state is not None:
            return state, self.state_file
        if self.legacy_state_file and self.legacy_state_file != self.state_file:
            legacy = _load_state(self.legacy_state_file)
            if legacy is not None:
                return legacy, self.legacy_state_file
        return None, self.state_file

    def inspect(self):
        state, record_source = self._record()
        registrations = []
        recorded = {
            item.get("host"): item
            for item in (state or {}).get("registrations", [])
            if isinstance(item, dict)
        }
        owned_paths = set((state or {}).get("ownedPaths", []))
        for host in self.hosts:
            target = self.target_for(host)
            exists = _lexists(target)
            same = _same_target(target, self.root)
            managed = bool(
                recorded.get(host)
                and recorded[host].get("targetPath") in owned_paths
                and same
            )
            if managed:
                status = "ready"
            elif same:
                status = "adoption-required"
            elif exists:
                status = "occupied"
            else:
                status = "absent"
            registrations.append({
                "host": host,
                "targetPath": str(target),
                "state": status,
                "method": recorded.get(host, {}).get("method")
                    or (_registration_method(target, platform=self.platform) if same else None),
                "managed": managed,
                **({"resolvedTarget": str(target.resolve(strict=True))} if same else {}),
            })
        ready = all(item["state"] == "ready" for item in registrations)
        manual_action_required = any(
            item["state"] in {"occupied", "adoption-required"} for item in registrations
        )
        legacy_registrations = []
        if record_source != self.state_file:
            for item in (state or {}).get("registrations", []):
                host = item.get("host")
                target = Path(item.get("targetPath", ""))
                expected = self.home / LEGACY_HOST_TARGETS.get(host, Path("__unsupported__"))
                if (host in self.hosts and _same_entry_path(target, expected)
                        and item.get("targetPath") in owned_paths
                        and _same_target(target, self.root)):
                    legacy_registrations.append({
                        "host": host,
                        "targetPath": str(target),
                        "method": item.get("method")
                            or _registration_method(target, platform=self.platform),
                    })
        return {
            "schemaVersion": SCHEMA_VERSION,
            "channel": "developer",
            "productVersion": PRODUCT_VERSION,
            "installRoot": str(self.root),
            "stateFile": str(self.state_file),
            "recordSource": str(record_source),
            "ready": ready,
            "state": "ready" if ready
                else "manual-action-required" if manual_action_required
                else "repairable",
            "registrations": registrations,
            "record": state,
            "legacyRegistrations": legacy_registrations,
        }

    def plan(self, operation: str, *, adopt_existing=False):
        snapshot = self.inspect()
        actions = []
        if operation in {"install", "repair"}:
            occupied = [item for item in snapshot["registrations"] if item["state"] == "occupied"]
            if occupied:
                targets = "、".join(item["targetPath"] for item in occupied)
                raise InstallError(
                    "INSTALL_TARGET_OCCUPIED",
                    "Skill 注册目标已存在且不指向当前仓库；安装器不会覆盖它",
                    details=targets,
                )
            adoption_required = [
                item for item in snapshot["registrations"]
                if item["state"] == "adoption-required"
            ]
            if adoption_required and not adopt_existing:
                targets = "、".join(item["targetPath"] for item in adoption_required)
                raise InstallError(
                    "INSTALL_ADOPTION_REQUIRED",
                    "Skill 注册已指向当前仓库，但不属于本安装记录；确认后才能接管",
                    details=targets,
                )
            method = "junction" if self.platform == "win32" else "symlink"
            for item in snapshot["registrations"]:
                if item["state"] == "absent":
                    actions.append(InstallAction(
                        "create-registration", host=item["host"],
                        target=item["targetPath"], method=method,
                    ))
                elif item["state"] == "adoption-required":
                    actions.append(InstallAction(
                        "adopt-registration", host=item["host"],
                        target=item["targetPath"], method=item["method"] or method,
                    ))
            actions.append(InstallAction("write-state"))
            for item in snapshot.get("legacyRegistrations", []):
                actions.append(InstallAction(
                    "remove-legacy-registration", host=item["host"],
                    target=item["targetPath"], method=item["method"],
                ))
            if snapshot.get("recordSource") != str(self.state_file):
                actions.append(InstallAction("remove-legacy-state"))
        elif operation == "uninstall":
            record = snapshot["record"]
            if record:
                requested = set(self.hosts)
                owned_paths = set(record.get("ownedPaths", []))
                for item in record.get("registrations", []):
                    if item.get("host") not in requested:
                        continue
                    if item.get("targetPath") not in owned_paths:
                        continue
                    target = Path(item.get("targetPath", ""))
                    if not _lexists(target):
                        continue
                    if not _same_target(target, self.root):
                        raise InstallError(
                            "UNINSTALL_TARGET_CHANGED",
                            "Skill 注册目标在安装后已变化，拒绝删除",
                            details=str(target),
                        )
                    actions.append(InstallAction(
                        "remove-registration", host=item.get("host"), target=str(target),
                        method=item.get("method") or _registration_method(target, platform=self.platform),
                    ))
                remaining = [
                    item for item in record.get("registrations", [])
                    if item.get("host") not in requested
                    and item.get("targetPath") in owned_paths
                ]
                if remaining:
                    actions.append(InstallAction("write-state"))
                    if snapshot.get("recordSource") != str(self.state_file):
                        actions.append(InstallAction("remove-legacy-state"))
                else:
                    actions.append(InstallAction(
                        "remove-legacy-state"
                        if snapshot.get("recordSource") != str(self.state_file)
                        else "remove-state"
                    ))
        else:
            raise InstallError("INSTALL_OPERATION_INVALID", f"未知安装动作：{operation}")
        return {
            "schemaVersion": SCHEMA_VERSION,
            "operation": operation,
            "installRoot": str(self.root),
            "stateFile": str(self.state_file),
            "actions": [action.to_dict() for action in actions],
        }

    def apply(self, plan, *, dry_run=False):
        if plan.get("schemaVersion") != SCHEMA_VERSION or plan.get("installRoot") != str(self.root):
            raise InstallError("INSTALL_PLAN_INVALID", "安装计划与当前安装器不匹配")
        if dry_run:
            return {"status": "planned", "plan": plan, "snapshot": self.inspect()}
        before_state = self.state_file.read_bytes() if self.state_file.is_file() else None
        before_legacy_state = (
            self.legacy_state_file.read_bytes()
            if self.legacy_state_file and self.legacy_state_file.is_file() else None
        )
        before_record, _ = self._record()
        owned_targets = set((before_record or {}).get("ownedPaths", []))
        created = []
        removed = []
        try:
            for raw in plan.get("actions", []):
                kind = raw.get("kind")
                if kind == "create-registration":
                    target = Path(raw["target"])
                    if _lexists(target):
                        if _same_target(target, self.root):
                            raise InstallError(
                                "INSTALL_ADOPTION_REQUIRED",
                                f"注册目标在执行期间变为同源链接，需要明确确认接管：{target}",
                            )
                        raise InstallError("INSTALL_TARGET_OCCUPIED", f"注册目标已被占用：{target}")
                    _create_registration(target, self.root, raw["method"])
                    created.append((target, raw["method"]))
                    owned_targets.add(str(target))
                elif kind == "adopt-registration":
                    target = Path(raw["target"])
                    if not _same_target(target, self.root):
                        raise InstallError(
                            "INSTALL_ADOPTION_TARGET_CHANGED",
                            f"待接管的 Skill 注册已经变化：{target}",
                        )
                    owned_targets.add(str(target))
                elif kind == "remove-registration":
                    target = Path(raw["target"])
                    if _lexists(target):
                        if not _same_target(target, self.root):
                            raise InstallError("UNINSTALL_TARGET_CHANGED", f"注册目标已变化：{target}")
                        removed.append((target, raw["method"]))
                        _remove_registration(target, raw["method"])
                    owned_targets.discard(str(target))
                elif kind == "remove-legacy-registration":
                    target = Path(raw["target"])
                    if _lexists(target):
                        if not _same_target(target, self.root):
                            raise InstallError(
                                "INSTALL_LEGACY_TARGET_CHANGED",
                                f"旧 Skill 注册目标已经变化：{target}",
                            )
                        removed.append((target, raw["method"]))
                        _remove_registration(target, raw["method"])
                    owned_targets.discard(str(target))
                elif kind == "write-state":
                    snapshot = self.inspect()
                    previous = snapshot.get("record") or {}
                    registrations = [
                        item for item in previous.get("registrations", [])
                        if item.get("host") not in self.hosts
                        and item.get("targetPath") in owned_targets
                    ] + [
                        {
                            "host": item["host"],
                            "targetPath": item["targetPath"],
                            "method": item["method"]
                                or ("junction" if self.platform == "win32" else "symlink"),
                        }
                        for item in snapshot["registrations"]
                        if item["state"] in {"ready", "adoption-required"}
                        and item["targetPath"] in owned_targets
                    ]
                    payload = {
                        "schemaVersion": SCHEMA_VERSION,
                        "installId": previous.get("installId") or str(uuid.uuid4()),
                        "channel": "developer",
                        "productVersion": PRODUCT_VERSION,
                        "installRoot": str(self.root),
                        "registrations": registrations,
                        "ownedPaths": [item["targetPath"] for item in registrations],
                        "installedAt": previous.get("installedAt") or _utc_now(),
                        "updatedAt": _utc_now(),
                    }
                    _atomic_write_json(self.state_file, payload)
                elif kind == "remove-state":
                    self.state_file.unlink(missing_ok=True)
                elif kind == "remove-legacy-state":
                    if self.legacy_state_file:
                        self.legacy_state_file.unlink(missing_ok=True)
                else:
                    raise InstallError("INSTALL_PLAN_INVALID", f"安装计划包含未知动作：{kind}")
        except Exception as error:
            rollback_errors = []
            for target, method in reversed(created):
                if _same_target(target, self.root):
                    try:
                        _remove_registration(target, method)
                    except Exception as rollback_error:
                        rollback_errors.append(str(rollback_error))
            for target, method in reversed(removed):
                if not _lexists(target):
                    try:
                        _create_registration(target, self.root, method)
                    except Exception as rollback_error:
                        rollback_errors.append(str(rollback_error))
            if before_state is None:
                self.state_file.unlink(missing_ok=True)
            else:
                self.state_file.parent.mkdir(parents=True, exist_ok=True)
                self.state_file.write_bytes(before_state)
            if self.legacy_state_file:
                if before_legacy_state is None:
                    self.legacy_state_file.unlink(missing_ok=True)
                else:
                    self.legacy_state_file.parent.mkdir(parents=True, exist_ok=True)
                    self.legacy_state_file.write_bytes(before_legacy_state)
            if rollback_errors:
                raise InstallError(
                    "INSTALL_ROLLBACK_FAILED",
                    "安装操作失败，且未能完整恢复原状态",
                    details="；".join(rollback_errors),
                ) from error
            raise
        return {
            "status": "uninstalled" if plan["operation"] == "uninstall" else "installed",
            "plan": plan,
            "snapshot": self.inspect(),
        }


def _load_doctor():
    path = REPO / "scripts" / "check_deps.py"
    spec = importlib.util.spec_from_file_location("aico_ppt_check_deps", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _parse_hosts(value):
    hosts = []
    for item in value:
        for host in item.split(","):
            host = host.strip()
            if not host:
                continue
            if host == "all":
                hosts.extend(HOST_TARGETS)
            else:
                hosts.append(host)
    return tuple(dict.fromkeys(hosts or ["codex"]))


def _print_result(result):
    snapshot = result.get("snapshot", result)
    print(f"AICO-PPT · {snapshot.get('state', result.get('status', ''))}")
    print(f"  安装根目录：{snapshot.get('installRoot')}")
    for item in snapshot.get("registrations", []):
        symbol = "✓" if item["state"] == "ready" else "!" if item["state"] == "occupied" else "○"
        print(f"  {symbol} {item['host']}: {item['targetPath']} ({item['state']})")
    environment = result.get("environment")
    if environment:
        profile = environment["profiles"]["dev-shell"]
        print(f"  {'✓' if profile['ready'] else '!'} 独立 Dev Shell: {profile['state']}")
        for item in environment["checks"]:
            if not item["present"] and not item["optional"]:
                print(f"      - {item['label']}: {item['detail']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="AICO-PPT 跨平台安装器")
    parser.add_argument("operation", choices=("inspect", "install", "repair", "uninstall"))
    parser.add_argument("--channel", choices=("developer",), default="developer")
    parser.add_argument("--hosts", action="append", default=[],
                        help="codex、claude-code、codex-legacy 或 all；可逗号分隔")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--skill-only", action="store_true", help="只注册 Skill（默认行为，兼容旧命令）")
    mode.add_argument("--dev-shell", action="store_true", help="额外检查或修复维护者调试壳依赖")
    parser.add_argument("--dry-run", action="store_true", help="只展示计划，不写入环境")
    parser.add_argument(
        "--adopt-existing", action="store_true",
        help="明确接管已经指向当前仓库、但尚未登记所有权的 Skill 注册",
    )
    parser.add_argument("--json", action="store_true", help="输出结构化 JSON")
    parser.add_argument("--home", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--root", type=Path, default=REPO, help=argparse.SUPPRESS)
    parser.add_argument("--state-file", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    try:
        manager = InstallationManager(
            root=args.root,
            home=args.home,
            hosts=_parse_hosts(args.hosts),
            state_file=args.state_file,
        )
        if args.operation == "inspect":
            result = manager.inspect()
        else:
            result = manager.apply(
                manager.plan(args.operation, adopt_existing=args.adopt_existing),
                dry_run=args.dry_run,
            )

        if args.dev_shell and args.operation != "uninstall":
            doctor = _load_doctor()
            if args.operation in {"install", "repair"} and not args.dry_run:
                environment = doctor.repair_dependencies(
                    ["dev-shell"], capture_output=args.json,
                )
            else:
                environment = doctor.dependency_snapshot(["dev-shell"])
            result = {**result, "environment": environment}

        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            _print_result(result)
        snapshot = result.get("snapshot", result)
        skill_ready = args.operation == "uninstall" or snapshot.get("ready", False)
        editor_ready = not args.dev_shell or args.operation == "uninstall" \
            or result.get("environment", {}).get("ready", False)
        return 0 if skill_ready and editor_ready else 1
    except InstallError as error:
        payload = {
            "code": error.code,
            "message": str(error),
            "details": error.details,
            "retryable": error.code not in {"INSTALL_ROOT_INVALID", "INSTALL_STATE_INVALID"},
        }
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"{error.code}: {error}", file=sys.stderr)
            if error.details:
                print(error.details, file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(2)
