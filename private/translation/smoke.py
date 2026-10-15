# SPDX-License-Identifier: MPL-2.0
"""Run inside the actual built image, with --network none; never calls OpenAI."""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['EASYOCR_MODULE_PATH'] = '/tmp/easyocr'
import torch
import cv2
threads = int(os.environ.get('OCR_THREADS', '4'))
torch.set_num_threads(threads)
cv2.setNumThreads(threads)
import easyocr
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from manga_ocr import MangaOcr

image = Image.new('RGB', (800, 230), 'white')
ImageDraw.Draw(image).text((30, 60), 'HELLO MY FRIEND', fill='black',
                          font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 46))
reader = easyocr.Reader(['en'], gpu=False, model_storage_directory='/opt/ocr-models/easyocr',
                        user_network_directory='/tmp/easyocr-user', download_enabled=False, verbose=False)
result = ' '.join(reader.readtext(np.asarray(image), detail=0))
assert 'HELLO' in result.upper() and 'FRIEND' in result.upper(), result
# MangaOcr initialization reads its packaged example and exercises the Japanese model.
MangaOcr('/opt/ocr-models/manga-ocr', force_cpu=True)
print('Offline CPU smoke test passed: English detection + OCR, Japanese manga-ocr model.')

# Exercise the actual CPU OCR/checkpoint/pause/resume pipeline under worker isolation.
import gc
import io
import json
from pathlib import Path
import tempfile
import zipfile
import worker

del reader
gc.collect()
with tempfile.TemporaryDirectory(prefix='ocr-resume-') as folder:
    root = Path(folder)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    with zipfile.ZipFile(root / 'input.cbz', 'w') as archive:
        archive.writestr('001.png', buffer.getvalue())
        archive.writestr('002.png', buffer.getvalue())
    original_checkpoint = worker.checkpoint_page
    def checkpoint_and_pause(target, page, language):
        original_checkpoint(target, page, language)
        if page['index'] == 0:
            (target / 'pause.requested').write_text('pause')
    worker.checkpoint_page = checkpoint_and_pause
    try:
        worker.analyze(root, {'sourceLanguage': 'en', 'threads': threads})
        raise AssertionError('Worker did not pause between pages')
    except worker.PauseRequested:
        assert (root / 'ocr-checkpoints/0000.json').exists()
        assert not (root / 'ocr-checkpoints/0001.json').exists()
    finally:
        worker.checkpoint_page = original_checkpoint
    (root / 'pause.requested').unlink()
    resumed = worker.analyze(root, {'sourceLanguage': 'en', 'threads': threads})
    progress = json.loads((root / 'progress.json').read_text())
    assert progress['restoredPages'] == 1 and progress['completed'] == 2
    assert 'HELLO' in ' '.join(block['text'] for block in resumed['pages'][0]['blocks']).upper()
    print('Actual offline OCR pause/resume smoke test passed: saved first page reused.')

    # Exercise the production renderer with its default font (no test font override).
    original = (root / 'original/0000.png').read_bytes()
    resumed['pages'][0]['blocks'] = [{'id': 'p0b0', 'box': [20, 40, 650, 145],
        'text': 'HELLO MY FRIEND', 'translated': 'Grüße, mein Freund!', 'confidence': 1.0,
        'note': '', 'rendered': False, 'reviewed': True}]
    resumed['pages'][0]['translationComplete'] = True
    worker.write_json(root / 'content.json', resumed)
    rendered = worker.render(root, {})
    assert rendered['pages'][0]['blocks'][0]['rendered'], rendered['pages'][0]['warnings']
    assert rendered['pages'][0]['renderComplete']
    assert not rendered['pages'][1].get('translationComplete')
    assert not (root / 'translated/0001.png').exists()
    assert (root / 'original/0000.png').read_bytes() == original
    assert (root / 'translated/0000.png').read_bytes() != original
    modified = (root / 'translated/0000.png').stat().st_mtime_ns
    worker.render(root, {})
    assert (root / 'translated/0000.png').stat().st_mtime_ns == modified
    print('Actual default-font rendering smoke test passed: German text set on page 1 only; original and cached output retained.')
