"""回收无引用的完整工作版本；文件操作和独占锁由可信 sidecar 后端提供。"""

import hashlib
import json
import re
import stat
import time

VERSION = re.compile(r"[a-f0-9]{64}\.html")
FINGERPRINT = re.compile(r"(?<![a-fA-F0-9])[a-fA-F0-9]{64}(?![a-fA-F0-9])")
KEEP_LATEST = 8
KEEP_SECONDS = 24 * 60 * 60
MAX_METADATA = 32 * 1024 * 1024


def collect_working_versions(payload, *, session_id, deck_name, directories,
                             list_names, file_stat, read_file, unlink, guard, error_type):
    def reject(message):
        raise error_type(message, code="WORKING_VERSION_GC_UNSAFE")

    if not isinstance(payload, dict) or set(payload) != {"dryRun"} \
            or not isinstance(payload["dryRun"], bool):
        reject("版本回收参数无效")
    guard()
    result = {"dryRun": payload["dryRun"], "removed": 0, "removedBytes": 0,
              "candidates": [], "candidateBytes": 0, "kept": 0}
    listings = {}
    witnesses = {}
    references = set()

    def names(area):
        value = sorted(list_names(directories[area]))
        listings[area] = value
        return value

    def witness(area, name):
        info = file_stat(directories[area], name)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) \
                or getattr(info, "st_file_attributes", 0) & 0x400:
            reject("版本回收遇到非普通文件或重解析点，已停止")
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def read(area, name, maximum):
        before = witness(area, name)
        value = read_file(directories[area], name, maximum)
        if witness(area, name) != before:
            reject("版本回收期间文件发生变化，已停止")
        witnesses[(area, name)] = before
        return value

    # 未完成固化或恢复事务交给原有恢复流程；回收不推断它们是否已经完成。
    if names("transactions"):
        return {**result, "skipped": "transactions-present"}
    metadata = {}
    total = 0
    for area in ("session", "writeErrors"):
        for name in names(area):
            if not name.endswith((".json", ".jsonl")):
                continue
            raw = read(area, name, MAX_METADATA)
            total += len(raw)
            if total > 2 * MAX_METADATA:
                reject("版本引用元数据过大，跳过回收")
            try:
                value = ([json.loads(line) for line in raw.splitlines() if line.strip()]
                         if name.endswith(".jsonl") else json.loads(raw))
            except (ValueError, UnicodeError):
                reject("版本引用元数据损坏，跳过回收")
            metadata[(area, name)] = value
            # 同时保护嵌套历史、归档、结果回执和路径中的指纹；宁可多保留。
            references.update(x.lower() for x in FINGERPRINT.findall(raw.decode("utf-8")))
    state = metadata.get(("session", "session.json"))
    if not isinstance(state, dict) or state.get("version") != 2 \
            or state.get("sessionId") != session_id:
        reject("版本回收缺少可信的当前会话元数据")
    if state.get("sourceEdit") or state.get("conflict"):
        return {**result, "skipped": "session-not-settled"}
    working = read("working", "deck.html", 48 * 1024 * 1024)
    working_hash = hashlib.sha256(working).hexdigest()
    if state.get("workingDeckFingerprint") != working_hash:
        return {**result, "skipped": "working-checkpoint-pending"}
    references.add(working_hash)
    for area, name in (("project", deck_name), ("working", "deck.before-upgrade.html")):
        try:
            references.add(hashlib.sha256(read(area, name, 48 * 1024 * 1024)).hexdigest())
        except FileNotFoundError:
            pass
    for name in names("backups"):
        references.update(x.lower() for x in FINGERPRINT.findall(name))
    versions = []
    for name in names("versions"):
        if VERSION.fullmatch(name):
            info = witness("versions", name)
            versions.append((name, info))
    versions.sort(key=lambda item: (item[1][3], item[0]), reverse=True)
    latest = {name for name, _ in versions[:KEEP_LATEST]}
    cutoff = time.time_ns() - KEEP_SECONDS * 1_000_000_000
    candidates = [(name, info) for name, info in versions
                  if name[:-5] not in references and name not in latest and info[3] < cutoff]
    result.update(candidates=[name for name, _ in candidates],
                  candidateBytes=sum(info[2] for _, info in candidates),
                  kept=len(versions) - len(candidates))

    def unchanged():
        guard()
        for (area, name), info in witnesses.items():
            if witness(area, name) != info:
                reject("版本回收期间会话或工作副本发生变化，已停止")
        for area, original in listings.items():
            if area != "versions" and sorted(list_names(directories[area])) != original:
                reject("版本回收期间目录内容发生变化，已停止")

    unchanged()
    if not payload["dryRun"]:
        for name, info in candidates:
            unchanged()
            if witness("versions", name) != info:
                reject("待回收版本发生变化，已停止")
            if unlink(directories["versions"], name)["removed"]:
                result["removed"] += 1
                result["removedBytes"] += info[2]
    return result
