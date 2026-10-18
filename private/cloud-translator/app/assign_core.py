"""Assign existing Google OCR to detected bubbles; no OCR or translation requests."""
import argparse
import base64
from collections import defaultdict
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import unicodedata


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def area(box):
    return max(0, box[2]-box[0]) * max(0, box[3]-box[1])


def intersection(a, b):
    return area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def fraction(inner, outer):
    return intersection(inner, outer) / max(1, area(inner))


def iou(a, b):
    shared = intersection(a, b)
    return shared / max(1, area(a)+area(b)-shared)


def expand(box, amount):
    return [box[0]-amount, box[1]-amount, box[2]+amount, box[3]+amount]


def center_in(box, outer):
    x, y = (box[0]+box[2])/2, (box[1]+box[3])/2
    return outer[0] <= x <= outer[2] and outer[1] <= y <= outer[3]


def ocr_words(response, size):
    words = []
    full = response.get('fullTextAnnotation', {})
    for pi, page in enumerate(full.get('pages', [])):
        sx, sy = size[0]/page['width'], size[1]/page['height']
        for bi, block in enumerate(page.get('blocks', [])):
            for qi, paragraph in enumerate(block.get('paragraphs', [])):
                for wi, word in enumerate(paragraph.get('words', [])):
                    points = word.get('boundingBox', {}).get('vertices', [])
                    if len(points) != 4:
                        raise ValueError('OCR-Wort ohne vier Eckpunkte; keine stillschweigende Auslassung.')
                    xs, ys = [p.get('x', 0)*sx for p in points], [p.get('y', 0)*sy for p in points]
                    symbols = word.get('symbols', [])
                    if not symbols:
                        raise ValueError('OCR-Wort ohne Zeichen.')
                    words.append({'id': f'w{len(words)+1:04d}',
                                  'text': ''.join(s.get('text', '') for s in symbols),
                                  'box': [min(xs), min(ys), max(xs), max(ys)],
                                  'paragraph': [pi, bi, qi], 'paragraph_position': wi,
                                  'confidence': word.get('confidence'),
                                  'break': symbols[-1].get('property', {}).get('detectedBreak', {}).get('type', '')})
    if not words and full.get('text', '').strip():
        raise ValueError('OCR-Text vorhanden, aber keine Wortkoordinaten.')
    return words


def prepare_regions(detections):
    bubbles = []
    for detection in sorted((d for d in detections if d['class_id'] == 0), key=lambda d: -d['score']):
        duplicate = next((b for b in bubbles if iou(b['box'], detection['box']) >= .85), None)
        if duplicate is None:
            duplicate = {'source_id': detection['id'], 'box': detection['box'],
                         'score': detection['score'], 'kind': 'bubble', 'words': []}
            bubbles.append(duplicate)
    anchors = []
    for detection in detections:
        if detection['class_id'] not in (1, 2):
            continue
        box = detection['box']
        candidates = [(fraction(box, b['box']), b) for b in bubbles]
        best = max(candidates, key=lambda pair: pair[0], default=(0, None))
        parent = best[1] if best[0] >= .6 else None
        if parent is None:
            parent = {'source_id': detection['id'], 'box': box, 'score': detection['score'],
                      'kind': 'free_text', 'words': []}
        anchors.append({'box': box, 'score': detection['score'], 'parent': parent})
    return bubbles, anchors


def assign(words, detections, size):
    bubbles, anchors = prepare_regions(detections)
    groups = list(bubbles)
    leftovers = {}
    for word in words:
        box = word['box']
        pad = max(3, min(10, (box[3]-box[1])*.15))
        candidates = []
        for anchor in anchors:
            outer = expand(anchor['box'], pad)
            coverage = fraction(box, outer)
            if coverage >= .55 or center_in(box, outer):
                candidates.append((coverage, anchor['score'], -area(anchor['box']), anchor['parent'], 'text_anchor'))
        if not candidates:
            for bubble in bubbles:
                outer = expand(bubble['box'], pad)
                coverage = fraction(box, outer)
                if coverage >= .6 and center_in(box, outer):
                    candidates.append((coverage, bubble['score'], -area(bubble['box']), bubble, 'bubble_fallback'))
        if candidates:
            ranked = sorted(candidates, key=lambda c: c[:3], reverse=True)
            chosen = ranked[0]
            parent = chosen[3]
            if not any(parent is g for g in groups):
                groups.append(parent)
            method = chosen[4]
            # Multiple near-equal candidates from distinct bubbles are recorded, not hidden.
            word['assignment_ambiguous'] = any(c[3] is not parent and abs(c[0]-chosen[0]) < .05 for c in ranked[1:])
        else:
            key = tuple(word['paragraph'])
            if key not in leftovers:
                leftovers[key] = {'source_id': None, 'box': box, 'score': None,
                                  'kind': 'unassigned', 'words': []}
                groups.append(leftovers[key])
            parent = leftovers[key]
            method = 'retained_unassigned'
            word['assignment_ambiguous'] = False
        word['assignment_method'] = method
        parent['words'].append(word)
    groups = [g for g in groups if g['words']]
    for group in groups:
        group['text_box'] = union([w['box'] for w in group['words']])
        if group['kind'] == 'unassigned':
            group['box'] = group['text_box']
            text = ''.join(w['text'] for w in group['words'])
            if text.isdigit() and group['text_box'][1] > .9*size[1] and area(group['text_box']) < .005*size[0]*size[1]:
                group['kind'] = 'margin_number_candidate'
    return groups


def ordered_paragraphs(words):
    buckets = defaultdict(list)
    for word in words:
        buckets[tuple(word['paragraph'])].append(word)
    pieces = []
    for group in buckets.values():
        group.sort(key=lambda w: w['paragraph_position'])
        pieces.append((union([w['box'] for w in group]), group))
    # Google provides order inside each paragraph. Reorder paragraph fragments geometrically.
    pieces.sort(key=lambda p: (p[0][1], p[0][0]))
    return pieces


def text_for(words):
    pieces = []
    for _, group in ordered_paragraphs(words):
        text = ''
        for word in group:
            text += word['text']
            if word['break'] in {'EOL_SURE_SPACE', 'LINE_BREAK', 'HYPHEN'}:
                text += '\n'
            elif word['break'] in {'SPACE', 'SURE_SPACE'}:
                text += ' '
        pieces.append(text.strip())
    lines = '\n'.join(pieces)
    return lines, re.sub(r'\s+', ' ', lines).strip()


def projection_gaps(groups, axis):
    spans = sorted((g['text_box'][axis], g['text_box'][axis+2]) for g in groups)
    end = spans[0][1]
    gaps = []
    for start, stop in spans[1:]:
        if start > end:
            gaps.append((start-end, (start+end)/2))
        end = max(end, stop)
    return gaps


def reading_order(groups, direction='rtl', minimum_row_gap=0):
    """Recursive whitespace cuts on text regions, not a claim of panel recognition."""
    if len(groups) <= 1:
        return groups
    # Horizontal cuts first: finish the upper text band before moving down the page.
    # Small gaps can separate staggered bubbles in the same panel/reading band.
    # Do not let one line-height offset override the right-to-left relationship.
    gaps = [g for g in projection_gaps(groups, 1) if g[0] >= minimum_row_gap]
    if gaps:
        _, cut = max(gaps)
        upper = [g for g in groups if g['text_box'][3] <= cut]
        lower = [g for g in groups if g['text_box'][1] >= cut]
        if upper and lower:
            return reading_order(upper, direction, minimum_row_gap) + reading_order(lower, direction, minimum_row_gap)
    gaps = projection_gaps(groups, 0)
    if gaps:
        _, cut = max(gaps)
        left = [g for g in groups if g['text_box'][2] <= cut]
        right = [g for g in groups if g['text_box'][0] >= cut]
        if left and right:
            first, second = (right, left) if direction == 'rtl' else (left, right)
            return reading_order(first, direction, minimum_row_gap) + reading_order(second, direction, minimum_row_gap)
    return sorted(groups, key=lambda g: ((-1 if direction == 'rtl' else 1)*(g['text_box'][0]+g['text_box'][2])/2,
                                         g['text_box'][1]))


def finalize(groups, page_number, direction, size):
    dialogue = reading_order([g for g in groups if g['kind'] == 'bubble'], direction, size[1]*.04)
    other = sorted((g for g in groups if g['kind'] != 'bubble'), key=lambda g: (g['text_box'][1], g['text_box'][0]))
    for index, group in enumerate(dialogue + other, 1):
        group['id'] = f'p{page_number:04d}-r{index:03d}'
        group['order'] = index if group['kind'] == 'bubble' else None
        group['source_lines'], group['text'] = text_for(group['words'])
        group['flags'] = []
        if any(w['assignment_ambiguous'] for w in group['words']):
            group['flags'].append('Mehrdeutige geometrische Zuordnung')
        text = group['text']
        if any('CYRILLIC' in unicodedata.name(c, '') for c in text) and any('LATIN' in unicodedata.name(c, '') for c in text):
            group['flags'].append('Gemischte lateinische/kyrillische Schrift; OCR unveraendert')
        if group['kind'] == 'unassigned':
            group['flags'].append('Keine passende Sprechblase; Text bleibt erhalten')
    return dialogue + other


def svg_for(original, groups, size):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{size[0]}" height="{size[1]}" viewBox="0 0 {size[0]} {size[1]}">',
             f'<image xlink:href="{original}" width="{size[0]}" height="{size[1]}"/>']
    for group in groups:
        box = group['box']
        color = '#00834b' if group['kind'] == 'bubble' else '#c66a00'
        label = str(group['order']) if group['order'] else 'Rest'
        parts.append(f'<rect x="{box[0]}" y="{box[1]}" width="{box[2]-box[0]}" height="{box[3]-box[1]}" fill="none" stroke="{color}" stroke-width="4"/>')
        tx, ty = max(0,box[0]), max(26,box[1]+26)
        parts.append(f'<rect x="{tx}" y="{ty-26}" width="70" height="30" fill="white"/>'
                     f'<text x="{tx+4}" y="{ty-3}" font-size="25" font-family="sans-serif" fill="{color}">{label}</text>')
        for word in group['words']:
            b = word['box']
            parts.append(f'<rect x="{b[0]}" y="{b[1]}" width="{b[2]-b[0]}" height="{b[3]-b[1]}" fill="none" stroke="{color}" stroke-width="1"><title>{html.escape(word["text"])}</title></rect>')
    return ''.join(parts)+'</svg>'


def report(output, pages, metadata):
    sections = []
    for page in pages:
        entries = []
        for group in page['groups']:
            label = 'Blase/Kasten '+str(group['order']) if group['order'] else group['kind']
            flags = ' · '.join(group['flags'])
            entries.append(f'<li><b>{html.escape(label)}</b> <code>{group["id"]}</code>'
                           f'<p>{html.escape(group["text"])}</p><small>{html.escape(flags)}</small></li>')
        sections.append(f'<section><h2>Seite {page["page"]}</h2><p>{page["bubble_groups"]} Blasen/Kaesten, '
                        f'{page["assigned_to_bubbles"]}/{page["ocr_elements"]} OCR-Elemente darin; '
                        f'{page["other_elements"]} weitere Elemente separat erhalten.</p>'
                        f'<div class="grid"><div><a href="{page["svg"]}">Kontrollbild in voller Groesse</a>'
                        f'<object type="image/svg+xml" data="{page["svg"]}"></object></div><ol>'
                        + ''.join(entries) + '</ol></div></section>')
    content = ('<!doctype html><html lang="de"><meta charset="utf-8"><title>Schritt 1: Blasenzuordnung</title>'
               '<style>body{font:17px system-ui;max-width:1500px;margin:2rem auto;padding:0 1rem;background:#f4f5f7;color:#17232e}'
               'section{background:white;padding:1rem;margin:2rem 0;border-radius:12px}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,1fr);gap:2rem}'
               'object{width:100%;aspect-ratio:1125/1600}li{padding:.5rem;margin-bottom:.5rem;border-bottom:1px solid #ddd}li p{white-space:pre-wrap}small{color:#a04300}'
               '@media(max-width:800px){.grid{display:block}}</style>'
               '<h1>Schritt 1: Google-OCR den Sprechblasen zugeordnet</h1>'
               '<p>Fertiger Offline-Test auf vier Dialogseiten. Keine neuen Google-Aufrufe, keine Uebersetzung oder Bildbereinigung. '
               'Seite 2 (Cover) ist fuer diesen Dialogtest ausdruecklich ausgelassen.</p>'
               '<p>Gruen: zugeordnete Blasen/Erzaehlkaesten und OCR-Woerter. Nummern: automatisch vorgeschlagene Manga-Leserichtung. '
               'Orange: weiterer Text, separat erhalten. Alle OCR-Elemente sind genau einmal gespeichert.</p>'
               '<p>Die Reihenfolge verwendet geometrische Leerraumtrennung an Textregionen; es wurde kein Panelmodell eingesetzt. '
               'Komplexe oder verschachtelte Panels sind damit noch nicht allgemein geloest. OCR-Fehler werden hier bewusst nicht korrigiert.</p>'
               + ''.join(sections) + '</html>')
    (output/'bericht.html').write_text(content, encoding='utf-8')
    (output/'zuordnung.json').write_text(json.dumps({'metadata':metadata,'pages':pages},ensure_ascii=False,indent=2),encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--detections', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--direction', choices=['rtl','ltr'], default='rtl')
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError('Ausgabeordner muss leer sein.')
    args.output.mkdir(parents=True, exist_ok=True)
    data=json.loads(args.detections.read_text())
    metadata={'new_ocr_calls':0,'translation_performed':False,'reading_direction':args.direction,
              'reading_order_method':'recursive whitespace cuts on text regions; no panel detector',
              'word_text_modified':False,'selected_pages':[p['page'] for p in data]}
    pages=[]
    for entry in data:
        number=entry['page'];prefix=f'{number:04d}'
        original=args.input/f'{prefix}-original.jpg'
        raw=args.input/f'{prefix}-document-raw.json'
        if hashlib.sha256(original.read_bytes()).hexdigest() != entry['image_sha256']:
            raise ValueError('Originalbild passt nicht zu den gespeicherten Detektorergebnissen.')
        response=json.loads(raw.read_text())['responses'][0]
        if response.get('error'):
            raise ValueError('Google-Antwort enthaelt einen Fehler.')
        words=ocr_words(response,entry['size'])
        groups=finalize(assign(words,entry['detections'],entry['size']),number,args.direction,entry['size'])
        ids=[w['id'] for g in groups for w in g['words']]
        assert len(ids)==len(set(ids))==len(words), 'OCR-Element verloren oder doppelt zugeordnet'
        for path in (original,raw):shutil.copyfile(path,args.output/path.name)
        svg=f'{prefix}-zuordnung.svg'
        image_data='data:image/jpeg;base64,'+base64.b64encode(original.read_bytes()).decode('ascii')
        (args.output/svg).write_text(svg_for(image_data,groups,entry['size']),encoding='utf-8')
        count=sum(len(g['words']) for g in groups if g['kind']=='bubble')
        page={'page':number,'size':entry['size'],'input_sha256':hashlib.sha256(original.read_bytes()).hexdigest(),
              'ocr_elements':len(words),'assigned_to_bubbles':count,'other_elements':len(words)-count,
              'bubble_groups':sum(g['kind']=='bubble' for g in groups),'groups':groups,'svg':svg}
        pages.append(page)
        print('PAGE',number,'BUBBLES',page['bubble_groups'],'ASSIGNED',count,'TOTAL',len(words))
        for group in groups:print(group['order'],group['kind'],repr(group['text']),group['flags'])
    report(args.output,pages,metadata)


if __name__=='__main__':main()
