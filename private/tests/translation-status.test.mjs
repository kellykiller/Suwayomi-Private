/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationStatusReader } from '../server/translation-status.mjs';
const req = {
    headers: { authorization: 'Basic fixture', cookie: 'session=fixture', 'x-private-secret': 'never-forward' },
};
test('Chapter badges distinguish full, partial and retained translations and use exact chapter IDs', async () => {
    let calls = 0;
    const read = createTranslationStatusReader({
        upstream: 'http://127.0.0.1:18082',
        translations: {
            list: async () => [34, 36, 39].map((chapterId) => ({ chapterId, mangaId: 7, outputReady: true })),
            available: async (id, info) => {
                assert.equal(info.mangaId, 7);
                if (id === 39) throw Error('Moved output directory missing');
                return { pageCount: 10, translatedPages: id === 36 ? 2 : 10, pages: Array(10).fill('/local') };
            },
        },
        cloud: {
            list: async () => [{ chapters: [{ chapterId: 38, mangaId: 7, outputReady: true }] }],
            available: async (id) =>
                id === 38 ? { pageCount: 10, translatedPages: 10, retainedRegions: true, pages: [] } : null,
        },
        fetchImpl: async (_url, options) => {
            calls++;
            assert.equal(options.headers.authorization, req.headers.authorization);
            assert.equal(options.headers['x-private-secret'], undefined);
            const body = JSON.parse(options.body);
            assert(!/mutation|fetchMangaAndChapters/.test(body.query));
            return Response.json({
                data: {
                    chapters: {
                        totalCount: 5,
                        nodes: [34, 35, 36, 38, 39].map((id) => ({
                            id,
                            mangaId: 7,
                            name: 'Chapter 34',
                            sourceOrder: id,
                            pageCount: 10,
                            manga: { id: 7, title: 'Manga' },
                        })),
                    },
                },
            });
        },
    });
    assert.deepEqual(
        (await read(7, req)).statuses.map(({ chapterId, state }) => [chapterId, state]),
        [
            [34, 'translated'],
            [36, 'partial'],
            [38, 'retained'],
            [39, 'unavailable'],
        ],
    );
    assert.equal(calls, 1);
    assert.deepEqual((await read(8, req)).statuses, []);
    assert.equal(calls, 1);
    await assert.rejects(read(0, req), /Mangakennung/);
});
test('A stored output with changed native chapter identity cannot create a badge', async () => {
    const read = createTranslationStatusReader({
        upstream: 'http://127.0.0.1:18082',
        translations: {
            list: async () => [{ mangaId: 7, chapterId: 34, phase: 'completed' }],
            available: async () => null,
        },
        cloud: { list: async () => [], available: async () => null },
        fetchImpl: async () =>
            Response.json({ data: { chapters: { totalCount: 1, nodes: [{ id: 34, mangaId: 7 }] } } }),
    });
    assert.deepEqual((await read(7, req)).statuses, []);
});
