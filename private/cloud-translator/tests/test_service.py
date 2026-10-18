from pathlib import Path
import http.client
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock
import uuid
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'server'))
from jobs import Jobs, Problem, atomic_json, validate_cbz
from http_service import Server


def cbz(path, name='0001.png'):
    data = io.BytesIO()
    Image.new('RGB', (40, 50), 'white').save(data, 'PNG')
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(name, data.getvalue())
    return path


def wait_for(predicate):
    limit = time.monotonic()+5
    while time.monotonic() < limit:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError('Background worker did not reach expected state')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.secret_dir = self.root/'secrets'
        self.secret_dir.mkdir()
        self.jobs = None
        self.release = threading.Event()

    def tearDown(self):
        self.release.set()
        if self.jobs:
            self.jobs.close()
        self.temp.cleanup()

    def credentials(self):
        for name, value in [('google.key', 'fake-google-key'), ('openai.key', 'fake-openai-key'), ('control.token', 'fake-control-token')]:
            (self.secret_dir/name).write_text(value)

    def make(self, runner=None, app=None):
        self.jobs = Jobs(self.root/'data', self.secret_dir, runner=runner, app=app)
        return self.jobs

    def source(self, name='upload.cbz'):
        return cbz(self.root/name)

    def test_health_without_credentials_never_invokes_worker(self):
        runner = Mock()
        jobs = self.make(runner)
        self.assertEqual(jobs.health()['credentials'], {'google': False, 'openai': False})
        self.assertEqual(jobs.health()['api_requests_on_startup'], 0)
        runner.assert_not_called()
        with self.assertRaises(Problem) as ctx:
            jobs.submit(str(uuid.uuid4()), self.source())
        self.assertEqual(ctx.exception.code, 503)
        runner.assert_not_called()

    def test_same_uuid_is_idempotent_and_changed_source_rejected(self):
        self.credentials()
        runner = Mock(return_value='completed')
        jobs = self.make(runner)
        identity = str(uuid.uuid4())
        state, created = jobs.submit(identity, self.source())
        self.assertTrue(created)
        wait_for(lambda: jobs.public(identity)['status'] == 'completed')
        state, created = jobs.submit(identity, self.source('again.cbz'))
        self.assertFalse(created)
        self.assertEqual(state['attempts'], 1)
        with self.assertRaises(Problem) as ctx:
            jobs.submit(identity, cbz(self.root/'different.cbz', '0002.png'))
        self.assertEqual(ctx.exception.code, 409)
        self.assertEqual(runner.call_count, 1)

    def test_queue_is_serial_and_cancelling_running_job_cannot_resume_early(self):
        self.credentials()
        calls = []
        def runner(identity, keys):
            calls.append(identity)
            self.release.wait(5)
            return 'completed'
        jobs = self.make(runner)
        a, b = str(uuid.uuid4()), str(uuid.uuid4())
        jobs.submit(a, self.source('a.cbz'))
        wait_for(lambda: bool(calls))
        jobs.submit(b, self.source('b.cbz'))
        self.assertEqual(calls, [a])
        self.assertEqual(jobs.cancel(b)['status'], 'cancelled')
        self.assertEqual(jobs.cancel(a)['status'], 'cancelling')
        self.assertEqual(jobs.cancel(a)['status'], 'cancelling')
        self.assertEqual(jobs.resume(a)['status'], 'cancelling')
        self.release.set()
        wait_for(lambda: jobs.public(a)['status'] == 'cancelled')
        self.assertEqual(calls, [a])

    def test_restart_requires_explicit_resume_and_preserves_pending_marker(self):
        self.credentials()
        identity = str(uuid.uuid4())
        jobs = self.make(Mock(return_value='failed'))
        jobs.submit(identity, self.source())
        wait_for(lambda: jobs.public(identity)['status'] == 'failed')
        path = jobs.root/identity
        out = path/'output'
        out.mkdir()
        (out/'job.lock').write_text('dead process')
        pending = out/'api-cache/openai/request.pending'
        pending.parent.mkdir(parents=True)
        pending.write_text('unconfirmed')
        state = dict(jobs.states[identity])
        state['status'] = 'running'
        jobs.close()
        self.jobs = None
        atomic_json(path/'job.json', state)
        runner = Mock(return_value='completed')
        jobs = self.make(runner)
        self.assertEqual(jobs.public(identity)['status'], 'interrupted')
        runner.assert_not_called()
        jobs.resume(identity)
        wait_for(lambda: jobs.public(identity)['status'] == 'completed')
        self.assertFalse((out/'job.lock').exists())
        self.assertEqual(pending.read_text(), 'unconfirmed')
        self.assertEqual(runner.call_count, 1)

    def test_second_service_cannot_open_same_job_store(self):
        self.make(Mock())
        with self.assertRaises(RuntimeError):
            Jobs(self.root/'data', self.secret_dir, runner=Mock())

    def test_invalid_archives_rejected_before_runner(self):
        self.credentials()
        runner = Mock()
        jobs = self.make(runner)
        for name in ['../../escape.png', '/absolute.png', 'a\\..\\escape.png']:
            with self.subTest(name=name), self.assertRaises(Problem):
                jobs.submit(str(uuid.uuid4()), cbz(self.root/'bad.cbz', name))
        with zipfile.ZipFile(self.root/'bad.cbz', 'w') as z:
            z.writestr('0001.png', b'not an image')
        with self.assertRaises(Problem):
            jobs.submit(str(uuid.uuid4()), self.root/'bad.cbz')
        runner.assert_not_called()

    def test_oversized_page_rejected_without_cloud_access(self):
        data = io.BytesIO()
        Image.new('1', (5000, 5000)).save(data, 'PNG')
        path = self.root/'large.cbz'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('0001.png', data.getvalue())
        with self.assertRaises(Problem):
            validate_cbz(path)

    def test_pipeline_subprocess_receives_keys_only_on_stdin_and_logs_redact_them(self):
        self.credentials()
        app = self.root/'app'
        app.mkdir()
        # Real child process, fake provider: tests stdin, args and output handover.
        (app/'pipeline.py').write_text('''import sys,json,pathlib,zipfile
keys=json.loads(sys.stdin.readline())
assert keys['openai']=='fake-openai-key'
assert not any('fake-' in arg for arg in sys.argv)
out=pathlib.Path(sys.argv[sys.argv.index('--output')+1]);out.mkdir()
print(keys['openai'],flush=True)
(out/'lauf.json').write_text(json.dumps({'status':'completed','new_api_calls':{'openai':0,'google':0}}))
with zipfile.ZipFile(out/'kapitel-de.cbz','w') as z:z.writestr('0001.png',b'test')
''')
        jobs = self.make(app=app)
        identity = str(uuid.uuid4())
        jobs.submit(identity, self.source())
        wait_for(lambda: jobs.public(identity)['status'] == 'completed')
        self.assertTrue(jobs.public(identity)['result_ready'])
        for path in (self.root/'data').rglob('*'):
            if path.is_file():
                self.assertNotIn(b'fake-openai-key', path.read_bytes(), str(path))
        self.assertIn('[API-KEY]', (jobs.root/identity/'run.log').read_text())

    def test_http_auth_upload_poll_and_download_without_any_real_api(self):
        self.credentials()
        def runner(identity, keys):
            output = self.jobs.root/identity/'output'
            output.mkdir()
            (output/'kapitel-de.cbz').write_bytes(b'fake-result')
            return 'completed'
        jobs = self.make(runner)
        server = Server(('127.0.0.1', 0), jobs)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05})
        thread.start()
        def request(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            code, payload = response.status, response.read()
            connection.close()
            return code, payload
        try:
            self.assertEqual(request('GET', '/healthz')[0], 200)
            self.assertEqual(request('GET', '/v1/jobs')[0], 401)
            identity = str(uuid.uuid4())
            headers = {'Authorization': 'Bearer fake-control-token', 'Idempotency-Key': identity}
            data = self.source().read_bytes()
            code, payload = request('POST', '/v1/jobs', data, headers)
            self.assertEqual(code, 202, payload)
            wait_for(lambda: jobs.public(identity)['status'] == 'completed')
            self.assertEqual(request('POST', '/v1/jobs', data, headers)[0], 200)
            code, payload = request('GET', '/v1/jobs/'+identity, headers=headers)
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(payload)['result_ready'])
            self.assertEqual(request('GET', '/v1/jobs/'+identity+'/result.cbz', headers=headers), (200, b'fake-result'))
            self.assertEqual(request('POST', '/v1/jobs', data, {'Authorization': headers['Authorization']})[0], 400)
            self.assertEqual(request('GET', '/v1/jobs/../../etc/passwd', headers=headers)[0], 404)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
