"""Durable, single-worker chapter queue. Credentials never enter job metadata."""
from __future__ import annotations

import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import queue
import select
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile

from PIL import Image

VERSION = '0.1.2'
MODEL = 'gpt-6-astra'
MAX_UPLOAD = 256 * 1024**2
MAX_EXPANDED = 256 * 1024**2
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.avif'}
COMPLETE = {'completed', 'completed_with_retained_regions'}
ACTIVE = {'queued', 'running', 'cancelling'}


class Problem(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def job_id(value):
    try:
        if str(uuid.UUID(value)) == value:
            return value
    except (ValueError, TypeError, AttributeError):
        pass
    raise Problem(400, 'Eine kanonische UUID als Idempotency-Key verwenden.')


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def atomic_json(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, encoding='utf-8', delete=False) as f:
        temp = Path(f.name)
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def hash_file(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from image_input import inspect as inspect_input, InputError

def validate_input(path):
    try:
        return inspect_input(path)
    except InputError as error:
        raise Problem(400, 'Ungueltiger Eingang: ' + str(error)) from None


def validate_cbz(path):
    # Keep the old helper name available to diagnostics and existing callers.
    return validate_input(path)['pages']


class Jobs:
    def __init__(self, data, secrets, app=None, runner=None):
        self.data, self.secrets = Path(data), Path(secrets)
        self.app = Path(app or Path(__file__).resolve().parents[1] / 'app')
        self.root = self.data / 'jobs'
        self.root.mkdir(parents=True, exist_ok=True)
        self.lockfile = (self.data / '.service.lock').open('a')
        try:
            fcntl.flock(self.lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lockfile.close()
            raise RuntimeError('Der Datenordner wird bereits von einem Dienst verwendet.') from None
        self.mutex = threading.RLock()
        self.stopping = threading.Event()
        self.queue = queue.Queue()
        self.proc = None
        self.states = {}
        for path in self.root.glob('*/job.json'):
            state = read_json(path)
            try:
                valid = state and job_id(path.parent.name) == state.get('id')
            except Problem:
                valid = False
            if not valid:
                continue
            if state['status'] in ACTIVE:
                state.update(status='interrupted', message='Dienst neu gestartet. Explizit fortsetzen; kein automatischer API-Aufruf.')
                atomic_json(path, state)
            self.states[state['id']] = state
        self.runner = runner or self.run_pipeline
        self.thread = threading.Thread(target=self.work, name='chapter-worker', daemon=True)
        self.thread.start()

    def secret(self, name):
        try:
            value = (self.secrets / name).read_text(encoding='utf-8').strip()
            return value if 0 < len(value) <= 4096 and not any(c.isspace() for c in value) else ''
        except OSError:
            return ''

    def keys(self):
        return {'openai': self.secret('openai.key'), 'google': self.secret('google.key')}

    def health(self):
        with self.mutex:
            return {'status': 'ok', 'service': 'suwayomi-cloud-translator', 'version': VERSION,
                    'model': MODEL, 'credentials': {k: bool(v) for k, v in self.keys().items()},
                    'control_token_configured': bool(self.secret('control.token')),
                    'queued_jobs': sum(x['status'] == 'queued' for x in self.states.values()),
                    'running_jobs': sum(x['status'] in {'running', 'cancelling'} for x in self.states.values()),
                    'api_requests_on_startup': 0}

    def require_keys(self):
        if not all(self.keys().values()):
            raise Problem(503, 'Google- und OpenAI-Schluessel sind noch nicht eingerichtet.')

    def persist(self, state):
        state['updated_at'] = int(time.time())
        atomic_json(self.root / state['id'] / 'job.json', state)

    def public(self, identity):
        with self.mutex:
            state = self.states.get(job_id(identity))
            if state is None:
                raise Problem(404, 'Auftrag nicht gefunden.')
            result = dict(state)
            phase = read_json(self.root / identity / 'output/lauf.json', {})
            result['progress'] = {k: phase[k] for k in ('status', 'input_pages', 'completed_pages', 'new_api_calls') if k in phase}
            summary = read_json(self.root / identity / 'output/ergebnisse.json', {}).get('summary')
            if state['status'] in COMPLETE and summary:
                result['summary'] = summary
            result['result_ready'] = state['status'] in COMPLETE and (self.root / identity / 'output/kapitel-de.cbz').is_file()
            return result

    def list(self):
        with self.mutex:
            ids = sorted(self.states, key=lambda k: self.states[k]['created_at'], reverse=True)
            return [self.public(k) for k in ids[:200]]

    def submit(self, identity, source, max_openai=160):
        job_id(identity)
        if not 1 <= max_openai <= 160:
            raise Problem(400, 'X-Max-OpenAI muss zwischen 1 und 160 liegen.')
        sha = hash_file(source)
        with self.mutex:
            old = self.states.get(identity)
            if old:
                if (old['source_sha256'], old['max_openai']) != (sha, max_openai):
                    raise Problem(409, 'Diese Auftrags-ID gehoert zu einem anderen Eingang oder Anfragebudget.')
                return self.public(identity), False
            self.require_keys()
            if self.stopping.is_set():
                raise Problem(503, 'Dienst wird beendet.')
            if sum(s['status'] in ACTIVE for s in self.states.values()) >= 20:
                raise Problem(429, 'Warteschlange voll (maximal 20 aktive Kapitel).')
            validation = validate_input(source)
            pages = validation['pages']
            dest = self.root / identity
            dest.mkdir(exist_ok=True)
            os.replace(source, dest / 'source.cbz')
            state = {'id': identity, 'status': 'queued', 'created_at': int(time.time()),
                     'model': MODEL, 'source_sha256': sha, **validation, 'max_openai': max_openai,
                     'max_google': pages, 'attempts': 0, 'message': 'Wartet auf Verarbeitung.'}
            self.states[identity] = state
            self.persist(state)
            self.queue.put(identity)
            return self.public(identity), True

    def resume(self, identity):
        with self.mutex:
            state = self.public(identity)
            if state['status'] in COMPLETE | ACTIVE:
                return state
            self.require_keys()
            if self.stopping.is_set():
                raise Problem(503, 'Dienst wird beendet.')
            if sum(s['status'] in ACTIVE for s in self.states.values()) >= 20:
                raise Problem(429, 'Warteschlange voll.')
            path = self.root / identity
            if not (path / 'source.cbz').is_file() or hash_file(path / 'source.cbz') != state['source_sha256']:
                raise Problem(409, 'Gespeicherter Eingang fehlt oder wurde veraendert.')
            # No child for this job can still run: single worker + service flock.
            (path / 'output/job.lock').unlink(missing_ok=True)
            self.states[identity].update(status='queued', message='Fortsetzen mit gespeicherten Antworten. Unbestaetigte Anfragen bleiben gesperrt.')
            self.persist(self.states[identity])
            self.queue.put(identity)
            return self.public(identity)

    def cancel(self, identity):
        with self.mutex:
            state = self.public(identity)
            if state['status'] in {'queued', 'running'}:
                self.states[identity].update(status='cancelling' if state['status'] == 'running' else 'cancelled',
                                             message='Abbruch angefordert. Vorhandene Ergebnisse bleiben gespeichert.')
                self.persist(self.states[identity])
                if state['status'] == 'running' and self.proc:
                    self.signal_child(signal.SIGINT)
            return self.public(identity)

    def signal_child(self, sig):
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, AttributeError):
            pass

    def work(self):
        while not self.stopping.is_set():
            try:
                identity = self.queue.get(timeout=0.2)
            except queue.Empty:
                continue
            with self.mutex:
                state = self.states[identity]
                if state['status'] != 'queued' or self.stopping.is_set():
                    self.queue.task_done()
                    continue
                state.update(status='running', message='Kapitel wird verarbeitet.', attempts=state['attempts']+1)
                self.persist(state)
            try:
                status = self.runner(identity, self.keys())
                message = 'Abgeschlossen.' if status in COMPLETE else 'Lauf gestoppt. Gespeicherte Ergebnisse bleiben erhalten; Details im lokalen Auftragsordner.'
            except Exception:
                status, message = 'failed', 'Verarbeitung fehlgeschlagen. Gespeicherte Ergebnisse bleiben erhalten.'
            with self.mutex:
                self.proc = None
                if state['status'] == 'cancelling':
                    status, message = 'cancelled', 'Abgebrochen. Gespeicherte Ergebnisse bleiben erhalten.'
                if self.stopping.is_set() and status not in COMPLETE:
                    status = 'interrupted'
                state.update(status=status, message=message)
                self.persist(state)
            self.queue.task_done()

    def run_pipeline(self, identity, keys):
        path = self.root / identity
        state = self.states[identity]
        entrypoint = self.app.parent / 'server/run_chapter.py'
        if not entrypoint.exists():
            entrypoint = self.app / 'pipeline.py'
        args = [sys.executable, '-u', str(entrypoint), '--input', str(path / 'source.cbz'),
                '--output', str(path / 'output'), '--seed', str(self.app.parent / 'seed'),
                '--live', '--key-stdin', '--workers', '1', '--model', MODEL,
                '--max-openai', str(state['max_openai']), '--max-google', str(state['max_google'])]
        with self.mutex:
            if self.stopping.is_set() or state['status'] == 'cancelling':
                return 'interrupted'
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, start_new_session=True)
            self.proc = proc
        tail, pending = bytearray(), bytearray()
        started, stop_at = time.monotonic(), None
        try:
            proc.stdin.write((json.dumps(keys)+'\n').encode())
            proc.stdin.close()
            while True:
                now = time.monotonic()
                with self.mutex:
                    stopping = self.stopping.is_set() or state['status'] == 'cancelling'
                if stopping or now-started > 4*3600:
                    if stop_at is None:
                        stop_at = now
                        self.signal_child(signal.SIGINT)
                    elif now-stop_at > 15:
                        self.signal_child(signal.SIGKILL)
                ready, _, _ = select.select([proc.stdout], [], [], 0.5)
                if ready:
                    block = os.read(proc.stdout.fileno(), 8192)
                    if not block:
                        break
                    pending.extend(block)
                    while b'\n' in pending or len(pending) > 65536:
                        if b'\n' in pending:
                            line, _, rest = pending.partition(b'\n')
                            pending = bytearray(rest)
                        else:
                            line, pending = pending[:65536], pending[65536:]
                        line = self.redact(line.decode('utf-8', errors='replace'), keys)
                        tail.extend((line+'\n').encode())
                        del tail[:-1024*1024]
                        print(f'[{identity}] {line}', flush=True)
                elif proc.poll() is not None:
                    break
            if pending:
                tail.extend(self.redact(pending.decode('utf-8', errors='replace'), keys).encode())
            code = proc.wait(timeout=10)
            result = read_json(path / 'output/lauf.json', {})
            status = result.get('status', 'failed')
            return status if code == 0 and status in COMPLETE else 'interrupted' if status == 'interrupted' else 'failed'
        finally:
            if proc.poll() is None:
                self.signal_child(signal.SIGKILL)
                proc.wait(timeout=10)
            proc.stdout.close()
            (path / 'run.log').write_bytes(tail[-1024*1024:])

    @staticmethod
    def redact(value, keys):
        for key in keys.values():
            if key:
                value = value.replace(key, '[API-KEY]')
        return value

    def close(self):
        self.stopping.set()
        with self.mutex:
            if self.proc:
                self.signal_child(signal.SIGINT)
        self.thread.join(timeout=20)
        if self.thread.is_alive():
            with self.mutex:
                self.signal_child(signal.SIGKILL)
            self.thread.join(timeout=10)
        with self.mutex:
            for state in self.states.values():
                if state['status'] in ACTIVE | {'cancelling'}:
                    state.update(status='interrupted', message='Dienst beendet. Explizit fortsetzen.')
                    self.persist(state)
        fcntl.flock(self.lockfile, fcntl.LOCK_UN)
        self.lockfile.close()
