"""Exercise actual decoders and document pagination without cloud providers."""
import argparse
import base64
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
import uuid
import zipfile

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'app'))
sys.path.insert(0, str(ROOT/'server'))
from image_input import inspect as inspect_input, InputError, pages as input_pages
from prepare import collect
from pipeline import run
from jobs import Jobs, Problem


def raster(format, mode='RGB'):
    image = Image.new(mode, (64, 64), 'white')
    ImageDraw.Draw(image).rectangle((15, 15, 40, 40), fill='black')
    output = io.BytesIO()
    image.save(output, format)
    return output.getvalue()


def document(format):
    output = io.BytesIO()
    first = Image.new('RGB', (72, 108), 'white')
    ImageDraw.Draw(first).rectangle((12, 16, 50, 50), fill='black')
    second = Image.new('RGB', (108, 72), (200, 220, 240))
    first.save(output, format, save_all=True, append_images=[second], resolution=72)
    return output.getvalue()


def archive(path, entries):
    with zipfile.ZipFile(path, 'w') as z:
        for name, data in entries:
            z.writestr(name, data)
    return path


class FormatTests(unittest.TestCase):
    def test_every_listed_raster_extension_uses_a_real_decoder(self):
        formats = [('jpg', 'JPEG'), ('jpeg', 'JPEG'), ('jpe', 'JPEG'), ('jfif', 'JPEG'),
                   ('png', 'PNG'), ('webp', 'WEBP'), ('avif', 'AVIF'), ('bmp', 'BMP'), ('dib', 'DIB'),
                   ('tif', 'TIFF'), ('tiff', 'TIFF'), ('gif', 'GIF'), ('giff', 'GIF'),
                   ('heic', 'HEIF'), ('heif', 'HEIF'), ('hif', 'HEIF'),
                   ('jp2', 'JPEG2000'), ('j2k', 'JPEG2000'), ('jpf', 'JPEG2000'), ('jpx', 'JPEG2000'),
                   ('ppm', 'PPM'), ('pgm', 'PPM'), ('pbm', 'PPM'), ('pnm', 'PPM'),
                   ('tga', 'TGA'), ('pcx', 'PCX'), ('ico', 'ICO')]
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            encoded = {}
            for suffix, format in formats:
                with self.subTest(suffix=suffix):
                    mode = '1' if suffix == 'pbm' else 'L' if suffix == 'pgm' else 'RGB'
                    key = format, mode
                    if key not in encoded:
                        encoded[key] = raster(format, mode)
                    path = folder/f'page.{suffix}'
                    path.write_bytes(encoded[key])
                    self.assertEqual(inspect_input(path)['pages'], 1)
                    pages = collect(path, folder/f'out-{suffix}')
                    self.assertEqual(pages[0]['size'], [64, 64])
                    with Image.open(pages[0]['path']) as image:
                        image.load()
                        self.assertIn(image.format, {'PNG', 'JPEG', 'WEBP'})
                    self.assertEqual(path.read_bytes(), encoded[key])

    def test_pdf_and_tiff_expand_in_order_with_a_source_page_mapping(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = archive(folder/'chapter.cbz', [('10.pdf', document('PDF')),
                                                    ('2.bmp', raster('BMP')), ('3.tiff', document('TIFF'))])
            info = inspect_input(source)
            self.assertEqual(info, {'pages': 5, 'source_entries': 3, 'page_map': [0, 1, 1, 2, 2]})
            pages = collect(source, folder/'out')
            self.assertEqual([p['source_name'] for p in pages],
                             ['2.bmp', '3.tiff#page=0001', '3.tiff#page=0002', '10.pdf#page=0001', '10.pdf#page=0002'])
            self.assertEqual([p['size'] for p in pages[:3]], [[64, 64], [72, 108], [108, 72]])
            self.assertEqual(pages[3]['size'][0], 300)
            self.assertLessEqual(abs(pages[3]['size'][1]-450), 1)
            self.assertEqual(pages[4]['size'][1], 300)
            self.assertLessEqual(abs(pages[4]['size'][0]-450), 1)
            before = [Path(p['path']).read_bytes() for p in pages]
            self.assertEqual(pages, collect(source, folder/'out'))
            self.assertEqual(before, [Path(p['path']).read_bytes() for p in pages])

    def test_pdf_is_detected_by_content_in_an_http_upload_with_a_cbz_temp_name(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'source.cbz'
            path.write_bytes(document('PDF'))
            self.assertEqual(inspect_input(path)['pages'], 2)

    def test_animation_uses_only_the_first_complete_frame(self):
        for format, suffix in [('GIF', 'gif'), ('WEBP', 'webp'), ('AVIF', 'avif'), ('PNG', 'png')]:
            with self.subTest(format=format), tempfile.TemporaryDirectory() as folder:
                folder = Path(folder)
                first = Image.new('RGB', (40, 50), 'white')
                stream = io.BytesIO()
                first.save(stream, format, save_all=True, append_images=[Image.new('RGB', (40, 50), 'black')], duration=100)
                source = folder/f'animation.{suffix}'
                source.write_bytes(stream.getvalue())
                self.assertEqual(inspect_input(source)['pages'], 1)
                result = collect(source, folder/'out')
                with Image.open(result[0]['path']) as image:
                    self.assertGreater(sum(image.convert('RGB').getpixel((20, 25))), 700)

    def test_multi_image_heif_keeps_each_main_image_as_a_page(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            path = folder/'collection.heic'
            Image.new('RGB', (64, 64), 'white').save(path, 'HEIF', save_all=True,
                append_images=[Image.new('RGB', (64, 64), 'black')])
            self.assertEqual(inspect_input(path), {'pages': 2, 'source_entries': 1, 'page_map': [0, 0]})
            result = collect(path, folder/'out')
            self.assertEqual(len(result), 2)

    def test_16bit_tiff_retains_dark_midgray_and_white_tones_for_ocr(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = folder/'grayscale.tiff'
            Image.fromarray(np.array([[0, 32768, 65535]], dtype='uint16')).save(source, 'TIFF')
            pages = collect(source, folder/'out')
            with Image.open(pages[0]['path']) as image:
                self.assertEqual(list(image.convert('L').tobytes()), [0, 128, 255])

    def test_page_limit_applies_after_document_expansion_and_unknown_pages_are_not_dropped(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            path = folder/'too-many.tiff'
            Image.new('RGB', (4, 4), 'white').save(path, 'TIFF', save_all=True,
                append_images=[Image.new('RGB', (4, 4), 'white') for _ in range(100)])
            with self.assertRaises(InputError):
                inspect_input(path)
            source = archive(folder/'unknown.cbz', [('1.png', raster('PNG')), ('2.unsupported', b'page')])
            with self.assertRaises(InputError):
                inspect_input(source)

    def test_bad_last_document_cannot_start_a_job_or_cloud_request(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            secrets = folder/'secrets'
            secrets.mkdir()
            for name in ['google.key', 'openai.key']:
                (secrets/name).write_text('fake-key')
            source = archive(folder/'bad.cbz', [('1.bmp', raster('BMP')), ('2.pdf', b'%PDF-1.7\nbroken')])
            runner = Mock()
            jobs = Jobs(folder/'data', secrets, runner=runner)
            try:
                with self.assertRaises(Problem) as ctx:
                    jobs.submit(str(uuid.uuid4()), source)
                self.assertEqual(ctx.exception.code, 400)
                self.assertEqual(jobs.list(), [])
                runner.assert_not_called()
            finally:
                jobs.close()

    def test_document_job_budget_and_metadata_count_expanded_pages(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            secrets = folder/'secrets';secrets.mkdir()
            for name in ['google.key', 'openai.key']:
                (secrets/name).write_text('fake-key')
            source = folder/'upload.cbz';source.write_bytes(document('PDF'))
            jobs = Jobs(folder/'data', secrets, runner=Mock(return_value='completed'))
            try:
                state, created = jobs.submit(str(uuid.uuid4()), source)
                self.assertTrue(created)
                self.assertEqual((state['pages'], state['source_entries'], state['max_google']), (2, 1, 2))
                self.assertEqual(state['page_map'], [0, 0])
            finally:
                jobs.close()

    def test_pdf_and_tiff_can_finish_with_png_ocr_payloads_then_resume_from_cache(self):
        for format in ['PDF', 'TIFF']:
            with self.subTest(format=format), tempfile.TemporaryDirectory() as folder:
                folder = Path(folder)
                source = folder/f'input.{format.lower()}'
                source.write_bytes(document(format))
                original = source.read_bytes()
                calls = []
                def transport(service, payload):
                    calls.append(service)
                    self.assertEqual(service, 'google')
                    data = base64.b64decode(payload['requests'][0]['image']['content'])
                    self.assertTrue(data.startswith(b'\x89PNG\r\n\x1a\n'))
                    return {'responses': [{}]}
                args = argparse.Namespace(input=source, output=folder/'out', seed=folder/'seed',
                    live=True, model='gpt-6-astra', max_openai=1, max_google=2, plan=False, workers=1, batch_size=60)
                result = run(args, transport=transport)
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(calls, ['google', 'google'])
                self.assertEqual(result['completed_pages'], 2)
                again = run(args, transport=Mock(side_effect=AssertionError('Unexpected API call')))
                self.assertEqual(again['new_api_calls'], {'google': 0, 'openai': 0})
                self.assertEqual(original, source.read_bytes())
                with zipfile.ZipFile(args.output/'kapitel-de.cbz') as z:
                    self.assertEqual(z.namelist(), ['0001.png', '0002.png'])


if __name__ == '__main__':
    unittest.main()
