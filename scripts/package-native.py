"""Package the native cache source, installer and usage guide alongside the extension."""
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text('utf-8'))['version']
destination = root / 'dist' / f'youtube-bilingual-cache-windows-{version}.zip'
destination.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in ('subtitle_cache_host.py', 'install.ps1', 'uninstall.ps1', 'README.md'):
        archive.write(root / 'native' / name, name)
print(f'Packaged Windows cache component: {destination}')
