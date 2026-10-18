"""Real AVIF bytes through validation, working copies, OCR and cached resume."""
import argparse
import base64
import http.client
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import uuid
import zipfile

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'server'))
sys.path.insert(0, str(ROOT/'app'))
from jobs import Jobs, Problem, validate_cbz
from http_service import Server
from prepare import collect
from pipeline import run


def picture(format='AVIF', mode='RGB'):
    image = Image.new(mode, (80, 60), (242, 232, 210, 180) if mode == 'RGBA' else (242, 232, 210))
    ImageDraw.Draw(image).rectangle((10, 15, 50, 40), fill='black')
    output = io.BytesIO()
    image.save(output, format)
    return output.getvalue()


def archive(path, pages):
    with zipfile.ZipFile(path, 'w') as z:
        for name, data in pages:
            z.writestr(name, data)
    return path


class AvifTests(unittest.TestCase):
    def test_all_twenty_avif_pages_are_accepted_and_none_are_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            data = picture()
            source = archive(folder/'chapter.cbz', [(f'{n:04d}.avif', data) for n in range(1, 21)])
            self.assertEqual(validate_cbz(source), 20)
            pages = collect(source, folder/'out')
            self.assertEqual(len(pages), 20)
            self.assertEqual([p['sequence'] for p in pages], list(range(1, 21)))
            self.assertTrue(all(Path(p['path']).suffix == '.png' for p in pages))

    def test_mixed_formats_keep_order_originals_pixels_and_stable_cache_identity(self):
        for mode in ['RGB', 'RGBA']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                folder = Path(folder)
                avif = picture(mode=mode)
                inputs = [('10.avif', avif), ('2.png', picture('PNG')),
                          ('3.jpg', picture('JPEG')), ('4.webp', picture('WEBP'))]
                source = archive(folder/'chapter.cbz', inputs)
                before = source.read_bytes()
                self.assertEqual(validate_cbz(source), 4)
                first = collect(source, folder/'out')
                self.assertEqual([p['source_name'] for p in first], ['2.png', '3.jpg', '4.webp', '10.avif'])
                for page in first[:3]:
                    self.assertEqual(Path(page['path']).read_bytes(), dict(inputs)[page['source_name']])
                with Image.open(io.BytesIO(avif)) as original, Image.open(first[3]['path']) as png:
                    self.assertEqual(png.format, 'PNG')
                    self.assertEqual(original.size, png.size)
                    self.assertEqual(original.mode, png.mode)
                    self.assertEqual(original.tobytes(), png.tobytes())
                png_before = Path(first[3]['path']).read_bytes()
                second = collect(source, folder/'out')
                self.assertEqual(first, second)
                self.assertEqual(png_before, Path(second[3]['path']).read_bytes())
                self.assertEqual(before, source.read_bytes())

    def test_directory_input_avif_is_normalized_without_modifying_the_source(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = folder/'input'
            source.mkdir()
            data = picture()
            (source/'1.avif').write_bytes(data)
            pages = collect(source, folder/'out')
            self.assertEqual(pages[0]['source_name'], '1.avif')
            self.assertEqual(Path(pages[0]['path']).suffix, '.png')
            self.assertEqual((source/'1.avif').read_bytes(), data)

    def test_google_receives_png_and_cached_resume_makes_no_more_api_calls(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = archive(folder/'chapter.cbz', [('0001.avif', picture())])
            original = source.read_bytes()
            calls = []
            def transport(service, payload):
                calls.append(service)
                self.assertEqual(service, 'google')
                data = base64.b64decode(payload['requests'][0]['image']['content'])
                self.assertTrue(data.startswith(b'\x89PNG\r\n\x1a\n'))
                with Image.open(io.BytesIO(data)) as image:
                    self.assertEqual(image.format, 'PNG')
                    self.assertEqual(image.size, (80, 60))
                return {'responses': [{}]}
            args = argparse.Namespace(input=source, output=folder/'out', seed=folder/'seed',
                                      live=True, model='gpt-6-astra', max_openai=1, max_google=1,
                                      plan=False, workers=1, batch_size=60)
            result = run(args, transport=transport)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(calls, ['google'])
            self.assertEqual(result['new_api_calls'], {'google': 1, 'openai': 0})
            png = (args.output/'seiten/0001.png').read_bytes()
            again = run(args, transport=Mock(side_effect=AssertionError('Unexpected API call')))
            self.assertEqual(again['new_api_calls'], {'google': 0, 'openai': 0})
            self.assertEqual(png, (args.output/'seiten/0001.png').read_bytes())
            self.assertEqual(original, source.read_bytes())
            with zipfile.ZipFile(args.output/'kapitel-de.cbz') as z:
                self.assertEqual(z.namelist(), ['0001.png'])
                self.assertEqual(z.read('0001.png'), png)

    def test_bad_avif_is_rejected_and_animation_is_a_single_still(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            secrets = folder/'secrets'
            secrets.mkdir()
            for name in ['google.key', 'openai.key', 'control.token']:
                (secrets/name).write_text('fixture-key')
            animation = io.BytesIO()
            Image.new('RGB', (40, 50), 'white').save(
                animation, 'AVIF', save_all=True,
                append_images=[Image.new('RGB', (40, 50), 'black')], duration=100)
            runner = Mock()
            jobs = Jobs(folder/'data', secrets, runner=runner)
            try:
                for data in [b'broken avif']:
                    with self.subTest(data_size=len(data)):
                        source = archive(folder/'bad.cbz', [('0001.avif', data)])
                        with self.assertRaises(Problem) as ctx:
                            jobs.submit(str(uuid.uuid4()), source)
                        self.assertEqual(ctx.exception.code, 400)
                runner.assert_not_called()
                self.assertEqual(jobs.list(), [])
                source = archive(folder/'animation.cbz', [('0001.avif', animation.getvalue())])
                self.assertEqual(validate_cbz(source), 1)
                self.assertEqual(len(collect(source, folder/'animation-output')), 1)
            finally:
                jobs.close()

    def test_previously_rejected_uuid_is_accepted_after_upgrade_and_stays_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            secrets = folder/'secrets'
            secrets.mkdir()
            for name in ['google.key', 'openai.key', 'control.token']:
                (secrets/name).write_text('fixture-key')
            source = archive(folder/'source.cbz', [('0001.avif', picture())]).read_bytes()
            identity = str(uuid.uuid4())
            runner = Mock(return_value='completed')
            jobs = Jobs(folder/'data', secrets, runner=runner)
            server = Server(('127.0.0.1', 0), jobs)
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05})
            thread.start()
            def upload():
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    connection.request('POST', '/v1/jobs', source, {
                        'Authorization': 'Bearer fixture-key', 'Idempotency-Key': identity,
                        'X-Max-OpenAI': '160', 'Content-Type': 'application/vnd.comicbook+zip'})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            try:
                with patch('jobs.validate_input', side_effect=Problem(400, 'AVIF bisher nicht unterstuetzt.')):
                    self.assertEqual(upload()[0], 400)
                self.assertEqual(jobs.list(), [])
                code, state = upload()
                self.assertEqual(code, 202)
                self.assertEqual(state['id'], identity)
                self.assertEqual(state['pages'], 1)
                deadline = time.monotonic() + 5
                while jobs.public(identity)['status'] != 'completed' and time.monotonic() < deadline:
                    time.sleep(.01)
                code, state = upload()
                self.assertEqual(code, 200)
                self.assertEqual(state['attempts'], 1)
                self.assertEqual(runner.call_count, 1)
                self.assertEqual((jobs.root/identity/'source.cbz').read_bytes(), source)
            finally:
                server.shutdown()
                thread.join()
                server.server_close()
                jobs.close()


if __name__ == '__main__':
    unittest.main()
