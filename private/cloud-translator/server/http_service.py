"""Local HTTP API. Importing or starting this service makes no cloud requests."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import hmac
import json
from pathlib import Path
import re
import shutil
import signal
import socket
import tempfile
import threading

from jobs import Jobs, Problem, MAX_UPLOAD, COMPLETE, job_id

ROUTE = re.compile(r'^/v1/jobs/([0-9a-f-]{36})(?:/(resume|cancel|result.cbz))?$')


class Handler(BaseHTTPRequestHandler):
    server_version = 'MangaTranslator'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *args):
        # Never log URLs, headers or tokens.
        pass

    @property
    def jobs(self):
        return self.server.jobs

    def send_json(self, code, data):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(payload)

    def authorize(self):
        token = self.jobs.secret('control.token')
        values = self.headers.get_all('Authorization', [])
        supplied = values[0] if len(values) == 1 else ''
        if not token or not hmac.compare_digest(supplied.encode(), ('Bearer '+token).encode()):
            raise Problem(401, 'Gueltiger Bearer-Token erforderlich.')

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def dispatch(self, method):
        try:
            if method == 'GET' and self.path == '/healthz':
                return self.send_json(200, self.jobs.health())
            self.authorize()
            if self.path == '/v1/jobs':
                if method == 'GET':
                    return self.send_json(200, {'jobs': self.jobs.list()})
                return self.upload()
            match = ROUTE.fullmatch(self.path)
            if not match:
                raise Problem(404, 'Endpunkt nicht gefunden.')
            identity, action = match.groups()
            job_id(identity)
            if method == 'GET' and action is None:
                return self.send_json(200, self.jobs.public(identity))
            if method == 'GET' and action == 'result.cbz':
                state = self.jobs.public(identity)
                if state['status'] not in COMPLETE or not state['result_ready']:
                    raise Problem(409, 'Fertiges Kapitel noch nicht verfuegbar.')
                path = self.jobs.root / identity / 'output/kapitel-de.cbz'
                with path.open('rb') as f:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.comicbook+zip')
                    self.send_header('Content-Disposition', 'attachment; filename="kapitel-de.cbz"')
                    self.send_header('Content-Length', str(path.stat().st_size))
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers()
                    shutil.copyfileobj(f, self.wfile)
                return
            if method == 'POST' and action in {'resume', 'cancel'}:
                if self.headers.get('Content-Length', '0') != '0' or self.headers.get('Transfer-Encoding'):
                    raise Problem(400, 'Dieser Endpunkt erwartet keinen Request-Body.')
                result = getattr(self.jobs, action)(identity)
                return self.send_json(200, result)
            raise Problem(405, 'Methode hier nicht erlaubt.')
        except Problem as error:
            self.send_json(error.code, {'error': error.message})
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        except Exception:
            self.send_json(500, {'error': 'Interner Fehler; keine automatische Wiederholung ausgeloest.'})

    def upload(self):
        identity = job_id(self.headers.get('Idempotency-Key'))
        try:
            budget = int(self.headers.get('X-Max-OpenAI', '160'))
        except ValueError:
            raise Problem(400, 'Ungueltige Anfragegrenze.') from None
        sizes = self.headers.get_all('Content-Length', [])
        if len(sizes) != 1 or not sizes[0].isdigit() or self.headers.get('Transfer-Encoding'):
            raise Problem(411, 'Ein eindeutiger Content-Length ist erforderlich; kein Chunked-Upload.')
        size = int(sizes[0])
        if not 0 < size <= MAX_UPLOAD:
            raise Problem(413, 'Eingangsdatei maximal 256 MiB.')
        if shutil.disk_usage(self.jobs.data).free < size + 2*1024**3:
            raise Problem(507, 'Weniger als 2 GiB freier Arbeitsbereich; zuerst Speicher freigeben.')
        with tempfile.NamedTemporaryFile(dir=self.jobs.data, prefix='upload-', suffix='.cbz', delete=False) as f:
            path = Path(f.name)
            try:
                remaining = size
                while remaining:
                    block = self.rfile.read(min(1024**2, remaining))
                    if not block:
                        raise Problem(400, 'Upload unvollstaendig.')
                    f.write(block)
                    remaining -= len(block)
                f.close()
                state, created = self.jobs.submit(identity, path, budget)
                self.send_json(202 if created else 200, state)
            finally:
                path.unlink(missing_ok=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, jobs):
        self.jobs = jobs
        super().__init__(address, Handler)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data', type=Path, default=Path('/data'))
    p.add_argument('--secrets', type=Path, default=Path('/run/secrets'))
    p.add_argument('--host', default='0.0.0.0')
    p.add_argument('--port', type=int, default=8080)
    args = p.parse_args()
    jobs = Jobs(args.data, args.secrets)
    server = Server((args.host, args.port), jobs)

    def stop(*_):
        # shutdown() must run outside the serve_forever thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print('Manga-Uebersetzer 0.1.2 bereit. Start fuehrt keine API-Anfragen aus.', flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        jobs.close()
        server.server_close()


if __name__ == '__main__':
    main()
