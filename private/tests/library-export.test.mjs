/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createLibraryExportService, exportSelection, exportFileName } from '../server/library-export.mjs';
import { createGateway } from '../server/gateway.mjs';

test('export selections reject ambiguous, empty, oversized and unsafe IDs', () => {
    assert.deepEqual(exportSelection({ chapterIds: [1, 1, 2] }), { mangaIds: [], chapterIds: [1, 2] });
    for (const value of [
        null,
        {},
        { mangaIds: [1], chapterIds: [2] },
        { chapterIds: ['1'] },
        { mangaIds: [-1] },
        { chapterIds: [1.5] },
        { mangaIds: Array(21).fill(1) },
    ])
        assert.throws(() => exportSelection(value));
    assert.equal(exportFileName('CON'), '_CON');
    assert.equal(exportFileName('a/b\r\n.txt'), 'a_b__.txt');
});

test('manga export paginates and orders chapters oldest first without marking read or requesting source pages', async () => {
    const calls = [];
    const chapters = Array.from({ length: 201 }, (_, index) => ({
        id: index + 1,
        mangaId: 7,
        name: `Chapter ${index}`,
        sourceOrder: index,
        pageCount: 3,
        isDownloaded: index !== 4,
        manga: { id: 7, title: 'Manga' },
    }));
    const service = createLibraryExportService({
        upstream: 'http://localhost:18082',
        fetchImpl: async (url, options) => {
            const request = JSON.parse(options.body);
            calls.push({ url, options, request });
            return Response.json({
                data: {
                    chapters: {
                        totalCount: 201,
                        nodes: chapters.slice(request.variables.offset, request.variables.offset + 200),
                    },
                },
            });
        },
    });
    const result = await service.plan(
        { mangaIds: [7] },
        { headers: { authorization: 'Basic fixture', cookie: 'session', 'x-api-key': 'never-forward' } },
    );
    assert.equal(calls.length, 2);
    assert.equal(result.chapterCount, 201);
    assert.equal(result.readyCount, 200);
    assert.deepEqual(result.missingIds, [5]);
    assert.equal(result.chapters[0].id, 201);
    assert.equal(result.chapters.at(-1).id, 1);
    assert.deepEqual(calls[0].request.variables.filter, { mangaId: { in: [7] } });
    assert.equal(calls[0].options.headers.authorization, 'Basic fixture');
    assert.equal(calls[0].options.headers['x-api-key'], undefined);
    assert(calls.every((call) => call.url.pathname === '/api/graphql' && call.options.redirect === 'error'));
});

test('export refuses missing selected chapters and GraphQL errors instead of exporting a partial selection', async () => {
    const request = { headers: {} };
    const service = createLibraryExportService({
        upstream: 'http://localhost',
        fetchImpl: async () =>
            Response.json({
                data: {
                    chapters: {
                        totalCount: 1,
                        nodes: [
                            {
                                id: 1,
                                mangaId: 1,
                                sourceOrder: 0,
                                pageCount: 1,
                                isDownloaded: true,
                                manga: { id: 1, title: 'A' },
                            },
                        ],
                    },
                },
            }),
    });
    await assert.rejects(service.plan({ chapterIds: [1, 2] }, request), /Mindestens ein/);
    const broken = createLibraryExportService({
        upstream: 'http://localhost',
        fetchImpl: async () => Response.json({ errors: [{ message: 'fixture' }] }),
    });
    await assert.rejects(broken.plan({ mangaIds: [1] }, request), /Kapitelinformationen/);
});

async function listen(server, t) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
}

const chapter = {
    id: 17,
    mangaId: 7,
    sourceOrder: 1,
    name: 'Chapter 1',
    pageCount: 3,
    isDownloaded: true,
    manga: { id: 7, title: "Manga's Test" },
};

test('HTTP export streams a complete CBZ through the real Python worker and preserves page bytes', async (t) => {
    const auth = 'Basic ' + Buffer.from('fixture:secret').toString('base64');
    const source = execFileSync('python3', [
        '-c',
        `
import io, sys, zipfile
output = io.BytesIO()
with zipfile.ZipFile(output, 'w') as archive:
    for name in ('10.jpg', '2.PNG', '1.webp'):
        archive.writestr(name, name.encode())
    archive.writestr('ComicInfo.xml', b'<ComicInfo/>')
sys.stdout.buffer.write(output.getvalue())
`,
    ]);
    const requests = [];
    const backend = createServer(async (req, res) => {
        requests.push(req.url);
        assert.equal(req.headers.authorization, auth);
        assert.equal(req.headers.cookie, 'session=fixture');
        for await (const _ of req) {
        }
        if (req.url === '/api/graphql') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: { chapters: { totalCount: 1, nodes: [chapter] } } }));
        } else {
            assert.equal(req.url, '/api/v1/chapter/17/download?markAsRead=false');
            res.end(source);
        }
    });
    const upstream = await listen(backend, t);
    const service = createLibraryExportService({ upstream, python: 'python3' });
    let finished;
    const completed = new Promise((resolve) => {
        finished = resolve;
    });
    const before = new Set(await fs.readdir(tmpdir()));
    const server = createServer(async (req, res) => {
        try {
            await service.archive({ chapterIds: [17] }, 'cbz', req, res);
            finished();
        } catch (error) {
            res.destroy(error);
            finished(error);
        }
    });
    const url = await listen(server, t);
    const response = await fetch(url, { headers: { authorization: auth, cookie: 'session=fixture' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/vnd.comicbook+zip');
    assert.match(response.headers.get('Content-Disposition'), /Manga%27s%20Test/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(await completed, undefined);
    execFileSync(
        'python3',
        [
            '-c',
            `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.namelist() == ['0001.webp', '0002.png', '0003.jpg']
    assert [archive.read(name) for name in archive.namelist()] == [b'1.webp', b'2.PNG', b'10.jpg']
    assert archive.testzip() is None
`,
        ],
        { input: bytes },
    );
    assert.deepEqual(requests, ['/api/graphql', '/api/v1/chapter/17/download?markAsRead=false']);
    assert.deepEqual(
        (await fs.readdir(tmpdir())).filter((name) => name.startsWith('suwayomi-export-') && !before.has(name)),
        [],
    );
});

test('a failed worker terminates the HTTP download and removes temporary chapter data', async (t) => {
    const backend = createServer(async (req, res) => {
        for await (const _ of req) {
        }
        if (req.url === '/api/graphql') {
            res.end(JSON.stringify({ data: { chapters: { totalCount: 1, nodes: [chapter] } } }));
        } else {
            res.writeHead(500);
            res.end('fixture');
        }
    });
    const upstream = await listen(backend, t);
    const service = createLibraryExportService({ upstream, python: 'python3' });
    const before = new Set(await fs.readdir(tmpdir()));
    let finished;
    const completed = new Promise((resolve) => {
        finished = resolve;
    });
    const server = createServer(async (req, res) => {
        try {
            await service.archive({ chapterIds: [17] }, 'folders', req, res);
            finished(null);
        } catch (error) {
            res.destroy();
            finished(error);
        }
    });
    const url = await listen(server, t);
    await assert.rejects(async () => {
        const response = await fetch(url);
        await response.arrayBuffer();
    });
    assert.match((await completed).message, /HTTPError/);
    assert.deepEqual(
        (await fs.readdir(tmpdir())).filter((name) => name.startsWith('suwayomi-export-') && !before.has(name)),
        [],
    );
});

test('gateway export routes enforce native Basic Auth, same origin, and validated selections', async (t) => {
    const auth = 'Basic ' + Buffer.from('fixture:secret').toString('base64');
    const gateway = createGateway({
        upstream: 'http://127.0.0.1:18082',
        manifest: {},
        configLoader: async () => ({ origins: ['https://reader.example'] }),
        fetchImpl: async (_url, options) => {
            if (options.headers.Authorization !== auth && options.headers.authorization !== auth)
                return new Response('', { status: 401 });
            const query = JSON.parse(options.body).query;
            return Response.json({
                data: query.includes('LibraryExport')
                    ? { chapters: { totalCount: 1, nodes: [chapter] } }
                    : { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
            });
        },
    });
    const url = await listen(gateway, t);
    const headers = {
        authorization: auth,
        origin: 'https://reader.example',
        'X-Suwayomi-Private': '1',
        'Content-Type': 'application/json',
    };
    const plan = '/private-api/exports/plan';
    const archive = '/private-api/exports/archive?format=cbz&chapterIds=17';
    assert.equal((await fetch(url + archive)).status, 401);
    assert.equal((await fetch(url + plan, { method: 'POST', body: '{"chapterIds":[17]}' })).status, 401);
    assert.equal((await fetch(url + archive, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal(
        (
            await fetch(url + plan, {
                method: 'POST',
                headers: { ...headers, origin: 'https://evil.example' },
                body: '{"chapterIds":[17]}',
            })
        ).status,
        403,
    );
    const response = await fetch(url + plan, { method: 'POST', headers, body: '{"chapterIds":[17]}' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).readyCount, 1);
    const invalid = await fetch(url + archive.replace('17', '17%2F..'), { headers });
    assert.equal(invalid.status, 400);
});
