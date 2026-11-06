"""Package runtime files only; never include local browser profiles or credentials."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import hashlib
import shutil
root = Path(__file__).resolve().parents[1]
source = root / 'extension'
manifest = json.loads((source / 'manifest.json').read_text())
output = root / 'dist' / f"bilibili-favorites-organizer-{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(source))
print(output)
# Keep a versioned copy in Git so every finished package can be downloaded
# directly from the repository, without depending on Release API credentials.
published = root / 'packages' / output.name
published.parent.mkdir(exist_ok=True)
shutil.copyfile(output, published)
checksum = hashlib.sha256(published.read_bytes()).hexdigest()
published.with_suffix('.zip.sha256').write_text(f'{checksum}  {published.name}\n')
print(published)
