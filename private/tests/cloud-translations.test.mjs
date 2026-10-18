/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createCloudTranslationService, CLOUD_MODEL } from '../server/cloud-translations.mjs';
import { createLibraryExportService } from '../server/library-export.mjs';
import { createGateway } from '../server/gateway.mjs';
import { createTaskService } from '../server/tasks.mjs';

const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
);
function zip(names = ['0001.png', '0002.png']) {
    return execFileSync(
        'python3',
        [
            '-c',
            `import sys,json,base64,io,zipfile
v=json.load(sys.stdin);out=io.BytesIO()
with zipfile.ZipFile(out,'w') as z:
 for name in v['names']:z.writestr(name,base64.b64decode(v['png']))
sys.stdout.buffer.write(out.getvalue())`,
        ],
        { input: JSON.stringify({ names, png: png.toString('base64') }) },
    );
}
const resultZip = zip();
const user = {
    headers: {
        authorization: 'Basic ' + Buffer.from('fixture:private-password').toString('base64'),
        cookie: 'fixture=session',
        'x-do-not-forward': 'unrelated',
    },
};
const chapter = (id, downloaded = true) => ({
    id,
    mangaId: 7,
    sourceOrder: 100 - id,
    name: 'Chapter ' + id,
    isDownloaded: downloaded,
    pageCount: 2,
    manga: { id: 7, title: 'Fixture Manga' },
});
async function until(check) {
    const limit = Date.now() + 5000;
    while (Date.now() < limit) {
        const value = await check();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('Expected job state not reached');
}
async function fixture(t, options = {}) {
    const dir = await fs.mkdtemp(tmpdir() + '/suwayomi-cloud-');
    const root = dir + '/state';
    const token = 'internal-control-token-fixture-'.repeat(2);
    const tokenFile = dir + '/control.token';
    await fs.writeFile(tokenFile, token);
    const chapters = options.chapters || [chapter(1), chapter(2, false)];
    const states = new Map(),
        calls = [],
        services = [];
    let lost = !!options.lost;
    let rejected = !!options.rejectFirst;
    const outputZip = options.expanded ? zip(['0001.png', '0002.png', '0003.png']) : resultZip;
    let cancelPolls = 0;
    const libraryExports = {
        plan: async (selection) => {
            const list = selection.chapterIds?.length
                ? chapters.filter((c) => selection.chapterIds.includes(c.id))
                : chapters;
            return {
                selection: { mangaIds: selection.mangaIds || [], chapterIds: selection.chapterIds || [] },
                title: 'Fixture Manga',
                chapterCount: list.length,
                chapters: structuredClone(list),
            };
        },
        archiveFile: async (id, req, dest) => {
            assert.equal(req.headers.authorization, user.headers.authorization);
            calls.push({ kind: 'archive', id });
            await fs.writeFile(dest, resultZip);
        },
    };
    const fetchImpl = async (url, input = {}) => {
        url = new URL(url);
        const method = input.method || 'GET';
        calls.push({ kind: 'http', path: url.pathname, method });
        assert.equal(input.redirect, 'error');
        if (url.port === '18082') {
            assert.equal(input.headers.authorization, user.headers.authorization);
            assert.equal(input.headers['x-do-not-forward'], undefined);
            const query = JSON.parse(input.body);
            assert(query.query.includes('enqueueChapterDownload'));
            const item = chapters.find((c) => c.id === query.variables.input.id);
            item.isDownloaded = true;
            return Response.json({
                data: { enqueueChapterDownload: { downloadStatus: { state: 'STARTED' } } },
            });
        }
        assert.equal(url.hostname, '127.0.0.1');
        assert.equal(url.port, '18083');
        if (url.pathname === '/healthz')
            return Response.json({
                status: 'ok',
                model: CLOUD_MODEL,
                credentials: { google: true, openai: true },
            });
        assert.equal(input.headers.Authorization, 'Bearer ' + token);
        assert(!JSON.stringify(input.headers).includes(user.headers.authorization));
        if (url.pathname === '/v1/jobs' && method === 'GET') return Response.json({ jobs: [] });
        if (url.pathname === '/v1/jobs' && method === 'POST') {
            const chunks = [];
            for await (const chunk of input.body) chunks.push(chunk);
            assert.equal(Buffer.concat(chunks).length, Number(input.headers['Content-Length']));
            const id = input.headers['Idempotency-Key'];
            assert(!states.has(id), 'No implicit duplicate submission');
            if (rejected) {
                rejected = false;
                return Response.json({ error: 'Defekte TIFF-Datei. ' + token }, { status: 400 });
            }
            states.set(id, {
                id,
                model: CLOUD_MODEL,
                pages: options.expanded ? 3 : 2,
                source_entries: 2,
                status: options.running ? 'running' : 'completed_with_retained_regions',
                summary: {
                    open_regions: 1,
                    region_status: { rendered: 3, retained_source: 1 },
                    new_api_calls: { google: 2, openai: 1 },
                },
            });
            if (lost) {
                lost = false;
                throw new Error('simulated lost response');
            }
            return Response.json(states.get(id), { status: 202 });
        }
        const match = url.pathname.match(/^\/v1\/jobs\/([a-f0-9-]{36})(?:\/(resume|cancel|result.cbz))?$/);
        assert(match, 'Only known local API endpoints');
        const state = states.get(match[1]);
        if (!state) return Response.json({ error: 'missing' }, { status: 404 });
        if (!match[2] && state.status === 'cancelling') {
            const reply = { ...state };
            if (++cancelPolls >= 2) state.status = 'cancelled';
            return Response.json(reply);
        }
        if (match[2] === 'result.cbz') return new Response(options.badZip ? zip(['../escape.png']) : outputZip);
        if (match[2] === 'resume') state.status = 'completed_with_retained_regions';
        if (match[2] === 'cancel') state.status = options.delayedCancel ? 'cancelling' : 'cancelled';
        return Response.json(state);
    };
    const create = () => {
        const service = createCloudTranslationService({
            upstream: 'http://127.0.0.1:18082',
            root,
            tokenFile,
            libraryExports,
            chapterReader: async (id) => {
                const value = structuredClone(chapters.find((c) => c.id === id));
                if (options.changed) value.name = 'Changed';
                return value;
            },
            fetchImpl,
            python: 'python3',
            pollMs: 5,
        });
        services.push(service);
        return service;
    };
    const service = create();
    t.after(async () => {
        for (const s of services) await s.stop();
        await fs.rm(dir, { recursive: true, force: true });
    });
    return { service, create, chapters, states, calls, root, token, tokenFile };
}
const uploads = (f) => f.calls.filter((c) => c.kind === 'http' && c.method === 'POST' && c.path === '/v1/jobs');

test('Cloud health and chapter planning make no upload, download mutation or paid call', async (t) => {
    const f = await fixture(t);
    assert.equal((await f.service.status()).ready, true);
    const plan = await f.service.plan({ mangaIds: [7] }, user);
    assert.equal(plan.newChapters, 2);
    assert.equal(plan.missingDownloads, 1);
    assert.equal(uploads(f).length, 0);
    assert(f.calls.every((c) => c.method === 'GET'));
    await assert.rejects(f.service.start({ requestId: randomUUID(), chapterIds: [1] }, user), /bestaetigen/);
    assert.equal(uploads(f).length, 0);
});
test('Whole-manga job downloads missing chapters once, imports complete PNG/CBZ and exposes reader pages', async (t) => {
    const f = await fixture(t);
    const id = randomUUID();
    await f.service.start({ requestId: id, mangaIds: [7], consent: true, maxOpenAI: 15 }, user);
    const batch = await until(async () => {
        const b = await f.service.get(id, false);
        return b.phase === 'completed_with_retained_regions' ? b : false;
    });
    assert.equal(uploads(f).length, 2);
    assert.equal(f.calls.filter((c) => c.path === '/api/graphql').length, 1);
    for (const item of batch.chapters) {
        assert(item.outputReady);
        assert.equal(item.summary.open_regions, 1);
        const page = await f.service.file(id, item.id, 0);
        assert.deepEqual(await fs.readFile(page.path), png);
        const cbz = await f.service.file(id, item.id, null);
        assert.deepEqual(await fs.readFile(cbz.path), resultZip);
        const available = await f.service.available(
            item.chapterId,
            f.chapters.find((c) => c.id === item.chapterId),
        );
        assert.equal(available.pages.length, 2);
        assert.match(available.pages[0], /\/page\/0$/);
        assert.equal(
            await f.service.available(item.chapterId, {
                ...f.chapters.find((c) => c.id === item.chapterId),
                sourceOrder: 999,
            }),
            null,
        );
        await assert.rejects(f.service.file(id, item.id, 2), /Seite/);
    }
    const plan = await f.service.plan({ mangaIds: [7] }, user);
    assert.equal(plan.newChapters, 0);
    assert.equal(plan.alreadyTranslated, 2);
    assert(!(await fs.readFile(f.root + '/' + id + '/batch.json', 'utf8')).includes(f.token));
    assert(!(await fs.readFile(f.root + '/' + id + '/batch.json', 'utf8')).includes(user.headers.authorization));
});
test('Same batch request is idempotent and refuses changed selection or budget', async (t) => {
    const f = await fixture(t);
    const input = { requestId: randomUUID(), chapterIds: [1], consent: true };
    await f.service.start(input, user);
    await until(async () => !f.service.busy());
    const again = await f.service.start(input, user);
    assert.equal(again.id, input.requestId);
    assert.equal(uploads(f).length, 1);
    await assert.rejects(f.service.start({ ...input, chapterIds: [2] }, user), /anderen Auswahl/);
    await assert.rejects(f.service.start({ ...input, maxOpenAI: 1 }, user), /Anfragegrenze/);
});
test('Multipage documents import all output pages while source identity keeps the original file count', async (t) => {
    const f = await fixture(t, { expanded: true });
    const id = randomUUID();
    await f.service.start({ requestId: id, chapterIds: [1], consent: true }, user);
    const batch = await until(async () => {
        const b = await f.service.get(id, false);
        return b.phase === 'completed_with_retained_regions' ? b : false;
    });
    const item = batch.chapters[0];
    assert.equal(item.pageCount, 2);
    assert.equal(item.outputPageCount, 3);
    const available = await f.service.available(1, f.chapters[0]);
    assert.equal(available.pageCount, 3);
    assert.equal(available.pages.length, 3);
    assert.deepEqual(await fs.readFile((await f.service.file(id, item.id, 2)).path), png);
    await assert.rejects(f.service.file(id, item.id, 3), /Seite/);
    assert.equal((await f.service.plan({ chapterIds: [1] }, user)).alreadyTranslated, 1);
});
test('A rejected input exposes its diagnostic without the control token; explicit resume reuses the cached source and UUID', async (t) => {
    const f = await fixture(t, { rejectFirst: true });
    const id = randomUUID();
    await f.service.start({ requestId: id, chapterIds: [1], consent: true }, user);
    const failed = await until(async () => {
        const b = await f.service.get(id, false);
        return b.phase === 'failed' ? b : false;
    });
    assert.match(failed.message, /HTTP 400.*Defekte TIFF-Datei/);
    assert(!failed.message.includes(f.token));
    const itemId = failed.chapters[0].id;
    assert.equal(f.states.size, 0);
    await f.service.resume({ id, consent: true }, user);
    await until(async () => (await f.service.get(id, false)).phase === 'completed_with_retained_regions');
    assert.equal([...f.states.keys()][0], itemId);
    assert.equal(f.calls.filter((c) => c.kind === 'archive').length, 1);
    assert.equal(uploads(f).length, 2);
});
test('Lost submission response never automatically reposts; explicit resume finds the same remote UUID', async (t) => {
    const f = await fixture(t, { lost: true });
    const id = randomUUID();
    await f.service.start({ requestId: id, chapterIds: [1], consent: true }, user);
    await until(async () => (await f.service.get(id, false)).phase === 'failed');
    assert.equal(uploads(f).length, 1);
    await f.service.resume({ id, consent: true }, user);
    await until(async () => (await f.service.get(id, false)).phase === 'completed_with_retained_regions');
    assert.equal(uploads(f).length, 1);
});
test('Gateway restart makes no automatic API submission and explicit resume reuses a remote completed job', async (t) => {
    const f = await fixture(t, { running: true });
    const id = randomUUID();
    await f.service.start({ requestId: id, chapterIds: [1], consent: true }, user);
    await until(() => uploads(f).length === 1);
    await f.service.stop();
    const next = f.create();
    const before = f.calls.length;
    assert.equal((await next.list())[0].phase, 'interrupted');
    assert.equal(f.calls.length, before);
    const remote = f.states.values().next().value;
    remote.status = 'completed_with_retained_regions';
    await next.resume({ id, consent: true }, user);
    await until(async () => (await next.get(id, false)).phase === 'completed_with_retained_regions');
    assert.equal(uploads(f).length, 1);
});
test('Explicit cancel targets the submitted remote job; cancelled chapter must resume instead of becoming a duplicate job', async (t) => {
    const f = await fixture(t, { running: true, delayedCancel: true });
    const id = randomUUID();
    await f.service.start({ requestId: id, chapterIds: [1], consent: true }, user);
    await until(() => uploads(f).length === 1);
    assert.equal((await f.service.cancel(id)).phase, 'cancelled');
    assert.equal([...f.states.values()][0].status, 'cancelling');
    assert.equal(f.calls.filter((c) => c.path?.endsWith('/cancel')).length, 1);
    await assert.rejects(
        f.service.start({ requestId: randomUUID(), chapterIds: [1], consent: true }, user),
        /unvollstaendiger Auftrag/,
    );
    await f.service.resume({ id, consent: true }, user);
    await until(async () => (await f.service.get(id, false)).phase === 'completed_with_retained_regions');
    assert.equal(uploads(f).length, 1);
    assert.equal(f.calls.filter((c) => c.path?.endsWith('/resume')).length, 1);
});
test('Malformed result archive cannot publish partial reader pages or escape the chapter directory', async (t) => {
    const f = await fixture(t, { badZip: true });
    const id = randomUUID();
    await f.service.start({ requestId: id, chapterIds: [1], consent: true }, user);
    const batch = await until(async () => {
        const b = await f.service.get(id, false);
        return b.phase === 'failed' ? b : false;
    });
    assert.equal(batch.chapters[0].outputReady, false);
    await assert.rejects(f.service.file(id, batch.chapters[0].id, 0), /nicht gefunden/);
    assert.equal(await f.service.available(1, f.chapters[0]), null);
});
test('Source chapter identity changes stop before cloud upload', async (t) => {
    const f = await fixture(t, { changed: true });
    const input = { requestId: randomUUID(), chapterIds: [1], consent: true };
    await f.service.start(input, user);
    await until(async () => (await f.service.get(input.requestId, false)).phase === 'failed');
    assert.equal(uploads(f).length, 0);
    assert.equal(await f.service.available(1, f.chapters[0]), null);
});
test('Cloud service target accepts only local NAS loopback', () => {
    for (const serviceUrl of [
        'https://example.com',
        'http://192.168.175.60:18083',
        'http://user:pass@127.0.0.1:18083',
        'http://127.0.0.1:18083/path',
    ])
        assert.throws(() => createCloudTranslationService({ serviceUrl }));
});
test('Cloud routes require Suwayomi Basic authentication and same-origin POST; control token never reaches the browser', async (t) => {
    let starts = 0;
    const cloud = {
        start: async () => {
            starts++;
            return { id: 'fixture' };
        },
        status: async () => ({ ready: true }),
        stop: async () => {},
        busy: () => false,
    };
    const gateway = createGateway({
        manifest: {},
        configLoader: async () => ({ origins: ['https://reader.example'] }),
        fetchImpl: async (_url, input) =>
            input.headers.Authorization
                ? Response.json({
                      data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
                  })
                : new Response('', { status: 401 }),
        cloudTranslationService: cloud,
        translationService: { stop: async () => {} },
        aiService: { stop: async () => {} },
        logService: { write: async () => {} },
    });
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => gateway.close(r)));
    const url = `http://127.0.0.1:${gateway.address().port}/private-api/cloud-translations/start`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = {
        Authorization: user.headers.authorization,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Suwayomi-Private': '1',
    };
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal(starts, 0);
    headers.Origin = 'https://reader.example';
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 202);
    assert.equal(starts, 1);
});
test('Paid AI search cannot start alongside an active cloud batch and works again when the batch ends', async (t) => {
    let busy = true,
        searches = 0;
    const gateway = createGateway({
        manifest: {},
        configLoader: async () => ({ origins: ['https://reader.example'] }),
        fetchImpl: async () =>
            Response.json({
                data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
            }),
        cloudTranslationService: { busy: () => busy, stop: async () => {} },
        translationService: { busy: () => false, stop: async () => {} },
        aiService: {
            start: async () => {
                searches++;
                return { id: 'fixture' };
            },
            stop: async () => {},
        },
        logService: { write: async () => {} },
    });
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => gateway.close(r)));
    const url = `http://127.0.0.1:${gateway.address().port}/private-api/ai/search`;
    const options = {
        method: 'POST',
        headers: {
            Authorization: user.headers.authorization,
            Origin: 'https://reader.example',
            'Content-Type': 'application/json',
            'X-Suwayomi-Private': '1',
        },
        body: '{}',
    };
    assert.equal((await fetch(url, options)).status, 400);
    assert.equal(searches, 0);
    busy = false;
    assert.equal((await fetch(url, options)).status, 202);
    assert.equal(searches, 1);
});
test('Cloud batch is visible and cancellable in central tasks independently of its originating browser', async () => {
    const id = randomUUID();
    let cancelled;
    const cloud = {
        list: async () => [
            {
                id,
                title: 'Manga',
                phase: 'running',
                message: 'Kapitel 1',
                chapters: [{ outputReady: true }, { outputReady: false }],
            },
        ],
        cancel: async (value) => {
            cancelled = value;
        },
    };
    const tasks = createTaskService({
        cloud,
        translations: { list: async () => [] },
        ai: { active: () => null },
        jobReader: async () => null,
    });
    const result = await tasks.privateTasks(user);
    assert.equal(result.tasks[0].kind, 'cloud');
    assert.equal(result.tasks[0].progress.completed, 1);
    await tasks.cancel({ kind: 'cloud', id }, user);
    assert.equal(cancelled, id);
});
test('File export adapter streams a real Suwayomi chapter into a persistent source CBZ without marking read', async (t) => {
    const dir = await fs.mkdtemp(tmpdir() + '/cloud-export-');
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const backend = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, user.headers.authorization);
        for await (const _ of req) {
        }
        if (req.url === '/api/graphql')
            res.end(JSON.stringify({ data: { chapters: { totalCount: 1, nodes: [chapter(1)] } } }));
        else {
            assert.equal(req.url, '/api/v1/chapter/1/download?markAsRead=false');
            res.end(resultZip);
        }
    });
    await new Promise((r) => backend.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => backend.close(r)));
    const library = createLibraryExportService({
        upstream: `http://127.0.0.1:${backend.address().port}`,
        stateRoot: dir,
        python: 'python3',
    });
    await library.archiveFile(1, user, dir + '/source.cbz', new AbortController().signal);
    const names = execFileSync(
        'python3',
        [
            '-c',
            'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(z.namelist()))',
            dir + '/source.cbz',
        ],
        { encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(names), ['0001.png', '0002.png']);
});
