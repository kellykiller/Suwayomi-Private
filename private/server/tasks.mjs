/* SPDX-License-Identifier: MPL-2.0 */
import { assert } from './common.mjs';
const running = (job) => !['ready', 'paused', 'partial', 'completed'].includes(job.phase);
export function createTaskService({ translations, ai, jobReader, upstream, fetchImpl = fetch }) {
    async function privateTasks(req) {
        const tasks = [],
            warnings = [];
        const results = await Promise.allSettled([
            (async () => {
                const jobs = await translations.list();
                const active = await translations.active?.();
                const candidates = jobs.filter(
                    (job) => running(job) || ['paused', 'ready', 'partial'].includes(job.phase),
                );
                if (active && !candidates.some((job) => job.id === active.id)) candidates.unshift(active);
                return candidates
                    .sort(
                        (a, b) => Number(b.id === active?.id || running(b)) - Number(a.id === active?.id || running(a)),
                    )
                    .slice(0, 50)
                    .map((job) => ({
                        kind: 'translation',
                        pausable: true,
                        pauseRequested: !!(job.id === active?.id ? active.pauseRequested : job.pauseRequested),
                        id: job.id,
                        title: `${job.title} – ${job.chapterName}`,
                        phase: job.id === active?.id ? active.phase : job.phase,
                        active: job.id === active?.id || running(job),
                        cancellable: job.id === active?.id || running(job),
                        href: `/settings/translations?chapter=${job.chapterId}&job=${job.id}`,
                        detail: job.error || `${job.completedPages}/${job.pageCount} Seiten übersetzt`,
                        progress: job.id === active?.id ? active.progress : undefined,
                    }));
            })(),
            (async () => {
                const job = ai.active(req);
                return job
                    ? [
                          {
                              kind: 'ai',
                              id: job.id,
                              title: 'KI-Suche',
                              phase: job.phase,
                              active: true,
                              cancellable: true,
                              href: '/sources/ai/search',
                              detail: `${job.completedSources || 0}/${job.sources?.length || 0} Quellen · ${job.checkedQueries || 0} Suchanfragen`,
                          },
                      ]
                    : [];
            })(),
            (async () => {
                const job = await jobReader();
                return job
                    ? [
                          {
                              kind: 'update',
                              id: job.id,
                              title: job.action === 'rollback' ? 'Rückkehr zur vorherigen Version' : 'Private Updates',
                              phase: job.phase,
                              active: true,
                              cancellable: false,
                              href: '/settings/private-updates',
                              detail:
                                  job.message ||
                                  'Build und Bereitstellung können hier nicht sicher abgebrochen werden.',
                          },
                      ]
                    : [];
            })(),
        ]);
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') tasks.push(...result.value);
            else
                warnings.push(
                    ['Kapitelverarbeitung', 'KI-Suche', 'Private Updates'][index] +
                        ': Status konnte nicht geladen werden.',
                );
        });
        return { tasks, warnings };
    }
    async function list(req) {
        const result = await privateTasks(req);
        try {
            const response = await fetchImpl(new URL('/api/graphql', upstream), {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(8000),
                headers: {
                    'Content-Type': 'application/json',
                    ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
                },
                body: JSON.stringify({
                    query: 'query PrivateBackgroundTasks { downloadStatus { state queue { state } } libraryUpdateStatus { jobsInfo { isRunning totalJobs finishedJobs } } }',
                }),
            });
            assert(response.ok, 'Server nicht erreichbar.');
            const value = await response.json();
            if (value.errors?.length)
                result.warnings.push('Einige native Server-Aufgaben konnten nicht geladen werden.');
            const downloads = value.data?.downloadStatus;
            if (downloads?.queue?.length)
                result.tasks.push({
                    kind: 'downloads',
                    id: 'native-downloads',
                    title: 'Manga-Downloads',
                    phase: downloads.state,
                    active: downloads.state === 'STARTED',
                    cancellable: false,
                    href: '/downloads',
                    detail: `${downloads.queue.length} Kapitel in der Warteschlange · ${downloads.queue.filter((item) => item.state === 'DOWNLOADING').length} werden heruntergeladen · ${downloads.queue.filter((item) => item.state === 'ERROR').length} Fehler. Verwaltung und Abbruch in der Downloadansicht.`,
                });
            const updates = value.data?.libraryUpdateStatus?.jobsInfo;
            if (updates?.isRunning)
                result.tasks.push({
                    kind: 'library',
                    id: 'native-library',
                    title: 'Bibliothek aktualisieren',
                    phase: 'running',
                    active: true,
                    cancellable: false,
                    href: '/updates',
                    detail: `${updates.finishedJobs}/${updates.totalJobs} Aufgaben abgeschlossen`,
                    progress: { completed: updates.finishedJobs, total: updates.totalJobs },
                });
            if (!downloads || !updates) result.warnings.push('Native Aufgaben sind teilweise nicht verfügbar.');
        } catch {
            result.warnings.push('Suwayomi-Downloads und Bibliotheksaktualisierung konnten nicht geladen werden.');
        }
        result.tasks.sort((a, b) => Number(b.active) - Number(a.active));
        return result;
    }
    async function cancel(input, req) {
        assert(
            input &&
                ['translation', 'ai'].includes(input.kind) &&
                typeof input.id === 'string' &&
                /^[a-f0-9-]{36}$/.test(input.id),
            'Diese Aufgabe kann hier nicht abgebrochen werden.',
        );
        if (input.kind === 'translation') await translations.cancel(input.id);
        else await ai.cancel(input.id, req);
        return { requested: true };
    }
    async function pause(input) {
        assert(
            input?.kind === 'translation' && typeof input.id === 'string' && /^[a-f0-9-]{36}$/.test(input.id),
            'Nur Kapitelverarbeitung kann hier pausiert werden.',
        );
        await translations.pause(input.id);
        return { requested: true };
    }
    return { list, privateTasks, cancel, pause };
}
