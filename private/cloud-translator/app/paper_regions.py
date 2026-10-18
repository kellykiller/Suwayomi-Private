"""Local illumination analysis and bounded RGB paper repair; no model/network calls.

Only the analysis image is normalized. Output pixels retain original paper tone.
Closed interiors are evidence for grouping, never permission to erase artwork.
"""
import math
import cv2
import numpy as np
from scipy import ndimage as ndi
from PIL import Image
from balloon_cleanup import polygon_mask


def illumination(gray):
    smooth = cv2.GaussianBlur(gray, (3, 3), .65)
    # Closing estimates the nearby paper level across thin letters. The
    # difference retains outlines on shaded paper without whitening the output.
    background = cv2.morphologyEx(smooth, cv2.MORPH_CLOSE, np.ones((31, 31), 'uint8'))
    return smooth, background


def closed_light_regions(gray):
    height, width = gray.shape
    if np.percentile(gray,85) >= 250:
        # Preserve established segmentation for clean digital white pages.
        light = gray >= 235
    else:
        smooth, background = illumination(gray)
        light = (smooth >= 150) & (smooth.astype('float32') >= background.astype('float32') - 35)
    light = cv2.erode(light.astype('uint8'), np.ones((3, 3), 'uint8'), iterations=1)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(light, connectivity=8)
    candidates = {}
    for label, (x, y, w, h, area) in enumerate(stats):
        if label == 0 or min(w, h) < 18 or area < 180 or area > width * height * .18:
            continue
        if x <= 1 or y <= 1 or x+w >= width-1 or y+h >= height-1:
            continue
        if area / max(1, w*h) < .25:
            continue
        candidates[label] = [int(x), int(y), int(x+w), int(y+h)]
    return labels, candidates


def container_for_boxes(boxes, labels, candidates):
    height, width = labels.shape
    chosen = []
    for a, b, c, d in boxes:
        a = max(0, math.floor(a)-1); b = max(0, math.floor(b)-1)
        c = min(width, math.ceil(c)+1); d = min(height, math.ceil(d)+1)
        labs, counts = np.unique(labels[b:d, a:c], return_counts=True)
        options = sorted(((int(n), int(lab)) for lab, n in zip(labs, counts) if lab in candidates), reverse=True)
        if not options:
            return None
        count, label = options[0]
        nonzero = sum(int(n) for lab, n in zip(labs, counts) if lab != 0)
        if count < max(3, nonzero * .6):
            return None
        chosen.append(label)
    return chosen[0] if chosen and len(set(chosen)) == 1 else None


class PaperRecovery:
    def __init__(self, image, segments, words):
        self.image = image
        self.rgb = np.asarray(image.convert('RGB'))
        self.gray = np.asarray(image.convert('L'))
        self.labels, self.regions = closed_light_regions(self.gray)
        self.segments = segments
        self.words = words
        _, self.background = illumination(self.gray)
        ink = (self.gray.astype('float32') < self.background.astype('float32')-30) & (self.gray < 200)
        self.ink_labels, _ = ndi.label(ink, structure=np.ones((3, 3)))
        self.foreign_masks = {}
        self.all_text = np.zeros(self.gray.shape, bool)
        for segment in segments:
            selected = [words[i] for i in segment['source_word_ids']]
            mask = polygon_mask(image.size, selected, padding=3)
            self.foreign_masks[segment['id']] = mask
            self.all_text |= mask

    def prepare(self, segment, additional_mask=None):
        selected = [self.words[i] for i in segment['source_word_ids']]
        boxes = []
        allowed = np.zeros(self.gray.shape, bool)
        for word in selected:
            pts = word['boundingBox']['vertices']
            x = [p.get('x', 0) for p in pts]; y = [p.get('y', 0) for p in pts]
            a, b, c, d = min(x), min(y), max(x), max(y)
            boxes.append([a, b, c, d])
            margin = max(6, min(24, round((d-b)*.3)))
            allowed[max(0,b-margin):d+margin+1, max(0,a-margin):c+margin+1] = True
        label = container_for_boxes(boxes, self.labels, self.regions)
        if label is None:
            raise ValueError('Keine gemeinsame geschlossene helle Papierflaeche.')
        component = self.labels == label
        # This path is for scanned paper. Keep the existing white-balloon path
        # for digital whites and the conservative raster repair for dark tones.
        samples = component & ~self.all_text
        if samples.sum() < 100:
            raise ValueError('Zu wenig unbedrucktes Papier fuer lokale Retusche.')
        values = self.gray[samples]
        if np.median(values) < 175 or np.mean(values >= 248) >= .9:
            raise ValueError('Keine ungleichmaessige helle Papierflaeche.')
        polygons = polygon_mask(self.image.size, selected)
        seeds = ndi.binary_erosion(polygons) & (self.ink_labels > 0)
        ids = np.unique(self.ink_labels[seeds]); ids = ids[ids != 0]
        rejected = np.unique(self.ink_labels[~allowed]); ids = ids[~np.isin(ids, rejected)]
        mask = np.isin(self.ink_labels, ids)
        if mask.sum() < 3:
            raise ValueError('Keine sicher abgegrenzten Schriftpixel auf dem Papier.')
        # Any substantive ink crossing the bounded neighbourhood is protected.
        if np.count_nonzero(seeds & ~mask) > max(3, np.count_nonzero(seeds)*.03):
            raise ValueError('Schrift beruehrt Zeichnung oder Blasenrand; Retusche zurueckgestellt.')
        mask = ndi.binary_dilation(mask, iterations=2) & allowed
        # Letter strokes create holes *inside* the light component. Those holes
        # are not evidence that the source crosses the enclosing contour.
        boundary = ndi.binary_dilation(ndi.binary_fill_holes(component), iterations=1)
        if additional_mask is not None:
            # Extra ink has already been bounded/protected by the caller after
            # image-verified transcription. Keep it inside this same contour.
            mask |= additional_mask & boundary
        if np.count_nonzero(mask & ~boundary) > max(5, mask.sum()*.03):
            raise ValueError('Schriftmaske verlaesst die erkannte Papierflaeche.')
        mask &= boundary
        safe = ndi.binary_closing(component | mask, structure=np.ones((3,3)))
        for other in self.segments:
            if other['id'] != segment['id']:
                foreign = self.foreign_masks[other['id']]
                mask &= ~foreign; safe &= ~foreign
        safe = ndi.binary_erosion(safe, iterations=3)
        a, b, c, d = self.regions[label]
        # Repair only glyph-sized holes, in RGB. Local paper samples restore
        # fine variation after inpainting; no solid gray/white word rectangles.
        replacement = self.repair(mask, samples)
        return mask, replacement, safe[b:d, a:c], [a,b,c,d], {'method':'local_rgb_paper_texture'}

    def repair(self, mask, samples):
        ys, xs = np.where(mask)
        a=max(0,int(xs.min())-32);b=max(0,int(ys.min())-32)
        c=min(self.gray.shape[1],int(xs.max())+33);d=min(self.gray.shape[0],int(ys.max())+33)
        crop = self.rgb[b:d,a:c]
        local_mask = mask[b:d,a:c]
        repaired = cv2.inpaint(crop, local_mask.astype('uint8')*255, 3, cv2.INPAINT_TELEA).astype('float32')
        valid = samples[b:d,a:c] & ~ndi.binary_dilation(local_mask, iterations=2)
        # Select texture only from actual nearby unprinted paper. Keep the RGB
        # channels coupled so paper tint is preserved; deterministic per page.
        clean = self.rgb[b:d,a:c].astype('float32')
        low = cv2.GaussianBlur(clean, (0,0), 1.2)
        texture = (clean-low)[valid]
        if len(texture) >= 32:
            # Limit outliers from imperfect contours. No raster/linework donor.
            amplitudes = np.max(np.abs(texture),axis=1)
            texture = texture[amplitudes <= min(12,float(np.percentile(amplitudes,90)))]
            if len(texture) >= 16:
                indices = (ys*73856093 + xs*19349663) % len(texture)
                residual = texture[indices]-texture.mean(axis=0)
                repaired[local_mask] += residual
        output = self.rgb.copy()
        output[b:d,a:c][local_mask] = np.clip(repaired[local_mask],0,255).astype('uint8')
        return output
