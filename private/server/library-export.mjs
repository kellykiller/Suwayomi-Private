/* SPDX-License-Identifier: MPL-2.0 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const requireValue = (condition, message) => {
    if (!condition) throw new Error(message);
};
export function exportSelection(value) {
    requireValue(value && typeof value === 'object', 'Exportauswahl fehlt.');
    const mangaIds = value.mangaIds ?? [];
    const chapterIds = value.chapterIds ?? [];
    for (const [ids, maximum] of [
        [mangaIds, 20],
        [chapterIds, 1000],
    ]) {
        requireValue(Array.isArray(ids) && ids.length <= maximum, 'Exportauswahl ist zu groß.');
        requireValue(
            ids.every((id) => Number.isSafeInteger(id) && id > 0),
            'Ungültige Exportkennung.',
        );
    }
    requireValue(Boolean(mangaIds.length) !== Boolean(chapterIds.length), 'Entweder Manga oder Kapitel auswählen.');
    return { mangaIds: [...new Set(mangaIds)], chapterIds: [...new Set(chapterIds)] };
}

export function exportFileName(value) {
    const result = String(value)
        .normalize('NFC')
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 80)
        .replace(/[. ]+$/g, '');
    return !result || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(result) ? `_${result || 'Manga'}` : result;
}

export function createLibraryExportService({ upstream, fetchImpl = fetch, python = '/opt/ocr/bin/python' }) {
    const script = fileURLToPath(new URL('../translation/export_archive.py', import.meta.url));
    const credentials = (req) =>
        Object.fromEntries(Object.entries(req.headers).filter(([key]) => ['authorization', 'cookie'].includes(key)));

    async function plan(value, req, signal) {
        const selection = exportSelection(value);
        const filter = selection.mangaIds.length
            ? { mangaId: { in: selection.mangaIds } }
            : { id: { in: selection.chapterIds } };
        const chapters = [];
        let offset = 0;
        let totalCount = 0;
        do {
            const response = await fetchImpl(new URL('/api/graphql', upstream), {
                method: 'POST',
                redirect: 'error',
                headers: { ...credentials(req), 'Content-Type': 'application/json' },
                signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
                body: JSON.stringify({
                    query: `query LibraryExport($filter: ChapterFilterInput!, $offset: Int!) {
                        chapters(filter: $filter, first: 200, offset: $offset) {
                            totalCount
                            nodes { id name mangaId sourceOrder isDownloaded pageCount manga { id title } }
                        }
                    }`,
                    variables: { filter, offset },
                }),
            });
            requireValue(response.ok, `Exportauswahl konnte nicht geladen werden (HTTP ${response.status}).`);
            const result = await response.json();
            const connection = result.data?.chapters;
            requireValue(!result.errors?.length && Array.isArray(connection?.nodes), 'Kapitelinformationen fehlen.');
            totalCount = connection.totalCount;
            requireValue(Number.isSafeInteger(totalCount) && totalCount <= 20000, 'Maximal 20.000 Kapitel pro Export.');
            requireValue(connection.nodes.length > 0 || offset >= totalCount, 'Unvollständige Kapitelliste.');
            chapters.push(...connection.nodes);
            offset += connection.nodes.length;
        } while (offset < totalCount);
        requireValue(chapters.length > 0, 'Keine Kapitel vorhanden. Kapitel zuerst in Suwayomi laden.');
        requireValue(
            new Set(chapters.map((chapter) => chapter.id)).size === chapters.length,
            'Kapitelliste hat sich geändert. Erneut versuchen.',
        );
        const requested = selection.chapterIds.length ? selection.chapterIds : selection.mangaIds;
        const found = new Set(chapters.map((chapter) => (selection.chapterIds.length ? chapter.id : chapter.mangaId)));
        requireValue(
            requested.every((id) => found.has(id)),
            'Mindestens ein ausgewähltes Kapitel oder Manga enthält keine verfügbaren Kapitel.',
        );
        requireValue(
            chapters.every(
                (chapter) =>
                    Number.isSafeInteger(chapter.id) &&
                    chapter.id > 0 &&
                    Number.isSafeInteger(chapter.mangaId) &&
                    Number.isFinite(chapter.sourceOrder) &&
                    (selection.chapterIds.length
                        ? requested.includes(chapter.id)
                        : requested.includes(chapter.mangaId)),
            ),
            'Ungültige Kapitelantwort.',
        );
        chapters.sort((a, b) => a.mangaId - b.mangaId || b.sourceOrder - a.sourceOrder || a.id - b.id);
        const missing = chapters.filter((chapter) => !chapter.isDownloaded || !(chapter.pageCount > 0));
        const mangaCount = new Set(chapters.map((chapter) => chapter.mangaId)).size;
        return {
            selection,
            chapters,
            missingIds: missing.map((chapter) => chapter.id),
            chapterCount: chapters.length,
            readyCount: chapters.length - missing.length,
            mangaCount,
            title: mangaCount === 1 ? chapters[0].manga.title : `${mangaCount} Manga`,
        };
    }

    async function archive(value, format, req, res) {
        requireValue(['cbz', 'folders'].includes(format), 'Ungültiges Exportformat.');
        const controller = new AbortController();
        const stop = () => controller.abort();
        res.once('close', stop);
        let directory;
        let child;
        let childDone;
        try {
            const result = await plan(value, req, controller.signal);
            requireValue(!result.missingIds.length, 'Kapitel fehlen auf dem NAS. Zuerst vollständig herunterladen.');
            directory = await fs.mkdtemp(join(tmpdir(), 'suwayomi-export-'));
            const oneCbz = format === 'cbz' && result.chapterCount === 1;
            const filename = `${exportFileName(result.title)}${oneCbz ? ' - ' + exportFileName(result.chapters[0].name) : ''}.${oneCbz ? 'cbz' : 'zip'}`;
            child = spawn(python, ['-u', script], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
            });
            let errorText = '';
            child.stderr.on('data', (chunk) => {
                errorText = (errorText + chunk.toString()).slice(-4000);
            });
            childDone = new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('close', (code) =>
                    code === 0 ? resolve() : reject(new Error(errorText.trim() || 'Bildexport fehlgeschlagen.')),
                );
            });
            // Attach immediately: spawn/worker errors must never become unhandled rejections.
            childDone.catch(() => {});
            child.stdin.on('error', () => {});
            child.stdin.end(
                JSON.stringify({
                    upstream: String(upstream),
                    headers: credentials(req),
                    directory,
                    format,
                    chapters: result.chapters,
                }),
            );
            const kill = () => child.kill('SIGTERM');
            controller.signal.addEventListener('abort', kill, { once: true });
            try {
                if (controller.signal.aborted) kill();
                child.stdout.once('data', () => {
                    res.writeHead(200, {
                        'Content-Type': oneCbz ? 'application/vnd.comicbook+zip' : 'application/zip',
                        'Content-Disposition': `attachment; filename="suwayomi-export.${oneCbz ? 'cbz' : 'zip'}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase())}`,
                        'Cache-Control': 'no-store',
                        'X-Content-Type-Options': 'nosniff',
                    });
                });
                await pipeline(child.stdout, res, { signal: controller.signal, end: false });
                await childDone;
                res.end();
            } finally {
                controller.signal.removeEventListener('abort', kill);
            }
        } finally {
            res.off('close', stop);
            if (child && child.exitCode === null) child.kill('SIGTERM');
            await childDone?.catch(() => {});
            if (directory) await fs.rm(directory, { recursive: true, force: true });
        }
    }
    return { plan, archive };
}
