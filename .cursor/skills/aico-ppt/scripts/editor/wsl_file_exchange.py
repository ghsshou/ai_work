"""WSL 本地 Windows 卷的受控既有文件交换；不是通用覆盖写入后备方案。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import ctypes
import struct
import base64


class ExchangeError(RuntimeError):
    def __init__(self, message, committed=False):
        super().__init__(message)
        self.committed = committed


def exchange(directory_fd, left, right):
    directory = os.readlink(f"/proc/self/fd/{directory_fd}")
    identity = os.fstat(directory_fd)
    info = ctypes.create_string_buffer(256)
    if ctypes.CDLL(None, use_errno=True).fstatfs(directory_fd, info) != 0 \
            or struct.calcsize("P") != 8 or struct.unpack_from("l", info)[0] != 0x01021997:
        raise ExchangeError("Windows 发布桥仅支持 WSL2 的 64 位 9p Windows 挂载盘")
    # Windows 文件 ID 只在 dirfd 对应的真实 Windows 卷路径上使用。
    mapped = subprocess.run(["wslpath", "-w", directory], check=True, capture_output=True, text=True).stdout.strip()
    if len(mapped) < 3 or mapped[1:3] != ":\\":
        raise ExchangeError("当前文件系统不支持安全交换，且不是 Windows 本地卷")
    command = os.environ.get("AICO_WINDOWS_POWERSHELL") or shutil.which("powershell.exe")
    command = command or "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    if not Path(command).is_file():
        raise ExchangeError("WSL 无法调用 Windows 安全文件发布服务")
    # Windows 默认用户不能读取 WSL /root；由当前 Linux 用户读取可信插件代码，
    # 固定脚本走 EncodedCommand，实现和文件名走 stdin JSON，不拼接用户内容。
    script = Path(__file__).with_name("wsl-file-exchange.ps1").read_text(encoding="utf-8")
    implementation = Path(__file__).with_name("wsl-file-exchange.cs").read_text(encoding="utf-8")
    encoded_script = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    # Linux fs/9p/vfs_inode.c 的 v9fs_qid2ino 在 64 位平台使用 qid.path + 2。
    # 只对上面已校验的 9p 目录反解，绝不接受任意文件系统的近似身份。
    payload = {"directory": mapped, "directoryId": str((identity.st_ino-2) % (1 << 64)), "left": left, "right": right, "implementation": implementation}
    try:
        result = subprocess.run([command, "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded_script],
                                input=json.dumps(payload, ensure_ascii=True).encode("utf-8"), capture_output=True,
                                timeout=15, cwd=directory)
    except (subprocess.TimeoutExpired, OSError) as error:
        raise ExchangeError("Windows 发布服务响应不确定，保留事务等待恢复", committed=True) from error
    try:
        receipt = json.loads(result.stdout.decode("utf-8").strip().lstrip("\ufeff"))
    except (ValueError, TypeError, UnicodeError) as error:
        raise ExchangeError("Windows 发布服务未返回可信回执，保留事务等待恢复", committed=True) from error
    if receipt.get("ok") is not True or result.returncode != 0:
        raise ExchangeError(receipt.get("message", "Windows 文件发布失败"), receipt.get("committed") is True)
    after = os.stat(directory, follow_symlinks=False)
    if (after.st_dev, after.st_ino) != (identity.st_dev, identity.st_ino):
        raise ExchangeError("Windows 发布后的父目录身份变化，保留事务等待恢复", committed=True)
