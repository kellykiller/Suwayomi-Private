"""Offline proof of concept: Google OCR polygons + assigned regions + translations.

No network requests. Never mutates input files. Outputs PNG at input resolution.
White balloons use glyph masks; free text uses OpenCV Telea reconstruction.
Failed layouts are reported, never silently cropped into a balloon.
"""
from pathlib import Path
from functools import lru_cache
import hashlib
import html
import json
import math
import re
import time
import cv2
import numpy as np
import pyphen
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
FONT = ROOT / 'font/DejaVuSans-Bold.ttf'
WIDTH_SCALE = 0.85
HYPHENATOR = pyphen.Pyphen(lang='de_DE')

def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def save_png(image, path):
    temporary = path.with_suffix('.tmp')
    image.save(temporary, format='PNG')
    with Image.open(temporary) as check:
        check.load()
        assert check.size == image.size
    temporary.replace(path)

def ocr_words(page):
    raw = json.loads((ROOT / f'input/{page:04d}-document-raw.json').read_text())
    result = {}
    for pg in raw['responses'][0]['fullTextAnnotation']['pages']:
        for block in pg['blocks']:
            for paragraph in block['paragraphs']:
                for w in paragraph['words']:
                    result[f'w{len(result)+1:04d}'] = w
    return result

def vertices(word):
    return [(v.get('x', 0), v.get('y', 0)) for v in word['boundingBox']['vertices']]

def text_mask(image, words):
    mask, score, details = complete_text_mask(image, words)
    return mask, score

def complete_text_mask(image, words):
    """Follow complete ink components seeded by OCR, without clipping at OCR edges.

    Connected artwork extending beyond bounded word neighbourhoods is rejected.
    A safety rejection is reported to the caller; it must retain the source.
    """
    gray = np.asarray(image.convert('L'))
    polygons = Image.new('L', image.size)
    allowed_image = Image.new('L', image.size)
    draw = ImageDraw.Draw(polygons)
    allowed_draw = ImageDraw.Draw(allowed_image)
    for word in words:
        points = vertices(word)
        draw.polygon(points, fill=255)
        a,b = np.min(points,axis=0);c,d = np.max(points,axis=0)
        margin = max(6,min(24,round((d-b)*.3)))
        allowed_draw.rectangle((int(a-margin),int(b-margin),int(c+margin),int(d+margin)), fill=255)
    polygon = np.asarray(polygons)>0
    allowed = np.asarray(allowed_image)>0
    labels,count = ndi.label(gray<220)
    # Seed inside word polygons. Expanded seeds can accidentally select a nearby
    # balloon outline, which is a large connected artwork component.
    seeds = ndi.binary_erosion(polygon,iterations=1) & (gray<190)
    selected_ids = np.unique(labels[seeds]);selected_ids=selected_ids[selected_ids!=0]
    component = np.isin(labels,selected_ids)
    rejected_ids = np.unique(labels[component & ~allowed])
    rejected_ids = rejected_ids[rejected_ids!=0]
    # A small fringe intersection with a distant frame is not evidence that
    # the frame is text. Leave that component intact and log the weak overlap.
    seed_counts = np.bincount(labels[seeds].ravel(),minlength=count+1)
    minimum_overlap = max(10,int(np.count_nonzero(seeds)*.02))
    strong_rejected_ids = np.asarray([i for i in rejected_ids if seed_counts[i]>=minimum_overlap],dtype=int)
    ignored_weak_artwork = len(rejected_ids)-len(strong_rejected_ids)
    accepted_ids = selected_ids[~np.isin(selected_ids,rejected_ids)]
    component = np.isin(labels,accepted_ids)
    # Remove antialiasing around accepted letters, but preserve other dark ink
    # components even when they lie within the dilation radius.
    mask = component | (ndi.binary_dilation(component,iterations=2) & (gray>=220))
    # Measure background independently of ink that protrudes beyond OCR polygons.
    ring = ndi.binary_dilation(polygon,iterations=7) & ~ndi.binary_dilation(polygon,iterations=2) & ~mask
    white_fraction = float(np.mean(gray[ring] >= 235)) if ring.any() else 0.0
    # Compare the old clipping rule with the full accepted components.
    old_polygon=ndi.binary_dilation(polygon,iterations=2)
    old_mask=ndi.binary_dilation(old_polygon & (gray<245),iterations=1) & ndi.binary_dilation(old_polygon,iterations=1)
    details={'method':'complete_seeded_ink_components_v2',
             'accepted_components':int(len(accepted_ids)),
             'rejected_artwork_components':int(len(strong_rejected_ids)),
             'ignored_weak_artwork_components':int(ignored_weak_artwork),
             'foreground_pixels_previously_unmasked':int(np.count_nonzero(component & ~old_mask)),
             'remaining_selected_foreground_pixels':int(np.count_nonzero(component & ~mask)),
             'safe':bool(len(accepted_ids)>0 and len(strong_rejected_ids)==0)}
    return mask, white_fraction, details

def white_interior(clean, segment, erase_mask, all_segments):
    x0,y0,x1,y1 = segment['placement_box']
    x0,y0 = max(0,x0),max(0,y0)
    x1,y1 = min(clean.shape[1],x1),min(clean.shape[0],y1)
    bounds = [x0,y0,x1,y1]
    gray = np.asarray(Image.fromarray(clean[y0:y1,x0:x1]).convert('L'))
    white = gray >= 235
    labels, count = ndi.label(white)
    # Seed from the erased glyph pixels: these belong to the text's background.
    seeds = erase_mask[y0:y1,x0:x1]
    ids, counts = np.unique(labels[seeds & white], return_counts=True)
    ids, counts = ids[ids != 0], counts[ids != 0]
    if not len(ids):
        raise ValueError('No white background connected to the source text')
    component = labels == ids[np.argmax(counts)]
    safe = ndi.binary_erosion(component, iterations=6, border_value=0)
    # Overlapping detections must not borrow a neighbour's original text area.
    for other in all_segments:
        if other['id'] == segment['id']:
            continue
        a,b,c,d = map(int, other['word_box'])
        a,b,c,d = max(x0,a-8),max(y0,b-8),min(x1,c+8),min(y1,d+8)
        if a<c and b<d:
            safe[b-y0:d-y0,a-x0:c-x0] = False
    return safe, bounds

def break_points(text):
    points = {0:False,len(text):False}
    for match in re.finditer(r'\S+', text):
        start,end = match.span()
        if start:
            points[start] = False
        token = match.group()
        for hyphen in re.finditer('-',token):
            if 0<hyphen.start()<len(token)-1:
                points[start+hyphen.end()] = False
        # Preserve names from the fixed glossary and do not split punctuation.
        if any(part.strip('.,!?…»«') in {'CROW','HORNET','ARES','DRAGON','TAIL','OLDENSERAFIA','SENPAI','HARUKI','TSUKINO','YUZUKI','SODANSHA'} for part in token.split('-')):
            continue
        for position in HYPHENATOR.positions(token):
            if position >= 3 and len(token)-position >= 3:
                points[start+position] = True
    return sorted(points.items())

def fit_lines(text, capacities, font, width_scale=WIDTH_SCALE):
    points = break_points(text)
    @lru_cache(None)
    def solve(line, start_index):
        start = points[start_index][0]
        if line == len(capacities):
            return (0, []) if start == len(text) else None
        best = None
        for stop_index in range(start_index+1,len(points)):
            stop, hyphen = points[stop_index]
            part = text[start:stop].strip() + ('-' if hyphen else '')
            bb = font.getbbox(part)
            width = math.ceil((bb[2]-bb[0]+4)*width_scale)
            if width > capacities[line]:
                break
            if not part:
                continue
            rest = solve(line+1, stop_index)
            if rest is None:
                continue
            cost = ((capacities[line]-width)/max(capacities[line],1))**2 + (2.5 if hyphen else 0)
            proposal = (rest[0]+cost, [part]+rest[1])
            if best is None or proposal[0] < best[0]:
                best = proposal
        return best
    return solve(0,0)

def longest_run(row, target):
    changes = np.diff(np.r_[False,row,False].astype(np.int8))
    candidates = [(a,b) for a,b in zip(np.where(changes==1)[0],np.where(changes==-1)[0]) if b-a>=12]
    if not candidates:
        return None
    return min(candidates, key=lambda ab: max(ab[0]-target, target-ab[1], 0)*3 - (ab[1]-ab[0])*0.1)

def layout(text, safe, bounds, segment, words, *, width_scale=WIDTH_SCALE, tight=False, font_path=None):
    x0,y0,x1,y1 = bounds
    a,b,c,d = segment['word_box']
    cx,cy = (a+c)/2-x0,(b+d)/2-y0
    heights = [np.linalg.norm(np.subtract(vertices(w)[3],vertices(w)[0])) for w in words]
    preferred = max(18,min(44,round(np.median(heights)*1.3)))
    h,w = safe.shape
    hyphenated_fallback = None
    for size in range(preferred,11,-1):
        if hyphenated_fallback is not None and size < max(12,round(preferred*.75)):
            return hyphenated_fallback
        font = ImageFont.truetype(str(font_path or FONT),size)
        glyph_box = font.getbbox('ÄÖÜÉJQ…,!?')
        glyph_height = glyph_box[3]-glyph_box[1]
        step = glyph_height + max(2 if tight else 3,round(size*(0.12 if tight else 0.2)))
        best = None
        for nlines in range(1,min(17,h//step+1)):
            height = nlines*step - (step-glyph_height)
            for dy in ((0,)+tuple(d for k in range(2,33,2) for d in (-k,k)) if tight else (0,-8,8,-16,16)):
                top = round(cy-height/2+dy)
                if top < 0 or top+height>h:
                    continue
                intervals = []
                for k in range(nlines):
                    yy = top+k*step
                    run = longest_run(safe[yy:yy+glyph_height].all(axis=0),cx)
                    if run is None:
                        break
                    intervals.append(run)
                if len(intervals) != nlines:
                    continue
                result = fit_lines(text, tuple(q-p for p,q in intervals),font,width_scale=width_scale)
                if result is None:
                    continue
                cost, lines = result
                cost += abs(dy)*0.01 + nlines*0.025
                if best is None or cost<best[0]:
                    best=(cost,lines,intervals,top,step,glyph_box)
        if best:
            _,lines,intervals,top,step,glyph_box=best
            layer = Image.new('L',(w,h))
            placements=[]
            for k,(line,(left,right)) in enumerate(zip(lines,intervals)):
                bb=font.getbbox(line)
                tile=Image.new('L',(bb[2]-bb[0]+4,glyph_height))
                ImageDraw.Draw(tile).text((2-bb[0],-glyph_box[1]),line,font=font,fill=255)
                tile=tile.resize((math.ceil(tile.width*width_scale),tile.height),Image.Resampling.LANCZOS)
                xx=max(left,min(round(cx-tile.width/2),right-tile.width))
                yy=top+k*step
                layer.paste(tile,(xx,yy))
                placements.append({'text':line,'xy':[int(x0+xx),int(y0+yy)]})
            # Antialiasing gets a one-pixel safety allowance, no glyph clipping.
            outside=(np.asarray(layer)>0) & ~ndi.binary_dilation(safe,iterations=1)
            if outside.any():
                continue
            proposal = (layer, {'font_size':size,'preferred_font_size':preferred,'width_scale':width_scale,
                               'tight_spacing':tight,'font_file':Path(font_path or FONT).name,
                               'lines':placements,'angle':0,'status':'ok','out_of_interior_pixels':int(outside.sum())})
            if any(line.endswith('-') for line in lines):
                if hyphenated_fallback is None:
                    hyphenated_fallback = proposal
                continue
            return proposal
    if hyphenated_fallback is not None:
        return hyphenated_fallback
    raise ValueError('No readable layout found at font size >= 12 px')

def rotated_layout(text, segment, words, size):
    vectors=[np.subtract(vertices(w)[1],vertices(w)[0]) for w in words]
    vx,vy=np.sum(vectors,axis=0)
    angle=math.degrees(math.atan2(vy,vx))
    a,b,c,d=map(int,segment['word_box'])
    width,height=c-a+6,d-b+6
    for fs in range(30,11,-1):
        font=ImageFont.truetype(str(FONT),fs)
        for n in range(1,5):
            for capacity in range(width, max(45,width-50), -8):
                fit=fit_lines(text,tuple([capacity]*n),font)
                if fit is None:
                    continue
                lines=fit[1]
                bbox=font.getbbox('ÄÖÜJQ…')
                gh=bbox[3]-bbox[1]; step=gh+4
                tile=Image.new('L',(capacity,n*step-4))
                draw=ImageDraw.Draw(tile)
                for k,line in enumerate(lines):
                    linebox=font.getbbox(line)
                    raw=Image.new('L',(linebox[2]-linebox[0]+4,gh))
                    ImageDraw.Draw(raw).text((2-linebox[0],-bbox[1]),line,font=font,fill=255)
                    raw=raw.resize((math.ceil(raw.width*WIDTH_SCALE),gh),Image.Resampling.LANCZOS)
                    tile.paste(raw,((capacity-raw.width)//2,k*step))
                tile=tile.crop(tile.getbbox()).rotate(-angle,resample=Image.Resampling.BICUBIC,expand=True)
                if tile.width<=width and tile.height<=height:
                    layer=Image.new('L',size)
                    xy=(round((a+c-tile.width)/2),round((b+d-tile.height)/2))
                    layer.paste(tile,xy)
                    return layer, {'font_size':fs,'width_scale':WIDTH_SCALE,'lines':lines,'angle':round(angle,2),
                                   'xy':list(xy),'status':'ok','background_method':'Telea_inpainting'}
    raise ValueError('Rotated text does not fit')
