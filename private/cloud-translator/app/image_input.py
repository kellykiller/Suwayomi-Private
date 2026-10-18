"""Bounded local image/document decoding shared by HTTP validation and OCR import."""
from contextlib import closing
import io
import math
from pathlib import Path, PurePosixPath
import re
import stat
import threading
import zipfile

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
import pypdfium2 as pdfium

register_heif_opener(thumbnails=False)

IMAGE_EXTENSIONS = {
    '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.avif',
    '.bmp', '.dib', '.tif', '.tiff', '.gif', '.giff',
    '.heic', '.heif', '.hif', '.jp2', '.j2k', '.jpf', '.jpx',
    '.ppm', '.pgm', '.pbm', '.pnm', '.tga', '.pcx', '.ico',
}
EXTENSIONS = IMAGE_EXTENSIONS | {'.pdf'}
IMAGE_FORMATS = {'JPEG', 'PNG', 'WEBP', 'AVIF', 'BMP', 'DIB', 'TIFF', 'GIF',
                 'HEIF', 'JPEG2000', 'PPM', 'TGA', 'PCX', 'ICO'}
MAX_BYTES = 256 * 1024**2
MAX_PAGE_BYTES = 20 * 1024**2
MAX_PIXELS = 20_000_000
MAX_EDGE = 12000
MAX_PAGES = 100
PDF_DPI = 300
PDF_LOCK = threading.RLock()


class InputError(ValueError):
    pass


def natural(value):
    return [(0, int(x)) if x.isdigit() else (1, x.lower()) for x in re.split(r'(\d+)', str(value))]


def dimensions(size):
    w, h = size
    if not 0 < w <= MAX_EDGE or not 0 < h <= MAX_EDGE or w*h > MAX_PIXELS:
        raise InputError('Bild groesser als 20 MP oder 12000 Pixel Kantenlaenge.')


def documents(source):
    """Yield file bytes without extracting any archive member path."""
    source = Path(source)
    if source.is_dir():
        entries = sorted((p for p in source.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS), key=lambda p: natural(p.name))
        if not entries or len(entries) > MAX_PAGES or sum(p.stat().st_size for p in entries) > MAX_BYTES:
            raise InputError('Eingang muss 1 bis 100 Dateien mit insgesamt maximal 256 MiB enthalten.')
        for path in entries:
            yield path.name, path.read_bytes()
        return
    if not 0 < source.stat().st_size <= MAX_BYTES:
        raise InputError('Eingangsdatei maximal 256 MiB.')
    if not zipfile.is_zipfile(source):
        yield source.name, source.read_bytes()
        return
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > 500:
            raise InputError('Zu viele Archiveintraege (maximal 500).')
        names, expanded, entries = set(), 0, []
        for item in infos:
            name = item.filename.replace('\\', '/')
            parts = PurePosixPath(name).parts
            if (not parts or name.startswith('/') or '..' in parts or ':' in name or '\x00' in name
                    or name.casefold() in names or item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16)):
                raise InputError('Unsicherer oder doppelter Pfad im Archiv.')
            names.add(name.casefold())
            expanded += item.file_size
            if expanded > MAX_BYTES:
                raise InputError('Entpackter Eingang groesser als 256 MiB.')
            if item.is_dir() or '__MACOSX' in parts:
                continue
            suffix = Path(name).suffix.lower()
            if suffix not in EXTENSIONS:
                # Only known harmless metadata may be ignored; never drop an
                # unrecognized potential page and start charging for the rest.
                if suffix in {'.xml', '.json', '.txt', '.nfo'} and item.file_size <= 1024**2:
                    continue
                raise InputError('Nicht unterstuetzter Archiveintrag: ' + suffix[:20])
            if not 0 < item.file_size <= (MAX_BYTES if suffix == '.pdf' else MAX_PAGE_BYTES):
                raise InputError('Bilddatei groesser als 20 MiB oder leer (PDF maximal 256 MiB).')
            entries.append(item)
        if not entries or len(entries) > MAX_PAGES:
            raise InputError('Archiv muss 1 bis 100 Bild-/PDF-Dateien enthalten.')
        for item in sorted(entries, key=lambda item: natural(item.filename)):
            yield item.filename, archive.read(item)


def decode(name, data):
    """Yield loaded frames; TIFF/HEIF/PDF expand, animations use first frame."""
    if b'%PDF-' in data[:1024]:
        with PDF_LOCK, pdfium.PdfDocument(data) as pdf:
            count = len(pdf)
            if not 1 <= count <= MAX_PAGES:
                raise InputError('PDF muss 1 bis 100 Seiten enthalten.')
            pdf.init_forms()
            for index in range(count):
                with closing(pdf[index]) as page:
                    width, height = page.get_size()
                    if not all(math.isfinite(v) and 0 < v <= 1_000_000 for v in (width, height)):
                        raise InputError('Ungueltige PDF-Seitengroesse.')
                    scale = min(PDF_DPI/72, (MAX_EDGE-1)/width, (MAX_EDGE-1)/height,
                                math.sqrt((MAX_PIXELS-2*MAX_EDGE)/(width*height)))
                    dimensions((math.ceil(width*scale), math.ceil(height*scale)))
                    with closing(page.render(scale=scale, fill_color=(255, 255, 255, 255))) as bitmap:
                        with closing(bitmap.to_pil().copy()) as image:
                            dimensions(image.size)
                            yield index, count, image, None, '.png'
        return
    if len(data) > MAX_PAGE_BYTES:
        raise InputError('Bilddatei groesser als 20 MiB.')
    with Image.open(io.BytesIO(data)) as image:
        format = image.format
        if format not in IMAGE_FORMATS:
            raise InputError('Nicht unterstuetztes Bildformat: ' + str(format))
        if format in {'TIFF', 'HEIF'}:
            frames = count = getattr(image, 'n_frames', 1)
        else:
            # Do not scan a GIF's complete animation just to read frame zero.
            frames = 2 if getattr(image, 'is_animated', False) else 1
            count = 1
        if not 1 <= count <= MAX_PAGES:
            raise InputError('Mehrseitige Bilddatei muss 1 bis 100 Seiten enthalten.')
        for index in range(count):
            image.seek(index)
            dimensions(image.size)
            image.load()
            suffix = Path(name).suffix.lower()
            original = data if format in {'JPEG', 'PNG', 'WEBP'} and frames == 1 else None
            if original is not None:
                suffix = suffix if suffix in {'.jpg', '.jpeg', '.png', '.webp'} else {'JPEG': '.jpg', 'PNG': '.png', 'WEBP': '.webp'}[format]
                yield index, count, image, original, suffix
            else:
                with closing(ImageOps.exif_transpose(image)) as oriented:
                    yield index, count, oriented, None, '.png'


def pages(source):
    count = 0
    try:
        for source_index, (name, data) in enumerate(documents(source)):
            for frame, total, image, original, suffix in decode(name, data):
                count += 1
                if count > MAX_PAGES:
                    raise InputError('Mehr als 100 Seiten nach Aufteilung von PDF/TIFF/HEIF.')
                yield {'source_index': source_index, 'name': name if total == 1 else f'{name}#page={frame+1:04d}',
                       'image': image, 'original': original, 'suffix': suffix}
        if not count:
            raise InputError('Keine Bildseiten im Eingang gefunden.')
    except InputError:
        raise
    except (OSError, ValueError, RuntimeError, EOFError, SyntaxError, zipfile.BadZipFile, Image.DecompressionBombError):
        raise InputError('Bild/PDF ist defekt, verschluesselt oder kann nicht dekodiert werden.') from None


def inspect(source):
    mapping = [page['source_index'] for page in pages(source)]
    return {'pages': len(mapping), 'source_entries': max(mapping)+1, 'page_map': mapping}


def png_bytes(image):
    if image.mode.startswith('I;16'):
        # Preserve the full grayscale range when making an 8-bit OCR image.
        import numpy as np
        with closing(Image.fromarray((np.asarray(image).astype('uint16') >> 8).astype('uint8'))) as grayscale:
            return png_bytes(grayscale)
    mode = 'RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB'
    with closing(image.convert(mode)) as pixels:
        pixels.info.clear()
        output = io.BytesIO()
        pixels.save(output, 'PNG', icc_profile=image.info.get('icc_profile'))
        return output.getvalue()
