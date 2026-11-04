#!/usr/bin/env python3
"""Update M5's web UI without changing CLI versions or restarting servers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile


def publish(source, target):
    """Publish assets first and atomically switch the entry point last."""
    if not (source / 'index.html').is_file():
        raise RuntimeError('UI build has no index.html')
    files = sorted(p for p in source.rglob('*') if p.is_file())
    if any(p.is_symlink() for p in source.rglob('*')):
        raise RuntimeError('UI builds must not contain symlinks')
    target.mkdir(parents=True, exist_ok=True)
    for file in sorted(files, key=lambda p: p == source / 'index.html'):
        dest = target / file.relative_to(source)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as temp:
            temporary = Path(temp.name)
        try:
            shutil.copyfile(file, temporary)
            if hashlib.sha256(temporary.read_bytes()).digest() != hashlib.sha256(file.read_bytes()).digest():
                raise RuntimeError(f'UI asset verification failed: {file.name}')
            os.replace(temporary, dest)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-dir', type=Path, default=Path.home() / '.t3')
    parser.add_argument('--app', type=Path, default=Path('/Applications/T3 Code (Beta).app'))
    parser.add_argument('--built-client', type=Path, help='Use an already built client instead of building')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    with (args.app / 'Contents/Info.plist').open('rb') as file:
        version = plistlib.load(file)['CFBundleShortVersionString']
    archive = args.app / 'Contents/Resources/app.asar'
    if b'uiClientDirectory' not in archive.read_bytes():
        raise RuntimeError('Desktop needs the one-time UI-loader bootstrap; CLI and remote servers do not need updating')
    baseline = json.loads((args.base_dir / 'runtime/versions' / version / '.fleet-source.json').read_text())['source']
    changed = subprocess.check_output(['git', 'diff', '--name-only', baseline, 'HEAD'], text=True).splitlines()
    allowed = ('apps/web/src/', 'apps/web/public/', 'apps/desktop/src/', 'scripts/', 'docs/')
    unsafe = [p for p in changed if not p.startswith(allowed) and p != 'AGENTS.md']
    if unsafe:
        raise RuntimeError('Backend/shared-contract/dependency changes require a full update: ' + ', '.join(unsafe))
    if subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip():
        raise RuntimeError('Commit the source changes before publishing UI')
    source = args.built_client
    if source is None:
        subprocess.run(['vp', 'run', '--filter', '@t3tools/web', 'build'], check=True)
        source = root / 'apps/web/dist'
        subprocess.run(['node', 'scripts/apply-web-brand-assets.ts', 'production', str(source)], check=True)
    target = args.base_dir / 'ui' / version / 'client'
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if (target / 'index.html').exists():
        backups = args.base_dir / 'ui' / version / 'backups'
        backups.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(target / 'index.html', backups / (hashlib.sha256((target / 'index.html').read_bytes()).hexdigest() + '.html'))
    publish(source, target)
    (target.parent / 'revision.json').write_text(json.dumps({'source': revision, 'serverVersion': version}))
    print(f'UI updated to {revision[:10]}; CLI/server version remains {version}. Reload the T3 window.')


if __name__ == '__main__':
    main()
