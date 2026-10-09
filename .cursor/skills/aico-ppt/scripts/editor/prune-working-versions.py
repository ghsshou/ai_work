#!/usr/bin/env python3
"""离线检查/回收指定编辑会话的旧孤立版本；默认只预览。"""
import argparse
import json
import os
from pathlib import Path
import sys

from sidecar_io import PersistentHelper, SidecarIOError
from product_paths import PROJECT_STATE_DIRECTORY, LEGACY_PROJECT_STATE_DIRECTORY


def identity(path):
    info = path.lstat()
    return dict(path=str(path), realPath=str(path.resolve()), dev=str(info.st_dev), ino=str(info.st_ino))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('session_directory', type=Path, help='包含 session.json 的会话目录')
    parser.add_argument('--apply', action='store_true', help='取得独占锁后实际回收')
    parser.add_argument('--report', type=Path, help='保存清理清单；实际回收时必填，且文件不得已存在')
    args = parser.parse_args()
    session = args.session_directory.absolute()
    root = session.parent
    project = root.parent
    if root.name not in {PROJECT_STATE_DIRECTORY, LEGACY_PROJECT_STATE_DIRECTORY}:
        parser.error('只接受受控 sidecar 中的会话目录')
    if args.apply and not args.report:
        parser.error('--apply 必须同时指定 --report 保存清理清单')
    if args.report and args.report.absolute().is_relative_to(root):
        parser.error('报告必须写在 sidecar 之外')
    if args.report and args.report.exists():
        parser.error('报告已经存在，拒绝覆盖')
    if os.name == 'nt':
        from sidecar_io_windows import WindowsPersistentHelper
        helper = WindowsPersistentHelper()
    else:
        # Windows 项目必须在 Windows 执行，避免不同平台使用不同文件锁。
        if str(project).startswith('/mnt/') and (root / '.session.lock').exists():
            parser.error('Windows 项目请用 Windows Python 执行，以取得原生编辑锁')
        helper = PersistentHelper()
    try:
        helper.initialize({'project':identity(project), 'root':identity(root)})
        # 取得独占锁后按 registry 中已登记的会话绑定；不创建或迁移会话。
        state_path = session / 'session.json'
        if state_path.is_symlink() or not state_path.is_file():
            parser.error('session.json 必须是已有常规文件')
        state = json.loads(state_path.read_text(encoding='utf-8'))
        deck_name = Path(state['deckPath']).name
        helper.bind_session(dict(deckName=deck_name, sessionName=session.name,
                                 sessionId=state['sessionId'], create=False))
        plan = helper.prune_working_versions({'dryRun':True})
        report = {'session':str(session), 'plan':plan}
        if args.apply and not plan.get('skipped'):
            # 清单在删除前落盘；完整历史和 Deck 不复制、不改写。
            with args.report.open('x', encoding='utf-8') as output:
                json.dump(report, output, ensure_ascii=False, indent=2)
                output.flush(); os.fsync(output.fileno())
            report['result'] = helper.prune_working_versions({'dryRun':False})
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        elif args.report:
            with args.report.open('x', encoding='utf-8') as output:
                json.dump(report, output, ensure_ascii=False, indent=2)
        print(json.dumps({key:value for key,value in report.get('result', plan).items()
                          if key != 'candidates'}, ensure_ascii=False))
    finally:
        helper.close()


if __name__ == '__main__':
    try:
        main()
    except (SidecarIOError, OSError, ValueError, KeyError) as error:
        print(f'版本清理未完成：{error}', file=sys.stderr)
        sys.exit(1)
