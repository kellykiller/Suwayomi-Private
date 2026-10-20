/* SPDX-License-Identifier: MPL-2.0 */
import { assert } from './common.mjs';

// Reads persisted output only. No source fetch, translation or paid API request.
export function createTranslationStatusReader({ upstream, fetchImpl = fetch, translations, cloud }) {
    return async (mangaId, req) => {
        assert(Number.isSafeInteger(mangaId) && mangaId > 0, 'Ungültige Mangakennung.');
        const [jobs, batches] = await Promise.all([translations.list(), cloud.list({ all: true })]);
        const candidates = new Set([
            ...jobs
                .filter((job) => job.mangaId === mangaId && (job.outputReady || job.phase === 'completed'))
                .map((job) => job.chapterId),
            ...batches.flatMap((batch) =>
                batch.chapters
                    .filter((item) => item.mangaId === mangaId && item.outputReady)
                    .map((item) => item.chapterId),
            ),
        ]);
        if (!candidates.size) return { mangaId, statuses: [] };
        const chapters = [];
        for (let offset = 0; offset < 20000; offset += 1000) {
            const response = await fetchImpl(new URL('/api/graphql', upstream), {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(15000),
                headers: {
                    'Content-Type': 'application/json',
                    ...Object.fromEntries(
                        Object.entries(req.headers).filter(([key]) => ['authorization', 'cookie'].includes(key)),
                    ),
                },
                body: JSON.stringify({
                    query: 'query TranslationStatuses($mangaId: Int!, $offset: Int!) { chapters(condition: { mangaId: $mangaId }, first: 1000, offset: $offset) { totalCount nodes { id name mangaId sourceOrder pageCount manga { id title } } } }',
                    variables: { mangaId, offset },
                }),
            });
            assert(response.ok, 'Übersetzungsstatus konnte nicht geprüft werden.');
            const value = await response.json(),
                payload = value.data?.chapters;
            assert(!value.errors?.length && Array.isArray(payload?.nodes), 'Kapitelinformationen fehlen.');
            chapters.push(
                ...payload.nodes.filter((chapter) => chapter.mangaId === mangaId && candidates.has(chapter.id)),
            );
            if (offset + payload.nodes.length >= payload.totalCount || !payload.nodes.length) break;
        }
        const statuses = [];
        // Serial local reads avoid issuing hundreds of filesystem operations at once.
        for (const chapter of chapters) {
            try {
                const available =
                    (await cloud.available(chapter.id, chapter)) || (await translations.available(chapter.id, chapter));
                if (!available) continue;
                const pages = available.pageCount ?? available.pages.length;
                const translatedPages = available.translatedPages ?? pages;
                if (!translatedPages) continue;
                statuses.push({
                    chapterId: chapter.id,
                    state: available.retainedRegions ? 'retained' : translatedPages < pages ? 'partial' : 'translated',
                    translatedPages,
                    pageCount: pages,
                });
            } catch {
                statuses.push({
                    chapterId: chapter.id,
                    state: 'unavailable',
                    translatedPages: 0,
                    pageCount: chapter.pageCount,
                });
            }
        }
        return { mangaId, statuses };
    };
}
