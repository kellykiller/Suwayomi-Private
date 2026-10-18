"""Offline smoke test for the actual container dependency/font installation."""
from pathlib import Path
import argparse
import json
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'app'))
import cv2
cv2.setNumThreads(1)
cv2.ocl.setUseOpenCL(False)
from PIL import Image, ImageFont
from pipeline import run
from services import save, filehash
from prepare import collect
sys.path.insert(0, str(ROOT/'server'))
from jobs import validate_cbz


def main():
    for name in ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']:
        ImageFont.truetype(str(ROOT/'app/font'/name), 16)
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        source = folder/'input'
        source.mkdir()
        Image.new('RGB', (120, 100), 'white').save(source/'0001.png')
        seed = folder/'seed'
        save(seed/'ocr'/f'{filehash(source/"0001.png")}.json', {'responses': [{}]})
        save(seed/'offline-drafts.json', {'translations': {}})
        args = argparse.Namespace(input=source, output=folder/'output', seed=seed, live=False,
                                  plan=False, workers=1, batch_size=60, model='gpt-6-astra', max_openai=1, max_google=1)
        result = run(args)
        assert result['status'] == 'completed'
        assert result['new_api_calls'] == {'google': 0, 'openai': 0}
        with zipfile.ZipFile(folder/'output/kapitel-de.cbz') as z:
            assert z.namelist() == ['0001.png'] and z.testzip() is None
        avif = folder/'page.avif'
        Image.new('RGB', (120, 100), (242, 232, 210)).save(avif, 'AVIF')
        archive = folder/'avif.cbz'
        with zipfile.ZipFile(archive, 'w') as z:
            z.write(avif, '0001.avif')
        assert validate_cbz(archive) == 1
        pages = collect(archive, folder/'avif-precheck')
        assert Path(pages[0]['path']).suffix == '.png'
        save(seed/'ocr'/f'{pages[0]["sha256"]}.json', {'responses': [{}]})
        args.input, args.output = archive, folder/'avif-output'
        result = run(args)
        assert result['status'] == 'completed'
        assert result['new_api_calls'] == {'google': 0, 'openai': 0}
        with Image.open(avif) as original, Image.open(args.output/'seiten/0001.png') as output:
            assert original.size == output.size
            assert original.convert('RGB').tobytes() == output.convert('RGB').tobytes()
        with zipfile.ZipFile(args.output/'kapitel-de.cbz') as z:
            assert z.namelist() == ['0001.png'] and z.testzip() is None
        mixed = folder/'formats'
        mixed.mkdir()
        image = Image.new('RGB', (64, 64), 'white')
        formats = [('jpg', 'JPEG'), ('png', 'PNG'), ('bmp', 'BMP'), ('tiff', 'TIFF'),
                   ('gif', 'GIF'), ('heic', 'HEIF'), ('avif', 'AVIF'), ('webp', 'WEBP'),
                   ('jp2', 'JPEG2000'), ('tga', 'TGA'), ('pcx', 'PCX'), ('ico', 'ICO'), ('ppm', 'PPM')]
        for index, (suffix, format) in enumerate(formats, 1):
            image.save(mixed/f'{index:04d}.{suffix}', format)
        for index, format in [(14, 'TIFF'), (15, 'PDF')]:
            image.save(mixed/f'{index:04d}.{format.lower()}', format, save_all=True,
                       append_images=[Image.new('RGB', (64, 64), (232, 242, 250))], resolution=72)
        source = folder/'formats.cbz'
        with zipfile.ZipFile(source, 'w') as z:
            for file in sorted(mixed.iterdir()):
                z.write(file, file.name)
        assert validate_cbz(source) == 17
        pages = collect(source, folder/'formats-precheck')
        for page in pages:
            save(seed/'ocr'/f'{page["sha256"]}.json', {'responses': [{}]})
        args.input, args.output = source, folder/'formats-output'
        result = run(args)
        assert result['status'] == 'completed'
        assert result['new_api_calls'] == {'google': 0, 'openai': 0}
        with zipfile.ZipFile(args.output/'kapitel-de.cbz') as z:
            assert z.namelist() == [f'{n:04d}.png' for n in range(1, 18)] and z.testzip() is None
    print(json.dumps({'offline_selftest': 'ok', 'avif_normalization': 'ok', 'image_formats': 'ok',
                      'heic': 'ok', 'pdf': 'ok', 'multipage_documents': 'ok',
                      'google_requests': 0, 'openai_requests': 0}))


if __name__ == '__main__':
    main()
