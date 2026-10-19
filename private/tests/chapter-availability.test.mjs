/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChapterAvailability } from '../../src/features/manga/services/ChapterAvailability.ts';

const manga = (id, sourceId = '1') => ({ id, sourceId, chapterCount: 0 });
const reply = (chapters) => Response.json({ data: { fetchMangaAndChapters: { chapters } } });
const inspect = (service, value, signal = new AbortController().signal) => service.inspect(value, signal);

test('Unfetched zero counts are checked against real chapter lists; empty and unknown stay distinct', async () => {
    const service = createChapterAvailability({
        spacing: 0,
        fetchImpl: async (_url, options) => {
            const { query, variables } = JSON.parse(options.body);
            assert.match(query, /fetchManga: false, fetchChapters: true/);
            assert.equal(options.credentials, 'same-origin');
            if (variables.id === 1) return reply([{ id: 12 }]);
            if (variables.id === 2) return reply([]);
            if (variables.id === 3) return Response.json({ errors: [{ message: 'Source failure' }] });
            return reply(null);
        },
    });
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map((id) => inspect(service, manga(id)))), [
        'readable',
        'empty',
        'failed',
        'failed',
    ]);
});

test('Checks are deduplicated, cached, expire, and failed checks can explicitly be retried', async () => {
    let calls = 0,
        clock = 0,
        failure = false;
    const service = createChapterAvailability({
        spacing: 0,
        now: () => clock,
        fetchImpl: async () => {
            calls++;
            return failure ? new Response('', { status: 503 }) : reply([]);
        },
    });
    assert.deepEqual(await Promise.all([inspect(service, manga(1)), inspect(service, manga(1))]), ['empty', 'empty']);
    await inspect(service, manga(1));
    assert.equal(calls, 1);
    clock = 120001;
    failure = true;
    assert.equal(await inspect(service, manga(1)), 'failed');
    assert.equal(calls, 2);
    failure = false;
    service.retryFailed([1]);
    assert.equal(await inspect(service, manga(1)), 'empty');
    assert.equal(calls, 3);
});

test('At most three sources run concurrently and each source has only one active check', async () => {
    const activeSources = new Set();
    let active = 0,
        peak = 0;
    const service = createChapterAvailability({
        spacing: 0,
        fetchImpl: async (_url, options) => {
            const id = JSON.parse(options.body).variables.id;
            const source = Math.floor(id / 10);
            assert(!activeSources.has(source));
            activeSources.add(source);
            active++;
            peak = Math.max(peak, active);
            assert(active <= 3);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            activeSources.delete(source);
            return reply([{ id }]);
        },
    });
    const values = [10, 11, 20, 21, 30, 40];
    assert(
        (await Promise.all(values.map((id) => inspect(service, manga(id, String(Math.floor(id / 10))))))).every(
            (status) => status === 'readable',
        ),
    );
    assert.equal(peak, 3);
});

test('Closing a search cancels its queued work without cancelling another subscriber', async () => {
    let calls = 0;
    const service = createChapterAvailability({
        spacing: 0,
        fetchImpl: async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return reply([{ id: 1 }]);
        },
    });
    const controller = new AbortController();
    const first = inspect(service, manga(1), controller.signal);
    const shared = inspect(service, manga(1));
    const queued = inspect(service, manga(2), controller.signal);
    controller.abort();
    assert.deepEqual(await Promise.all([first, shared, queued]), ['cancelled', 'readable', 'cancelled']);
    assert.equal(calls, 1);
});

test('Timeouts remain failures and never enter the empty cache', async () => {
    const service = createChapterAvailability({
        spacing: 0,
        timeout: 10,
        fetchImpl: async (_url, { signal }) => {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 100);
                signal.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(timer);
                        reject(signal.reason);
                    },
                    { once: true },
                );
            });
            return reply([]);
        },
    });
    assert.equal(await inspect(service, manga(1)), 'failed');
});
