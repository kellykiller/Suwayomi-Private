# SPDX-License-Identifier: MPL-2.0
import io
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

from PIL import Image, ImageDraw, ImageFont
from worker import extract, safe_entries, fit_text, group_boxes, render_page

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


def image_bytes(color='white'):
    output = io.BytesIO()
    Image.new('RGB', (100, 200), color).save(output, format='PNG')
    return output.getvalue()


class WorkerTests(unittest.TestCase):
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
