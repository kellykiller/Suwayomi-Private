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
