# SPDX-License-Identifier: MPL-2.0
"""Isolated CPU image worker. Only /job is writable; no network or original-file mount."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import time
import zipfile

from PIL import Image, ImageDraw, ImageFont, ImageOps

Image.MAX_IMAGE_PIXELS = 40_000_000
MAX_PAGES = 80
MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf'


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def page_name(index):
    return f'{index:04d}'


def safe_entries(archive):
    """Do not extract paths, links, XML or executable files supplied by a source."""
    entries = []
    names = set()
    total = 0
    if len(archive.infolist()) > 500:
        raise ValueError('Zu viele Einträge im Kapitelarchiv.')
    for item in archive.infolist():
        name = item.filename.replace('\\', '/')
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\x00' in name:
            raise ValueError('Unsicherer Pfad im Kapitelarchiv.')
        if stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1:
            raise ValueError('Links und verschlüsselte Archive werden nicht verarbeitet.')
        if item.is_dir() or path.suffix.lower() not in {'.jpg', '.jpeg', '.png', '.webp', '.gif'}:
            continue
        if name in names:
            raise ValueError('Doppelte Bildnamen im Kapitelarchiv.')
        names.add(name)
        total += item.file_size
        if item.file_size > MAX_FILE or total > MAX_TOTAL or item.file_size / max(1, item.compress_size) > 250:
            raise ValueError('Kapitelarchiv überschreitet die Größenlimits.')
        entries.append(item)
    if not 1 <= len(entries) <= MAX_PAGES:
        raise ValueError(f'Bitte ein vollständiges Kapitel mit 1 bis {MAX_PAGES} Seiten wählen.')
    # Suwayomi itself reads downloaded image files lexicographically, not in natural order.
    return sorted(entries, key=lambda item: item.filename)


def extract(root):
    original = root / 'original'
    original.mkdir(exist_ok=True)
    previews = root / 'preview'
    previews.mkdir(exist_ok=True)
    pages = []
    total_pixels = 0
    with zipfile.ZipFile(root / 'input.cbz') as archive:
        for index, entry in enumerate(safe_entries(archive)):
            with archive.open(entry) as handle:
                with Image.open(handle) as raw:
                    if getattr(raw, 'n_frames', 1) > 1:
                        raise ValueError('Animierte Kapitelbilder werden nicht unterstützt.')
                    if raw.width * raw.height > Image.MAX_IMAGE_PIXELS or min(raw.size) < 16:
                        raise ValueError('Unzulässige Bildabmessungen.')
                    total_pixels += raw.width * raw.height
                    if total_pixels > 512_000_000:
                        raise ValueError('Kapitel überschreitet das Gesamtlimit für Bildpixel.')
                    image = ImageOps.exif_transpose(raw).convert('RGB')
                    if image.width * image.height > Image.MAX_IMAGE_PIXELS or min(image.size) < 16:
                        raise ValueError('Unzulässige Bildabmessungen.')
                    image.save(original / (page_name(index) + '.png'))
                    # Context images are not used for text coordinates. Tall pages are tiled for OCR below.
                    preview = image.copy()
                    preview.thumbnail((1400, 2000))
                    preview.save(previews / (page_name(index) + '.jpg'), quality=85)
                    tiles = []
                    if image.height > image.width * 2.5:
                        for top in range(0, image.height, 1800):
                            if len(tiles) >= 24:
                                raise ValueError('Webtoon-Seite ist für den ersten Ausbau zu lang (mehr als 24 Kontextausschnitte).')
                            bottom = min(top + 2000, image.height)
                            tile = image.crop((0, top, image.width, bottom))
                            tile.thumbnail((1400, 2000))
                            filename = f'{page_name(index)}-{len(tiles):02d}.jpg'
                            tile.save(previews / filename, quality=85)
                            tiles.append({'file': filename, 'top': top, 'height': bottom - top})
                            if bottom == image.height:
                                break
                    pages.append({'index': index, 'width': image.width, 'height': image.height,
                                  'sha256': hashlib.sha256(image.tobytes()).hexdigest(), 'blocks': [], 'warnings': [],
                                  'visualTiles': tiles})
    return pages


def group_boxes(boxes, japanese):
    """Conservative line grouping; never join distant panels into one translation region."""
    groups = []
    for box, text, confidence in boxes:
        x0, y0, x1, y1 = box
        merged = False
        for group in groups:
            a, b, c, d = group['box']
            overlap = max(0, min(c, x1) - max(a, x0))
            width = max(1, min(c - a, x1 - x0))
            gap = max(b - y1, y0 - d, 0)
            vertical_overlap = max(0, min(d, y1) - max(b, y0)) / max(1, min(d - b, y1 - y0))
            horizontal_gap = max(a - x1, x0 - c, 0)
            same_column = overlap / width > 0.65 and gap < min(d - b, y1 - y0) * 0.65
            adjacent_vertical_columns = japanese and vertical_overlap > 0.75 and horizontal_gap < width * 0.7
            if same_column or adjacent_vertical_columns:
                group['box'] = [min(a, x0), min(b, y0), max(c, x1), max(d, y1)]
                group['text'] += (' ' if group['text'] else '') + text
                group['confidence'] = min(group['confidence'], confidence)
                merged = True
                break
        if not merged:
            groups.append({'box': box, 'text': text, 'confidence': confidence})
    return sorted(groups, key=lambda group: (group['box'][1] // 60, -group['box'][0] if japanese else group['box'][0]))


def analyze(root, options):
    print('OCR-Modelle laden; Quellsprache=' + options['sourceLanguage'], flush=True)
    import easyocr
    import numpy as np
    import torch
    threads = max(1, min(8, int(options.get('threads', os.environ.get('OCR_THREADS', '4')))))
    torch.set_num_threads(threads)
    import cv2
    cv2.setNumThreads(threads)
    japanese = options['sourceLanguage'] == 'ja'
    reader = easyocr.Reader(['en'], gpu=False, model_storage_directory='/opt/ocr-models/easyocr',
                            user_network_directory='/tmp/easyocr-user', download_enabled=False,
                            recognizer=not japanese, verbose=False)
    mocr = None
    if japanese:
        from manga_ocr import MangaOcr
        mocr = MangaOcr('/opt/ocr-models/manga-ocr', force_cpu=True)
    pages = extract(root)
    print(f'Lokales Kapitel: {len(pages)} Seiten; OCR startet.', flush=True)
    block_total = 0
    started = time.monotonic()
    for page in pages:
        page_started = time.monotonic()
        image = Image.open(root / 'original' / (page_name(page['index']) + '.png')).convert('RGB')
        boxes = []
        # Overlap prevents words crossing tile boundaries from disappearing on long webtoons.
        tile_height = max(1800, min(3000, image.width * 2))
        step = tile_height - 200
        for top in range(0, image.height, step):
            bottom = min(top + tile_height, image.height)
            tile = np.asarray(image.crop((0, top, image.width, bottom)))
            if japanese:
                horizontal, free = reader.detect(tile, canvas_size=2560, mag_ratio=1.3,
                                                 text_threshold=0.65, low_text=0.35, link_threshold=0.4,
                                                 add_margin=0.08)
                detected = [([int(b[0]), int(b[2]) + top, int(b[1]), int(b[3]) + top], '', 1.0)
                            for b in horizontal[0]]
                for polygon in free[0]:
                    coords = np.asarray(polygon)
                    detected.append(([int(coords[:, 0].min()), int(coords[:, 1].min()) + top,
                                      int(coords[:, 0].max()), int(coords[:, 1].max()) + top], '', 1.0))
            else:
                detected = []
                for polygon, text, confidence in reader.readtext(tile, paragraph=False, canvas_size=2560,
                                                                 mag_ratio=1.3, add_margin=0.06):
                    coords = np.asarray(polygon)
                    detected.append(([int(coords[:, 0].min()), int(coords[:, 1].min()) + top,
                                      int(coords[:, 0].max()), int(coords[:, 1].max()) + top], text, float(confidence)))
            for box, text, confidence in detected:
                x0, y0, x1, y1 = box
                box = [max(0, x0), max(0, y0), min(image.width, x1), min(image.height, y1)]
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue
                if any(intersection_over_union(box, old[0]) > 0.45 for old in boxes):
                    continue
                boxes.append((box, text, confidence))
            if bottom == image.height:
                break
        for index, group in enumerate(group_boxes(boxes, japanese)):
            if japanese:
                group['text'] = mocr(image.crop(tuple(group['box'])))
                # manga-ocr does not expose calibrated probabilities: never invent confidence.
                group['confidence'] = None
            group['text'] = group['text'].strip()[:1500]
            if not group['text']:
                continue
            group.update({'id': f'p{page["index"]}b{index}', 'translated': '', 'note': '', 'rendered': False})
            page['blocks'].append(group)
        block_total += len(page['blocks'])
        if len(page['blocks']) > 180 or block_total > 2500:
            raise ValueError('Zu viele Textbereiche. Bitte ein kürzeres Kapitel wählen.')
        write_json(root / 'progress.json', {'stage': 'ocr', 'completed': page['index'] + 1, 'total': len(pages), 'blockCount': block_total, 'elapsedSeconds': round(time.monotonic() - started, 1), 'lastPageSeconds': round(time.monotonic() - page_started, 1)})
        print(f"OCR Seite {page['index'] + 1}/{len(pages)} abgeschlossen.", flush=True)
    return {'pages': pages, 'engine': 'CRAFT + manga-ocr 0.1.16' if japanese else 'EasyOCR 1.7.2 (CRAFT + English)',
            'warnings': ['Automatische Erkennung ist nicht fehlerfrei. OCR vor der Übersetzung prüfen.']}


def intersection_over_union(a, b):
    overlap = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return overlap / max(1, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap)


def wrap_text(draw, text, font, width):
    lines = []
    for paragraph in text.splitlines() or ['']:
        line = ''
        for word in paragraph.split():
            if draw.textlength(word, font=font) > width:
                # Split long German compound words rather than cutting off the right edge.
                chunks = []
                part = ''
                for char in word:
                    if part and draw.textlength(part + char + '-', font=font) > width:
                        chunks.append(part + '-')
                        part = char
                    else:
                        part += char
                chunks.append(part)
            else:
                chunks = [word]
            for chunk in chunks:
                candidate = (line + ' ' + chunk).strip()
                if line and draw.textlength(candidate, font=font) > width:
                    lines.append(line)
                    line = chunk
                else:
                    line = candidate
        lines.append(line)
    return '\n'.join(lines)


def fit_text(draw, text, width, height, font_path=FONT):
    for size in range(min(46, max(12, height // 2)), 11, -1):
        font = ImageFont.truetype(font_path, size)
        wrapped = wrap_text(draw, text, font, width)
        box = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=2, align='center')
        if box[2] - box[0] <= width and box[3] - box[1] <= height:
            return font, wrapped, box
    return None


def render_page(image, page, font_path=FONT):
    """Only replace text on a confidently plain light background. Art/SFX are left intact."""
    import numpy as np
    image = image.copy().convert('RGB')
    draw = ImageDraw.Draw(image)
    warnings = []
    for block in page['blocks']:
        block['rendered'] = False
        text = block.get('translated', '').strip()
        if not text:
            continue
        if block.get('confidence') is not None and block['confidence'] < 0.35 and not block.get('reviewed'):
            warnings.append(f'{block["id"]}: Niedriger OCR-Wert; Originalschrift bis zur manuellen Prüfung beibehalten.')
            continue
        x0, y0, x1, y1 = map(int, block['box'])
        if not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height):
            raise ValueError('Textbereich liegt außerhalb des Bildes.')
        # Expand into adjacent white space only, with a small bound to avoid panel art.
        for _ in range(12):
            candidate = [max(0, x0 - 2), max(0, y0 - 2), min(image.width, x1 + 2), min(image.height, y1 + 2)]
            a, b, c, d = candidate
            pixels = np.asarray(image.crop(tuple(candidate)).convert('L'))
            border = np.concatenate([pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]])
            collision = any(other['id'] != block['id'] and
                            min(c, other['box'][2]) > max(a, other['box'][0]) and
                            min(d, other['box'][3]) > max(b, other['box'][1]) for other in page['blocks'])
            if float((border > 235).mean()) < 0.98 or collision:
                break
            x0, y0, x1, y1 = candidate
        pixels = np.asarray(image.crop((x0, y0, x1, y1)).convert('L'))
        border = np.concatenate([pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]])
        if float((border > 235).mean()) < 0.95 or float((pixels > 235).mean()) < 0.65:
            warnings.append(f'{block["id"]}: Zeichnung/dunkler Hintergrund; Originalschrift beibehalten.')
            continue
        fit = fit_text(draw, text, x1 - x0 - 6, y1 - y0 - 6, font_path)
        if fit is None:
            warnings.append(f'{block["id"]}: Übersetzung passt nicht lesbar in den Textbereich.')
            continue
        font, wrapped, bounds = fit
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill='white')
        draw.multiline_text((x0 + (x1 - x0 - (bounds[2] - bounds[0])) / 2 - bounds[0],
                            y0 + (y1 - y0 - (bounds[3] - bounds[1])) / 2 - bounds[1]),
                           wrapped, fill='black', font=font, spacing=2, align='center')
        block['rendered'] = True
    return image, warnings


def render(root, options):
    output = root / 'translated'
    output.mkdir(exist_ok=True)
    data = json.loads((root / 'content.json').read_text())
    pages = data['pages']
    for page in pages:
        if options.get('page') is not None and page['index'] != options['page']:
            continue
        name = page_name(page['index']) + '.png'
        image, warnings = render_page(Image.open(root / 'original' / name), page)
        temporary = output / (name + '.tmp')
        image.save(temporary, format='PNG')
        temporary.chmod(0o600)
        temporary.replace(output / name)
        page['warnings'] = warnings
        write_json(root / 'progress.json', {'stage': 'render', 'completed': page['index'] + 1, 'total': len(pages)})
        print(f"Seite {page['index'] + 1}/{len(pages)} gesetzt.", flush=True)
    write_json(root / 'content.json', data)
    return data


def main():
    os.umask(0o077)
    root = Path(sys.argv[1]).resolve()
    options = json.loads((root / 'request.json').read_text())
    try:
        if options['operation'] == 'analyze':
            result = analyze(root, options)
            write_json(root / 'content.json', result)
        elif options['operation'] == 'render':
            result = render(root, options)
        else:
            raise ValueError('Unbekannte Bildverarbeitung.')
        write_json(root / 'worker-result.json', {'ok': True})
    except Exception as error:
        # Exception bodies must not include credentials (this worker never receives any).
        write_json(root / 'worker-result.json', {'ok': False, 'error': str(error)[:800]})
        raise


if __name__ == '__main__':
    main()
