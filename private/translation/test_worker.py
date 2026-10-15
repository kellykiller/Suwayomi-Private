# SPDX-License-Identifier: MPL-2.0
import io
import json
import sys
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

from PIL import Image, ImageDraw, ImageFont
from worker import extract, safe_entries, fit_text, group_boxes, render_page, analyze, render, PauseRequested, restore_page

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


def image_bytes(color='white'):
    output = io.BytesIO()
    Image.new('RGB', (100, 200), color).save(output, format='PNG')
    return output.getvalue()


class WorkerTests(unittest.TestCase):
    def test_ocr_applies_configured_threads_and_publishes_partial_counts_before_finishing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with zipfile.ZipFile(root / 'input.cbz', 'w') as archive:
                archive.writestr('001.png', image_bytes())
                archive.writestr('002.png', image_bytes())
            seen_threads = []
            seen_progress = []
            def readtext(_image, **_kwargs):
                if (root / 'progress.json').exists():
                    seen_progress.append(json.loads((root / 'progress.json').read_text()))
                return [([[10, 10], [80, 10], [80, 30], [10, 30]], 'HELLO', 0.99)]
            modules = {
                'torch': SimpleNamespace(set_num_threads=lambda value: seen_threads.append(value)),
                'cv2': SimpleNamespace(setNumThreads=lambda value: seen_threads.append(value)),
                'easyocr': SimpleNamespace(Reader=lambda *args, **kwargs: SimpleNamespace(readtext=readtext)),
            }
            with patch.dict(sys.modules, modules):
                result = analyze(root, {'sourceLanguage': 'en', 'threads': 4})
            self.assertEqual(seen_threads, [4, 4])
            self.assertEqual(seen_progress[-1]['completed'], 1)
            self.assertEqual(seen_progress[-1]['blockCount'], 1)
            self.assertGreaterEqual(seen_progress[-1]['lastPageSeconds'], 0)
            final = json.loads((root / 'progress.json').read_text())
            self.assertEqual(final['blockCount'], 2)
            self.assertEqual(len(result['pages']), 2)

    def test_ocr_pause_and_process_failure_reuse_only_committed_matching_pages(self):
        for interruption in ['pause', 'crash']:
            with self.subTest(interruption=interruption), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                with zipfile.ZipFile(root / 'input.cbz', 'w') as archive:
                    archive.writestr('001.png', image_bytes())
                    archive.writestr('002.png', image_bytes('red'))
                calls = []
                def readtext(_image, **kwargs):
                    calls.append(1)
                    if interruption == 'pause' and len(calls) == 1:
                        (root / 'pause.requested').write_text('pause')
                    if interruption == 'crash' and len(calls) == 2:
                        raise RuntimeError('simulated process failure')
                    return [([[10, 10], [80, 10], [80, 30], [10, 30]], 'HELLO', 0.99)]
                modules = {
                    'torch': SimpleNamespace(set_num_threads=lambda value: None),
                    'cv2': SimpleNamespace(setNumThreads=lambda value: None),
                    'easyocr': SimpleNamespace(Reader=lambda *args, **kwargs: SimpleNamespace(readtext=readtext)),
                }
                with patch.dict(sys.modules, modules):
                    with self.assertRaises(PauseRequested if interruption == 'pause' else RuntimeError):
                        analyze(root, {'sourceLanguage': 'en', 'threads': 4})
                    self.assertTrue((root / 'ocr-checkpoints/0000.json').exists())
                    self.assertFalse((root / 'ocr-checkpoints/0001.json').exists())
                    (root / 'pause.requested').unlink(missing_ok=True)
                    resumed_calls = []
                    def resumed_read(*args, **kwargs):
                        resumed_calls.append(1)
                        return [([[10, 10], [80, 10], [80, 30], [10, 30]], 'SECOND', 0.99)]
                    modules['easyocr'] = SimpleNamespace(Reader=lambda *args, **kwargs: SimpleNamespace(readtext=resumed_read))
                    with patch.dict(sys.modules, modules):
                        result = analyze(root, {'sourceLanguage': 'en', 'threads': 4})
                    self.assertEqual(len(resumed_calls), 1)
                    self.assertEqual(result['pages'][0]['blocks'][0]['text'], 'HELLO')
                    self.assertEqual(result['pages'][1]['blocks'][0]['text'], 'SECOND')
                    # A fully saved chapter needs no model initialization at all.
                    with patch.dict(sys.modules, {'easyocr': None, 'torch': None, 'cv2': None}):
                        self.assertEqual(len(analyze(root, {'sourceLanguage': 'en'})['pages']), 2)
                page = extract(root)[0]
                self.assertFalse(restore_page(root, page, 'ja'))
                page['sha256'] = 'changed-image'
                self.assertFalse(restore_page(root, page, 'en'))
                (root / 'ocr-checkpoints/0000.json').write_text('{broken')
                self.assertFalse(restore_page(root, extract(root)[0], 'en'))

    def test_render_pause_resumes_saved_pages_and_invalidates_only_changed_output_or_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with zipfile.ZipFile(root / 'input.cbz', 'w') as archive:
                archive.writestr('001.png', image_bytes())
                archive.writestr('002.png', image_bytes())
            pages = extract(root)
            for page in pages:
                page['translationComplete'] = True
                page['blocks'] = [{'id': f"p{page['index']}b0", 'box': [10, 10, 90, 80], 'text': 'HELLO', 'translated': 'Hallo', 'confidence': 0.99, 'rendered': False}]
            (root / 'content.json').write_text(json.dumps({'pages': pages}))
            real_render = render_page
            calls = []
            def first(image, page):
                calls.append(page['index'])
                value = real_render(image, page, FONT)
                (root / 'pause.requested').write_text('pause')
                return value
            with patch('worker.render_page', first):
                with self.assertRaises(PauseRequested):
                    render(root, {})
            self.assertEqual(calls, [0])
            (root / 'pause.requested').unlink()
            calls.clear()
            def next_page(image, page):
                calls.append(page['index'])
                return real_render(image, page, FONT)
            with patch('worker.render_page', next_page):
                render(root, {})
                self.assertEqual(calls, [1])
                calls.clear()
                data = json.loads((root / 'content.json').read_text())
                data['pages'][1]['blocks'][0]['translated'] = 'Geändert'
                (root / 'content.json').write_text(json.dumps(data))
                render(root, {})
                self.assertEqual(calls, [1])
                calls.clear()
                (root / 'translated/0000.png').write_bytes(b'incomplete image')
                render(root, {})
                self.assertEqual(calls, [0])

    def test_partial_render_skips_original_pages_and_reuses_previously_rendered_sample(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with zipfile.ZipFile(root / 'input.cbz', 'w') as archive:
                for index in range(3):
                    archive.writestr(f'{index:03}.png', image_bytes())
            pages = extract(root)
            for page in pages:
                page['blocks'] = [{'id': f"p{page['index']}b0", 'box': [10, 10, 90, 80], 'text': 'HELLO', 'translated': 'Hallo' if page['index'] == 2 else '', 'rendered': False}]
                page['translationComplete'] = page['index'] == 2
            (root / 'content.json').write_text(json.dumps({'pages': pages}))
            calls = []
            def render_sample(image, page):
                calls.append(page['index'])
                return render_page(image, page, FONT)
            with patch('worker.render_page', render_sample):
                first = render(root, {})
                self.assertEqual(calls, [2])
                self.assertFalse((root / 'translated/0000.png').exists())
                self.assertFalse((root / 'translated/0001.png').exists())
                self.assertTrue((root / 'translated/0002.png').exists())
                self.assertTrue(first['pages'][2]['renderComplete'])
                self.assertFalse(first['pages'][0].get('renderComplete', False))
                progress = json.loads((root / 'progress.json').read_text())
                self.assertEqual(progress, {'stage': 'render', 'completed': 1, 'total': 1})
                for page in first['pages']:
                    page['translationComplete'] = True
                    page['blocks'][0]['translated'] = 'Hallo'
                (root / 'content.json').write_text(json.dumps(first))
                calls.clear()
                second = render(root, {})
                self.assertEqual(calls, [0, 1])
                self.assertTrue(all(page['renderComplete'] for page in second['pages']))

    def test_local_archive_extraction_has_stable_order_and_does_not_change_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with zipfile.ZipFile(root / 'input.cbz', 'w') as archive:
                archive.writestr('002.png', image_bytes('red'))
                archive.writestr('001.png', image_bytes('blue'))
                archive.writestr('ComicInfo.xml', '<metadata/>')
            before = (root / 'input.cbz').read_bytes()
            pages = extract(root)
            self.assertEqual(len(pages), 2)
            self.assertEqual(Image.open(root / 'original/0000.png').getpixel((0, 0)), (0, 0, 255))
            self.assertEqual(before, (root / 'input.cbz').read_bytes())
            self.assertTrue((root / 'preview/0001.jpg').is_file())

    def test_traversal_symlinks_and_zip_bombs_are_rejected(self):
        for name, mode, size in [('../outside.png', 0, 10), ('link.png', stat.S_IFLNK, 10), ('huge.png', 0, 33 * 1024 * 1024)]:
            item = zipfile.ZipInfo(name)
            item.external_attr = mode << 16
            item.file_size = size
            item.compress_size = size
            class Archive:
                def infolist(self):
                    return [item]
            with self.assertRaises(ValueError):
                safe_entries(Archive())

    def test_plain_bubble_text_is_replaced_without_touching_other_art(self):
        image = Image.new('RGB', (500, 300), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((5, 5, 40, 290), fill='red')
        draw.text((140, 100), 'HELLO', font=ImageFont.truetype(FONT, 30), fill='black')
        before = image.copy()
        block = {'id': 'p0b0', 'box': [130, 90, 290, 155], 'translated': 'Hallo!'}
        result, warnings = render_page(image, {'blocks': [block]}, FONT)
        self.assertTrue(block['rendered'])
        self.assertEqual(warnings, [])
        self.assertEqual(result.getpixel((10, 10)), (255, 0, 0))
        self.assertEqual(image.tobytes(), before.tobytes())
        self.assertNotEqual(result.tobytes(), before.tobytes())

    def test_complex_background_and_unfittable_text_are_not_erased(self):
        image = Image.new('RGB', (150, 100), 'black')
        block = {'id': 'p0b0', 'box': [20, 20, 100, 60], 'translated': 'Hallo'}
        result, warnings = render_page(image, {'blocks': [block]}, FONT)
        self.assertFalse(block['rendered'])
        self.assertEqual(result.tobytes(), image.tobytes())
        self.assertTrue(warnings)
        self.assertIsNone(fit_text(ImageDraw.Draw(image), 'Wort ' * 300, 10, 10, FONT))

    def test_german_compound_words_fit_and_nearby_lines_group(self):
        image = Image.new('RGB', (500, 300), 'white')
        self.assertIsNotNone(fit_text(ImageDraw.Draw(image), 'Donaudampfschifffahrtsgesellschaft', 180, 120, FONT))
        groups = group_boxes([([10, 10, 100, 30], 'Hello', .9), ([10, 35, 100, 55], 'friend', .8), ([300, 10, 400, 30], 'Separate', .95)], False)
        self.assertEqual(len(groups), 2)
        self.assertIn('Hello friend', [group['text'] for group in groups])


if __name__ == '__main__':
    unittest.main()
