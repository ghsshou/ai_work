#!/usr/bin/env python3
"""Combine an npm plugin tarball with verified Windows Python/browser resources."""
import argparse
import hashlib
import gzip
import io
import json
from pathlib import Path
import tarfile
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugin-tgz', required=True, type=Path)
    parser.add_argument('--runtime-root', required=True, type=Path,
                        help='Directory containing python/ and browser/')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    runtime = args.runtime_root.resolve(strict=True)
    output = args.output.resolve()
    if output.exists():
        parser.error('Output exists; choose a new path')
    required = ('python/python.exe', 'browser/chrome.exe')
    for rel in required:
        if not (runtime / rel).is_file():
            parser.error(f'Missing Windows runtime file: {rel}')
    files = []
    for directory in ('python', 'browser'):
        for path in (runtime / directory).rglob('*'):
            if path.is_symlink():
                parser.error(f'Runtime symlink is unsupported: {path}')
            if path.is_file():
                files.append(path)
            elif not path.is_dir():
                parser.error(f'Runtime entry is unsupported: {path}')
    with tarfile.open(args.plugin_tgz, 'r:gz') as source:
        members = source.getmembers()
        names = [m.name for m in members]
        if len(names) != len(set(names)) or any(not n.startswith('package/') or
                '..' in Path(n).parts or n.startswith('package/runtime/') for n in names):
            parser.error('Base package has invalid or duplicate paths')
        manifest = next((m for m in members if m.name == 'package/package.json'), None)
        if manifest is None:
            parser.error('Base package lacks package.json')
        package = json.load(source.extractfile(manifest))
        if package.get('name') != 'aico-ppt-skill':
            parser.error('Base package is not aico-ppt-skill')
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix='.tgz', delete=False) as temp:
            temporary = Path(temp.name)
        try:
            with tempfile.TemporaryFile() as payload, tarfile.open(temporary, 'w:gz') as target:
                for member in members:
                    if not (member.isfile() or member.isdir() or member.issym()):
                        parser.error(f'Unsupported package entry: {member.name}')
                    if member.name == 'package/package.json':
                        package['aico'] = {**package.get('aico', {}), 'bundledRuntime': True}
                        data = json.dumps(package, ensure_ascii=False, indent=2).encode('utf-8')
                        member.size = len(data)
                        target.addfile(member, io.BytesIO(data))
                    else:
                        target.addfile(member, source.extractfile(member) if member.isfile() else None)
                # No executable or DLL is linked into node_modules/pnpm's shared
                # store. The plugin verifies and unpacks this bounded byte stream
                # into its private runtime before starting native processes.
                inventory = {'schema': 1, 'target': 'win32-x64', 'files': []}
                with gzip.GzipFile(fileobj=payload, mode='wb', mtime=0) as compressed:
                    for path in sorted(files):
                        content = path.read_bytes()
                        inventory['files'].append({'path': path.relative_to(runtime).as_posix(),
                                                   'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
                        compressed.write(content)
                size = payload.tell()
                payload.seek(0)
                hasher = hashlib.sha256()
                for chunk in iter(lambda: payload.read(1024 * 1024), b''):
                    hasher.update(chunk)
                digest = hasher.hexdigest()
                inventory['payload'] = {'format': 'gzip-concatenated-v1', 'path': 'resources.gz',
                                        'bytes': size, 'sha256': digest}
                payload.seek(0)
                entry = tarfile.TarInfo('package/runtime/resources.gz')
                entry.size = size
                entry.mode = 0o644
                target.addfile(entry, payload)
                data = json.dumps(inventory, separators=(',', ':')).encode('utf-8')
                entry = tarfile.TarInfo('package/runtime/manifest.json')
                entry.size = len(data)
                entry.mode = 0o644
                target.addfile(entry, io.BytesIO(data))
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
    print(json.dumps({'output': str(output), 'version': package['version'],
                      'runtimeFiles': len(files), 'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()

