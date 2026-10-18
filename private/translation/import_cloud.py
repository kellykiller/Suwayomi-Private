"""Import only the numbered PNG pages of a completed cloud translator job."""
import json
import shutil
import stat
import sys
import zipfile
from pathlib import Path


def unpack(archive_path, destination, page_count):
    if not isinstance(page_count, int) or not 1 <= page_count <= 100:
        raise ValueError('Ungueltige Seitenanzahl.')
    destination = Path(destination)
    expected = [f'{index:04d}.png' for index in range(1, page_count+1)]
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        if sorted(i.filename for i in infos) != expected:
            raise ValueError('Cloud-Ausgabe enthaelt nicht genau die erwarteten PNG-Seiten.')
        if sum(i.file_size for i in infos) > 4*1024**3:
            raise ValueError('Cloud-Ausgabe ist groesser als 4 GiB.')
        destination.mkdir(mode=0o700)
        for info in infos:
            if (info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16)
                    or not 8 < info.file_size <= 100*1024**2):
                raise ValueError('Ungueltige Bilddatei in der Cloud-Ausgabe.')
            with archive.open(info) as source, (destination/info.filename).open('xb') as output:
                signature = source.read(8)
                if signature != b'\x89PNG\r\n\x1a\n':
                    raise ValueError('Cloud-Seite ist keine PNG-Datei.')
                output.write(signature)
                shutil.copyfileobj(source, output, length=64*1024)
    return {'pages': expected}


if __name__ == '__main__':
    try:
        print(json.dumps(unpack(sys.argv[1], sys.argv[2], int(sys.argv[3]))))
    except Exception:
        print('Cloud-Bildausgabe konnte nicht vollstaendig importiert werden.', file=sys.stderr)
        sys.exit(1)
