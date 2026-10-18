/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, readJson, writeJson, exists } from './common.mjs';
import { exportSelection } from './library-export.mjs';
import { boundedText } from './log-utils.mjs';

export const CLOUD_MODEL = 'gpt-6-astra';
export const cloudId = (id) =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const completed = (status) => ['completed', 'completed_with_retained_regions'].includes(status);
const remoteActive = (status) => ['queued', 'running', 'cancelling'].includes(status);
const selectionKey = (value) =>
    JSON.stringify({
        mangaIds: [...value.mangaIds].sort((a, b) => a - b),
        chapterIds: [...value.chapterIds].sort((a, b) => a - b),
    });
const credentials = (req) => ({
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => ['authorization', 'cookie'].includes(k))),
});
const identity = (chapter) =>
    JSON.stringify([chapter.id, chapter.mangaId, chapter.sourceOrder, chapter.name, chapter.manga.title]);
const wait = (ms, signal) =>
    new Promise((done, reject) => {
        signal.throwIfAborted();
        const abort = () => {
            clearTimeout(timer);
            reject(new Error('Auftrag unterbrochen.'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            done();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });

export function createCloudTranslationService({
    upstream,
    libraryExports,
    chapterReader,
    fetchImpl = fetch,
    root = '/update/cloud-translations',
    tokenFile = '/secrets/cloud-translator.token',
    serviceUrl = 'http://127.0.0.1:18083',
    python = '/opt/ocr/bin/python',
    pollMs = 2000,
    updateBusy = async () => null,
    otherBusy = () => false,
    logs,
} = {}) {
    const target = new URL(serviceUrl);
    assert(
        target.protocol === 'http:' &&
            target.hostname === '127.0.0.1' &&
            !target.username &&
            !target.password &&
            target.pathname === '/',
        'Cloud-Dienst muss lokal am NAS liegen.',
    );
    const batches = new Map();
    let initialized,
        task,
        stopping = false,
        mutating = false;
    const directory = (id) => {
        assert(cloudId(id), 'Ungueltige Auftragskennung.');
        return resolve(root, id);
    };
    const save = async (batch) => {
        batch.updated = new Date().toISOString();
        await writeJson(directory(batch.id) + '/batch.json', batch);
    };
    const load = () =>
        (initialized ||= (async () => {
            const names = await fs.readdir(root).catch((error) => {
                if (error.code === 'ENOENT') return [];
                throw error;
            });
            for (const name of names) {
                if (!cloudId(name)) continue;
                const batch = await readJson(directory(name) + '/batch.json').catch(() => null);
                if (!batch || batch.id !== name) continue;
                if (['queued', 'running', 'cancelling'].includes(batch.phase)) {
                    batch.phase = 'interrupted';
                    batch.message = 'WebUI neu gestartet. Gespeicherte Auftraege pruefen und bei Bedarf fortsetzen.';
                    await save(batch);
                }
                batches.set(name, batch);
            }
        })());

    async function token() {
        const value = (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim();
        assert(
            value.length >= 32 && value.length <= 4096 && !/\s/.test(value),
            'Cloud-Anbindung fehlt. Internen Zugriffstoken auf dem NAS einrichten.',
        );
        return value;
    }
    async function request(path, options = {}, signal) {
        const response = await fetchImpl(new URL(path, target), {
            ...options,
            headers: { ...(options.headers || {}), Authorization: 'Bearer ' + (await token()) },
            redirect: 'error',
            signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]),
        }).catch(() => {
            throw new Error('Cloud-Dienst nicht erreichbar. Kein Auftrag wird automatisch erneut eingereicht.');
        });
        if (response.status === 404 && options.allowMissing) {
            await response.body?.cancel();
            return null;
        }
        if (!response.ok) {
            let detail = '';
            try {
                const body = JSON.parse(await boundedText(response, 4096));
                if (typeof body.error === 'string')
                    detail = body.error
                        .replaceAll(await token(), '[TOKEN]')
                        .replace(/[\u0000-\u001f\u007f]/g, ' ')
                        .slice(0, 350);
            } catch {}
            throw new Error(
                `Cloud-Dienst: HTTP ${response.status}.${detail ? ' ' + detail : ''} Auftrag pruefen; keine automatische Wiederholung.`,
            );
        }
        return response;
    }
    async function remote(id, signal) {
        const response = await request('/v1/jobs/' + id, { allowMissing: true }, signal);
        if (!response) return null;
        const result = await response.json();
        assert(
            result.id === id &&
                result.model === CLOUD_MODEL &&
                typeof result.status === 'string' &&
                Number.isInteger(result.pages) &&
                result.pages >= 1 &&
                result.pages <= 100 &&
                (result.source_entries === undefined ||
                    (Number.isInteger(result.source_entries) &&
                        result.source_entries >= 1 &&
                        result.source_entries <= 100)),
            'Cloud-Auftragsantwort passt nicht zur Anfrage.',
        );
        return result;
    }
    async function status() {
        const response = await fetchImpl(new URL('/healthz', target), {
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        assert(response?.ok, 'Cloud-Dienst auf dem NAS ist nicht erreichbar.');
        const health = await response.json();
        assert(health.status === 'ok' && health.model === CLOUD_MODEL, 'Unerwarteter Cloud-Dienst.');
        const linked = await exists(tokenFile);
        let authorized = false;
        if (linked) {
            try {
                const check = await request('/v1/jobs');
                authorized = !!check;
                await check.body?.cancel();
            } catch {}
        }
        return {
            ready: authorized && !!health.credentials?.google && !!health.credentials?.openai,
            linked: authorized,
            model: CLOUD_MODEL,
            credentials: { google: !!health.credentials?.google, openai: !!health.credentials?.openai },
        };
    }
    async function plan(input, req) {
        await load();
        const value = await libraryExports.plan(input, req);
        assert(value.chapterCount <= 1000, 'Maximal 1000 Kapitel pro Auftrag.');
        const chapters = [];
        const previousChapters = new Map(
            [...batches.values()]
                .flatMap((b) => b.chapters)
                .filter((c) => c.outputReady)
                .map((c) => [c.identity, c]),
        );
        for (const chapter of value.chapters) {
            const previous = previousChapters.get(identity(chapter));
            chapters.push({
                ...chapter,
                alreadyTranslated: !!previous && previous.pageCount === chapter.pageCount,
            });
        }
        const pending = chapters.filter((c) => !c.alreadyTranslated);
        assert(
            pending.every((c) => !c.isDownloaded || (c.pageCount >= 1 && c.pageCount <= 100)),
            'Ein Kapitel hat mehr als 100 Seiten. Bitte kleinere Kapitel auswaehlen.',
        );
        return {
            selection: value.selection,
            title: value.title,
            chapterCount: chapters.length,
            newChapters: pending.length,
            alreadyTranslated: chapters.length - pending.length,
            missingDownloads: pending.filter((c) => !c.isDownloaded).length,
            knownPages: pending.reduce((n, c) => n + (c.pageCount || 0), 0),
            chapters,
            model: CLOUD_MODEL,
            maxOpenAI: 160,
        };
    }
    async function get(id, refresh = true) {
        await load();
        const batch = batches.get(id);
        assert(batch && cloudId(id), 'Cloud-Auftrag nicht gefunden.');
        if (refresh && !task) {
            for (const item of batch.chapters.filter(
                (c) => c.remoteStatus && !c.outputReady && c.status !== 'skipped',
            )) {
                const state = await remote(item.id).catch(() => null);
                if (state) {
                    item.remoteStatus = state.status;
                    item.progress = state.progress;
                }
            }
        }
        return structuredClone(batch);
    }
    async function list() {
        await load();
        return [...batches.values()]
            .sort((a, b) => b.created.localeCompare(a.created))
            .slice(0, 100)
            .map((b) => structuredClone(b));
    }
    async function enqueue(chapter, req, signal) {
        const response = await fetchImpl(new URL('/api/graphql', upstream), {
            method: 'POST',
            headers: { ...req.headers, 'Content-Type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            body: JSON.stringify({
                query: 'mutation CloudDownload($input: EnqueueChapterDownloadInput!) { enqueueChapterDownload(input:$input) { downloadStatus { state } } }',
                variables: { input: { id: chapter.id } },
            }),
        });
        const value = await response.json();
        assert(
            response.ok && !value.errors?.length && value.data?.enqueueChapterDownload,
            'Kapitel konnte nicht in Suwayomis Download-Warteschlange eingereiht werden.',
        );
    }
    function launch(batch, req) {
        const controller = new AbortController();
        const current = { id: batch.id, controller };
        task = current;
        current.promise = run(batch, credentials(req), controller.signal)
            .catch(async (error) => {
                batch.phase = controller.signal.aborted ? 'interrupted' : 'failed';
                batch.message = controller.signal.aborted
                    ? 'Angehalten. Gespeicherte Antworten bleiben erhalten.'
                    : String(error.message).slice(0, 500);
                await save(batch);
                await logs?.write('translation', 'ERROR', batch.message, batch.id);
            })
            .finally(() => {
                if (task === current) task = undefined;
            });
        current.promise.catch(() => {});
    }
    async function run(batch, req, signal) {
        batch.phase = 'running';
        batch.message = 'Kapitel werden nacheinander automatisch verarbeitet.';
        await save(batch);
        for (const item of batch.chapters) {
            signal.throwIfAborted();
            if (item.outputReady || item.status === 'skipped') continue;
            const path = directory(batch.id) + '/' + item.id;
            await fs.mkdir(path, { recursive: true, mode: 0o700 });
            batch.currentChapter = item.chapterId;
            await save(batch);
            let info = await chapterReader(item.chapterId, req);
            assert(
                identity(info) === item.identity,
                'Kapitel wurde in Suwayomi veraendert. Neuer Auftrag erforderlich.',
            );
            let state = await remote(item.id, signal);
            if (state)
                assert(
                    (state.source_entries ?? state.pages) === item.pageCount,
                    'Gespeicherter Cloud-Auftrag hat eine andere Anzahl Quelldateien.',
                );
            if (!state) {
                item.status = 'preparing';
                await save(batch);
                if (!info.isDownloaded) {
                    item.status = 'downloading';
                    await save(batch);
                    await enqueue({ id: item.chapterId }, req, signal);
                    const started = Date.now();
                    do {
                        assert(
                            Date.now() - started < 30 * 60 * 1000,
                            'Kapitel nach 30 Minuten nicht fertig heruntergeladen. Download-Warteschlange pruefen.',
                        );
                        await wait(pollMs, signal);
                        info = await chapterReader(item.chapterId, req);
                        assert(identity(info) === item.identity, 'Kapitel hat sich waehrend des Downloads geaendert.');
                    } while (!info.isDownloaded);
                }
                assert(info.pageCount >= 1 && info.pageCount <= 100, 'Kapitel muss 1 bis 100 Seiten enthalten.');
                item.pageCount = info.pageCount;
                await save(batch);
                if (!(await exists(path + '/source.cbz'))) {
                    await fs.rm(path + '/source.tmp', { force: true });
                    await libraryExports.archiveFile(item.chapterId, req, path + '/source.tmp', signal);
                    assert(
                        (await fs.stat(path + '/source.tmp')).size <= 256 * 1024 ** 2,
                        'Kapitelarchiv groesser als 256 MiB.',
                    );
                    await fs.rename(path + '/source.tmp', path + '/source.cbz');
                }
                item.status = 'submitting';
                await save(batch);
                const size = (await fs.stat(path + '/source.cbz')).size;
                const source = createReadStream(path + '/source.cbz');
                try {
                    const response = await request(
                        '/v1/jobs',
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/vnd.comicbook+zip',
                                'Content-Length': String(size),
                                'Idempotency-Key': item.id,
                                'X-Max-OpenAI': String(batch.maxOpenAI),
                            },
                            body: source,
                            duplex: 'half',
                        },
                        signal,
                    );
                    state = await response.json();
                    assert(
                        state.id === item.id &&
                            (state.source_entries ?? state.pages) === item.pageCount &&
                            Number.isInteger(state.pages) &&
                            state.pages >= 1 &&
                            state.pages <= 100 &&
                            state.model === CLOUD_MODEL,
                        'Cloud-Eingang passt nicht zum Kapitel.',
                    );
                } finally {
                    source.destroy();
                }
            } else if (state.status === 'cancelling' || (!completed(state.status) && !remoteActive(state.status))) {
                // run() is entered only by an explicit start/resume action, never by a status read.
                while (state.status === 'cancelling') {
                    item.remoteStatus = state.status;
                    await save(batch);
                    await wait(pollMs, signal);
                    state = await remote(item.id, signal);
                    assert(state, 'Cloud-Auftrag fehlt.');
                }
                if (!completed(state.status) && !remoteActive(state.status)) {
                    const resumed = await request('/v1/jobs/' + item.id + '/resume', { method: 'POST' }, signal);
                    await resumed.body?.cancel();
                    state = await remote(item.id, signal);
                }
            }
            item.remoteStatus = state.status;
            item.outputPageCount = state.pages;
            item.status = 'processing';
            await save(batch);
            while (remoteActive(state.status)) {
                await wait(pollMs, signal);
                state = await remote(item.id, signal);
                assert(state, 'Cloud-Auftrag fehlt.');
                item.remoteStatus = state.status;
                item.progress = state.progress;
                await save(batch);
            }
            assert(
                completed(state.status),
                `Kapitel ${item.chapterName}: Cloud-Lauf ${state.status}. Gespeicherte Antworten bleiben erhalten.`,
            );
            item.status = 'importing';
            await save(batch);
            if (!(await exists(path + '/kapitel-de.cbz'))) {
                await fs.rm(path + '/result.tmp', { force: true });
                const response = await request('/v1/jobs/' + item.id + '/result.cbz', {}, signal);
                let size = 0;
                const bound = new Transform({
                    transform(chunk, encoding, callback) {
                        size += chunk.length;
                        callback(size > 4 * 1024 ** 3 ? new Error('Cloud-Ausgabe groesser als 4 GiB.') : null, chunk);
                    },
                });
                await pipeline(
                    Readable.fromWeb(response.body),
                    bound,
                    createWriteStream(path + '/result.tmp', { flags: 'wx', mode: 0o600 }),
                    { signal },
                );
                await fs.rename(path + '/result.tmp', path + '/kapitel-de.cbz');
            }
            await fs.rm(path + '/pages.tmp', { recursive: true, force: true });
            await extract(path, item.outputPageCount, signal);
            await fs.rm(path + '/pages', { recursive: true, force: true });
            await fs.rename(path + '/pages.tmp', path + '/pages');
            item.outputReady = true;
            item.status = state.status;
            item.summary = state.summary
                ? {
                      open_regions: state.summary.open_regions,
                      region_status: state.summary.region_status,
                      new_api_calls: state.summary.new_api_calls,
                  }
                : undefined;
            item.revision = Date.now();
            await save(batch);
            // Source is no longer needed by the gateway; cloud service keeps its own original and cache.
            await fs.rm(path + '/source.cbz', { force: true });
        }
        batch.phase = batch.chapters.some((c) => c.status === 'completed_with_retained_regions')
            ? 'completed_with_retained_regions'
            : 'completed';
        batch.message = 'Verarbeitung abgeschlossen.';
        await save(batch);
    }
    async function extract(path, count, signal) {
        const script = fileURLToPath(new URL('../translation/import_cloud.py', import.meta.url));
        const child = spawn(python, [script, path + '/kapitel-de.cbz', path + '/pages.tmp', String(count)], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        const done = new Promise((done, reject) => {
            child.once('error', () => reject(new Error('Cloud-Import konnte nicht gestartet werden.')));
            child.once('close', (code) =>
                code === 0 ? done() : reject(new Error('Cloud-Bildausgabe ist unvollstaendig oder ungueltig.')),
            );
        });
        done.catch(() => {});
        const abort = () => child.kill('SIGTERM');
        signal.addEventListener('abort', abort, { once: true });
        try {
            signal.throwIfAborted();
            await done;
        } finally {
            signal.removeEventListener('abort', abort);
            if (child.exitCode === null) child.kill('SIGTERM');
        }
    }
    async function free() {
        await load();
        if (task && !['queued', 'running', 'cancelling'].includes(batches.get(task.id)?.phase)) await task.promise;
        assert(!stopping && !task, 'Ein Cloud-Auftrag wird bereits verarbeitet.');
        assert(
            !otherBusy() && !(await updateBusy()),
            'Bitte die laufende Kapitelverarbeitung oder das private Update abwarten.',
        );
    }
    async function start(input, req) {
        assert(
            input?.consent === true && cloudId(input.requestId),
            'Bitte die Uebertragung an Google und OpenAI bestaetigen.',
        );
        const selection = exportSelection(input);
        await load();
        const old = batches.get(input.requestId);
        if (old) {
            assert(old.selectionKey === selectionKey(selection), 'Auftrags-ID gehoert zu einer anderen Auswahl.');
            assert(old.maxOpenAI === (input.maxOpenAI ?? 160), 'Auftrags-ID gehoert zu einer anderen Anfragegrenze.');
            return get(old.id, false);
        }
        await free();
        assert((await status()).ready, 'Cloud-Anbindung oder API-Schluessel fehlen.');
        const planned = await plan(selection, req);
        assert(batches.size < 300, '300 gespeicherte Cloud-Auftraege erreicht. Speicherbestand pruefen.');
        assert(
            [...batches.values()].reduce((n, b) => n + b.chapters.length, 0) + planned.chapterCount <= 5000,
            '5000 gespeicherte Kapitel erreicht. Speicherbestand pruefen.',
        );
        const maxOpenAI = input.maxOpenAI ?? 160;
        assert(
            Number.isInteger(maxOpenAI) && maxOpenAI >= 1 && maxOpenAI <= 160,
            'Anfragegrenze muss zwischen 1 und 160 liegen.',
        );
        const busyIds = new Set(
            [...batches.values()]
                .filter((b) => !completed(b.phase))
                .flatMap((b) =>
                    b.chapters.filter((c) => !c.outputReady && c.status !== 'skipped').map((c) => c.chapterId),
                ),
        );
        assert(
            planned.chapters.every((c) => c.alreadyTranslated || !busyIds.has(c.id)),
            'Fuer mindestens ein Kapitel existiert bereits ein unvollstaendiger Auftrag. Diesen fortsetzen.',
        );
        const batch = {
            id: input.requestId,
            selection,
            selectionKey: selectionKey(selection),
            title: planned.title,
            model: CLOUD_MODEL,
            maxOpenAI,
            created: new Date().toISOString(),
            phase: 'queued',
            message: 'Wartet auf Verarbeitung.',
            chapters: planned.chapters.map((c) => ({
                id: randomUUID(),
                chapterId: c.id,
                mangaId: c.mangaId,
                sourceOrder: c.sourceOrder,
                title: c.manga.title,
                chapterName: c.name,
                identity: identity(c),
                pageCount: c.pageCount,
                outputReady: false,
                status: c.alreadyTranslated ? 'skipped' : 'queued',
            })),
        };
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.mkdir(directory(batch.id), { mode: 0o700 });
        await save(batch);
        batches.set(batch.id, batch);
        launch(batch, req);
        return get(batch.id, false);
    }
    async function resume(input, req) {
        assert(input?.consent === true, 'Bitte moegliche weitere Cloud-Anfragen bestaetigen.');
        await free();
        const batch = batches.get(input.id);
        assert(batch, 'Cloud-Auftrag fehlt.');
        if (completed(batch.phase)) return get(batch.id, false);
        assert((await status()).ready, 'Cloud-Anbindung ist nicht bereit.');
        launch(batch, req);
        return get(batch.id, false);
    }
    async function cancel(id) {
        await load();
        const batch = batches.get(id);
        assert(batch, 'Cloud-Auftrag fehlt.');
        if (completed(batch.phase)) return get(id, false);
        if (task?.id === id) {
            const current = task;
            current.controller.abort();
            await current.promise;
        }
        // A submission may have reached the service even if its HTTP response was lost.
        for (const item of batch.chapters.filter((c) => !c.outputReady && !['skipped', 'queued'].includes(c.status))) {
            const state = await remote(item.id);
            if (state && remoteActive(state.status))
                await (await request('/v1/jobs/' + item.id + '/cancel', { method: 'POST' })).body?.cancel();
        }
        batch.phase = 'cancelled';
        batch.message = 'Abgebrochen. Fertige Ergebnisse und Cloud-Antworten bleiben gespeichert.';
        await save(batch);
        return get(id, false);
    }
    async function available(chapterId, info) {
        await load();
        const item = [...batches.values()]
            .flatMap((b) => b.chapters.map((c) => ({ ...c, batchId: b.id })))
            .filter(
                (c) =>
                    c.chapterId === chapterId &&
                    c.outputReady &&
                    c.identity === identity(info) &&
                    c.pageCount === info.pageCount,
            )
            .sort((a, b) => b.revision - a.revision)[0];
        if (!item) return null;
        const prefix = `/private-api/cloud-translations/files/${item.batchId}/${item.id}`;
        return {
            id: item.id,
            revision: item.revision,
            translatedPages: item.outputPageCount ?? item.pageCount,
            pageCount: item.outputPageCount ?? item.pageCount,
            pages: Array.from({ length: item.outputPageCount ?? item.pageCount }, (_, i) => `${prefix}/page/${i}`),
        };
    }
    async function file(batchId, itemId, page) {
        await load();
        const item = batches.get(batchId)?.chapters.find((c) => c.id === itemId);
        assert(item?.outputReady && cloudId(itemId), 'Fertiges Kapitel nicht gefunden.');
        const path = directory(batchId) + '/' + itemId;
        if (page === null) return { path: path + '/kapitel-de.cbz', type: 'application/vnd.comicbook+zip' };
        assert(
            Number.isInteger(page) && page >= 0 && page < (item.outputPageCount ?? item.pageCount),
            'Ungueltige Seite.',
        );
        return {
            path: path + '/pages/' + String(page + 1).padStart(4, '0') + '.png',
            type: 'image/png',
        };
    }
    const exclusive =
        (fn) =>
        async (...args) => {
            assert(!mutating, 'Eine Cloud-Aktion wird bereits gespeichert.');
            mutating = true;
            try {
                return await fn(...args);
            } finally {
                mutating = false;
            }
        };
    return {
        status,
        plan,
        list,
        get,
        available,
        file,
        start: exclusive(start),
        resume: exclusive(resume),
        cancel: exclusive(cancel),
        busy: () => !!task || mutating,
        stop: async () => {
            stopping = true;
            if (task) {
                task.controller.abort();
                await task.promise;
            }
        },
    };
}
