"""Export original Suwayomi pages, without OCR, image recompression or AI calls."""
import json
import os
import re
import shutil
import stat
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".webp", ".avif",
                  ".gif", ".giff", ".bmp", ".dib", ".tif", ".tiff",
                  ".heic", ".heif", ".hif", ".pdf", ".jp2", ".j2k", ".jpf", ".jpx",
                  ".ppm", ".pgm", ".pbm", ".pnm", ".tga", ".pcx", ".ico"}
MAX_CHAPTER_BYTES = 1024 ** 3
MAX_PAGE_BYTES = 128 * 1024 ** 2


def safe_name(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '_', str(value)).strip().rstrip('. ')[:80].rstrip('. ')
    if not value or re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', value, re.I):
        value = '_' + (value or 'Manga')
    return value


def natural_key(value):
    return tuple((0, int(part)) if part.isdigit() else (1, part.casefold())
                 for part in re.split(r'(\d+)', value))


def image_entries(source, expected_count):
    entries = []
    seen = set()
    total = 0
    for item in source.infolist():
        path = PurePosixPath(item.filename)
        if item.is_dir():
            continue
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        if (path.is_absolute() or '..' in path.parts or '\\' in item.filename or
                re.match(r'^[A-Za-z]:', item.filename) or item.filename in seen or
                stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
            raise ValueError('Unsicherer Bildpfad im Kapitelarchiv.')
        if item.file_size <= 0 or item.file_size > MAX_PAGE_BYTES:
            raise ValueError('Ungültige Bildgröße im Kapitelarchiv.')
        total += item.file_size
        if total > 2 * MAX_CHAPTER_BYTES:
            raise ValueError('Entpacktes Kapitel ist zu groß.')
        entries.append(item)
        seen.add(item.filename)
    if not entries or len(entries) != expected_count:
        raise ValueError('Archiv und Suwayomi-Seitenanzahl stimmen nicht überein.')
    return sorted(entries, key=lambda item: natural_key(item.filename))


def write_pages(target, source, entries, prefix=''):
    width = max(4, len(str(len(entries))))
    for index, item in enumerate(entries, 1):
        suffix = PurePosixPath(item.filename).suffix.lower()
        name = f'{prefix}{index:0{width}d}{suffix}'
        with source.open(item) as page, target.open(name, 'w', force_zip64=True) as output:
            shutil.copyfileobj(page, output, length=64 * 1024)


def write_chapter(target, archive_path, chapter, rank, directory, format, single):
    manga_folder = f"{safe_name(chapter['manga']['title'])} ({chapter['mangaId']})"
    chapter_folder = f"{rank:05d} - {safe_name(chapter['name'])} ({chapter['id']})"
    with zipfile.ZipFile(archive_path) as source:
        entries = image_entries(source, chapter['pageCount'])
        if format == 'folders':
            write_pages(target, source, entries, f'{manga_folder}/{chapter_folder}/')
        elif single:
            write_pages(target, source, entries)
        else:
            nested = Path(directory) / 'chapter-output.cbz'
            try:
                with zipfile.ZipFile(nested, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as cbz:
                    write_pages(cbz, source, entries)
                target.write(nested, f'{manga_folder}/{chapter_folder}.cbz')
            finally:
                nested.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Unerwartete Weiterleitung beim Kapitelabruf.')


def fetch_chapter(config, chapter, path):
    endpoint = config['upstream'].rstrip('/') + f"/api/v1/chapter/{chapter['id']}/download?markAsRead=false"
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(endpoint, headers=config['headers'])
    with opener.open(request, timeout=120) as response, open(path, 'wb') as output:
        size = 0
        while True:
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_CHAPTER_BYTES:
                raise ValueError('Ein Kapitelarchiv überschreitet 1 GiB.')
            output.write(chunk)


def export(config, output, downloader=fetch_chapter):
    origin = urllib.parse.urlsplit(config['upstream'])
    if (origin.scheme != 'http' or not origin.hostname or origin.username or origin.password or
            origin.path not in ('', '/') or origin.query or origin.fragment):
        raise ValueError('Ungültiges internes Suwayomi-Ziel.')
    chapters = config['chapters']
    if config['format'] not in ('cbz', 'folders') or not chapters:
        raise ValueError('Ungültige Exportauswahl.')
    directory = config['directory']
    ranks = {}
    # ZipFile supports non-seekable stdout and produces ZIP64 when needed.
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as target:
        for chapter in chapters:
            if (not isinstance(chapter['id'], int) or chapter['id'] <= 0 or
                    not isinstance(chapter['pageCount'], int) or not 0 < chapter['pageCount'] <= 10000):
                raise ValueError('Ungültige Kapitelinformationen.')
            ranks[chapter['mangaId']] = ranks.get(chapter['mangaId'], 0) + 1
            archive_path = Path(directory) / 'chapter-input.cbz'
            try:
                downloader(config, chapter, archive_path)
                write_chapter(target, archive_path, chapter, ranks[chapter['mangaId']], directory,
                              config['format'], len(chapters) == 1)
            finally:
                archive_path.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        export(json.load(sys.stdin), sys.stdout.buffer)
    except Exception as error:
        # Never emit URLs, request headers or credentials in export diagnostics.
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f'Bildexport fehlgeschlagen: {message}', file=sys.stderr, flush=True)
        sys.exit(1)
