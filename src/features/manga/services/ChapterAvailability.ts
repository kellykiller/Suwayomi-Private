/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type ChapterAvailability = 'readable' | 'empty' | 'failed' | 'cancelled';
export type AvailabilityManga = { id: number; sourceId: string };

type Task = {
    manga: AvailabilityManga;
    controller: AbortController;
    users: number;
    promise: Promise<ChapterAvailability>;
    resolve: (status: ChapterAvailability) => void;
};

function lifetime(status: ChapterAvailability) {
    if (status === 'readable') {
        return 600000;
    }
    if (status === 'empty') {
        return 120000;
    }
    return 15000;
}

// Source listings usually contain an unfetched database count of zero. Only a
// successful chapter fetch can establish that a listing is really empty.
export function createChapterAvailability({ fetchImpl = fetch, spacing = 350, timeout = 20000, now = Date.now } = {}) {
    const cache = new Map<number, { status: ChapterAvailability; expires: number }>();
    const tasks = new Map<number, Task>();
    const queue: Task[] = [];
    const activeSources = new Set<string>();
    const nextStart = new Map<string, number>();
    let active = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async (task: Task): Promise<ChapterAvailability> => {
        try {
            const response = await fetchImpl('/api/graphql', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.any([task.controller.signal, AbortSignal.timeout(timeout)]),
                body: JSON.stringify({
                    query: 'mutation ReadableManga($id: Int!) { fetchMangaAndChapters(input: { id: $id, fetchManga: false, fetchChapters: true }) { chapters { id } } }',
                    variables: { id: task.manga.id },
                }),
            });
            if (!response.ok) {
                return 'failed';
            }
            const value = await response.json();
            const chapters = value.data?.fetchMangaAndChapters?.chapters;
            if (
                value.errors?.length ||
                !Array.isArray(chapters) ||
                chapters.some((chapter) => !Number.isInteger(chapter?.id))
            ) {
                return 'failed';
            }
            return chapters.length ? 'readable' : 'empty';
        } catch {
            return task.controller.signal.aborted ? 'cancelled' : 'failed';
        }
    };
    function start(task: Task) {
        const { id, sourceId } = task.manga;
        void read(task).then((status) => {
            if (status !== 'cancelled') {
                cache.delete(id);
                cache.set(id, {
                    status,
                    expires: now() + lifetime(status),
                });
                while (cache.size > 2000) {
                    cache.delete(cache.keys().next().value!);
                }
            }
            if (tasks.get(id) === task) {
                tasks.delete(id);
            }
            active--;
            activeSources.delete(sourceId);
            if (!queue.some((queued) => queued.manga.sourceId === sourceId)) {
                nextStart.delete(sourceId);
            }
            task.resolve(status);
            pump();
        });
    }
    function pump() {
        clearTimeout(timer);
        for (let index = 0; index < queue.length && active < 3;) {
            const task = queue[index];
            const { sourceId, id } = task.manga;
            if (!task.users) {
                queue.splice(index, 1);
                if (tasks.get(id) === task) {
                    tasks.delete(id);
                }
                task.resolve('cancelled');
                continue;
            }
            if (activeSources.has(sourceId) || (nextStart.get(sourceId) ?? 0) > now()) {
                index++;
                continue;
            }
            queue.splice(index, 1);
            active++;
            activeSources.add(sourceId);
            nextStart.set(sourceId, now() + spacing);
            start(task);
        }
        const waits = queue
            .filter((task) => !activeSources.has(task.manga.sourceId))
            .map((task) => Math.max(1, (nextStart.get(task.manga.sourceId) ?? 0) - now()));
        if (active < 3 && waits.length) {
            timer = setTimeout(pump, Math.min(...waits));
        }
    }

    const inspect = (manga: AvailabilityManga, signal: AbortSignal): Promise<ChapterAvailability> => {
        if (signal.aborted) {
            return Promise.resolve('cancelled');
        }
        const saved = cache.get(manga.id);
        if (saved && saved.expires > now()) {
            return Promise.resolve(saved.status);
        }
        let task = tasks.get(manga.id);
        if (!task || task.controller.signal.aborted) {
            let resolve!: Task['resolve'];
            const promise = new Promise<ChapterAvailability>((done) => {
                resolve = done;
            });
            task = { manga, controller: new AbortController(), users: 0, promise, resolve };
            tasks.set(manga.id, task);
            queue.push(task);
        }
        const shared = task;
        shared.users++;
        return new Promise((resolve) => {
            let done = false;
            const finish = (status: ChapterAvailability) => {
                if (done) {
                    return;
                }
                done = true;
                signal.removeEventListener('abort', abort);
                shared.users--;
                if (!shared.users && tasks.get(manga.id) === shared) {
                    shared.controller.abort();
                }
                resolve(status);
                pump();
            };
            function abort() {
                finish('cancelled');
            }
            signal.addEventListener('abort', abort, { once: true });
            void shared.promise.then(finish);
            pump();
        });
    };
    return {
        inspect,
        retryFailed: (ids: number[]) => {
            for (const id of ids) {
                if (cache.get(id)?.status === 'failed') {
                    cache.delete(id);
                }
            }
        },
    };
}

export const chapterAvailability = createChapterAvailability();
