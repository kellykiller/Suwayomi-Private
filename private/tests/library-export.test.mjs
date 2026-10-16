/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryExportService, exportSelection, exportFileName } from '../server/library-export.mjs';

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
