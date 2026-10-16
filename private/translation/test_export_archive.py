import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from export_archive import export, image_entries, safe_name


def cbz(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return stream.getvalue()


class Unseekable:
    def __init__(self):
        self.data = bytearray()

    def write(self, data):
        self.data.extend(data)
        return len(data)

    def flush(self):
        pass


class ExportTest(unittest.TestCase):
    def run_export(self, format, count=2):
        source = cbz([('10.JPG', b'ten'), ('2.jpg', b'two'), ('1.png', b'one'), ('ComicInfo.xml', b'metadata')])
        fetched = []
        with tempfile.TemporaryDirectory() as directory:
            chapters = [dict(id=index, mangaId=9, name='Chapter / same?', pageCount=3,
                             manga={'title': 'Test: Manga'}) for index in range(1, count + 1)]
            def download(config, chapter, path):
                fetched.append(chapter['id'])
                Path(path).write_bytes(source)
            stream = Unseekable()
            export(dict(upstream='http://127.0.0.1:18082', headers={}, directory=directory,
                        chapters=chapters, format=format), stream, download)
            self.assertEqual(list(Path(directory).iterdir()), [])
        self.assertEqual(fetched, list(range(1, count + 1)))
        return zipfile.ZipFile(io.BytesIO(stream.data))

    def test_folder_export_is_streamable_and_preserves_original_bytes_and_page_order(self):
        with self.run_export('folders') as archive:
            self.assertEqual(len(archive.namelist()), 6)
            names = archive.namelist()
            self.assertIn('/00001 - Chapter _ same_ (1)/0001.png', names[0])
            self.assertIn('/00002 - Chapter _ same_ (2)/0001.png', names[3])
            self.assertEqual([archive.read(name) for name in names], [b'one', b'two', b'ten'] * 2)
            self.assertEqual(archive.testzip(), None)

    def test_one_chapter_is_a_cbz_with_images_at_root(self):
        with self.run_export('cbz', count=1) as archive:
            self.assertEqual(archive.namelist(), ['0001.png', '0002.jpg', '0003.jpg'])
            self.assertEqual(archive.read('0003.jpg'), b'ten')

    def test_multiple_cbz_are_separate_chapters_inside_outer_zip(self):
        with self.run_export('cbz') as archive:
            self.assertEqual(len(archive.namelist()), 2)
            for name in archive.namelist():
                self.assertTrue(name.endswith('.cbz'))
                with zipfile.ZipFile(io.BytesIO(archive.read(name))) as nested:
                    self.assertEqual(nested.namelist(), ['0001.png', '0002.jpg', '0003.jpg'])
                    self.assertEqual(nested.read('0002.jpg'), b'two')

    def test_rejects_page_count_mismatch_traversal_duplicate_and_symlink(self):
        for entries, count in [([('1.jpg', b'x')], 2), ([('../1.jpg', b'x')], 1),
                               ([('1.jpg', b'a'), ('1.jpg', b'b')], 2)]:
            with zipfile.ZipFile(io.BytesIO(cbz(entries))) as source:
                with self.assertRaises(ValueError):
                    image_entries(source, count)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as source:
            entry = zipfile.ZipInfo('link.jpg')
            entry.external_attr = (0o120777 << 16)
            source.writestr(entry, b'../outside')
        with zipfile.ZipFile(io.BytesIO(stream.getvalue())) as source:
            with self.assertRaises(ValueError):
                image_entries(source, 1)

    def test_safe_windows_names(self):
        self.assertEqual(safe_name('CON'), '_CON')
        self.assertEqual(safe_name('a/b\\c:*?'), 'a_b_c___')
        self.assertEqual(safe_name('name. '), 'name')

    def test_failed_download_cleans_current_chapter(self):
        with tempfile.TemporaryDirectory() as directory:
            def fail(config, chapter, path):
                Path(path).write_bytes(b'partial')
                raise ValueError('download failed')
            with self.assertRaises(ValueError):
                export(dict(upstream='http://127.0.0.1:18082', headers={}, directory=directory,
                            chapters=[dict(id=1, mangaId=1, name='x', pageCount=1)], format='folders'),
                       io.BytesIO(), fail)
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
