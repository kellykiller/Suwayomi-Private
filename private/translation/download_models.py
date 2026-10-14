# SPDX-License-Identifier: MPL-2.0
"""Build-time model installation. Runtime workers have NO network or API credentials."""
import os
from pathlib import Path

import easyocr
import torch
from huggingface_hub import snapshot_download

ROOT = Path('/opt/ocr-models')
torch.set_num_threads(2)
ROOT.mkdir(parents=True, exist_ok=True)
snapshot_download(
    'kha-white/manga-ocr-base',
    revision='aa6573bd10b0d446cbf622e29c3e084914df9741',
    local_dir=ROOT / 'manga-ocr',
    allow_patterns=['*.json', 'vocab.txt', 'pytorch_model.bin', 'README.md'],
)
easyocr.Reader(['en'], gpu=False, model_storage_directory=str(ROOT / 'easyocr'),
               user_network_directory='/tmp/easyocr-user', verbose=False)
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
from manga_ocr import MangaOcr
MangaOcr(str(ROOT / 'manga-ocr'), force_cpu=True)
print('Japanese manga-ocr and English EasyOCR/CRAFT models verified on CPU.')
