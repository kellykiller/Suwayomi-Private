/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { cloudApi } from '@/features/translation/CloudTranslation.api.ts';
import type {
    CloudBatch,
    CloudPlan,
    CloudSelection,
    CloudStatus,
} from '@/features/translation/CloudTranslation.api.ts';
import { enableGermanReader } from '@/features/translation/TranslationReader.tsx';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';

const labels: Record<string, string> = {
    queued: 'Wartet',
    running: 'Läuft',
    preparing: 'Kapitel vorbereiten',
    downloading: 'Kapitel auf das NAS herunterladen',
    submitting: 'An Übersetzungsdienst übergeben',
    processing: 'Kapitel übersetzen',
    importing: 'Fertige Seiten auf dem NAS speichern',
    completed: 'Fertig',
    completed_with_retained_regions: 'Fertig – einzelne Bereiche im Original',
    failed: 'Angehalten: Fehler',
    interrupted: 'Unterbrochen',
    cancelled: 'Abgebrochen',
    cancelling: 'Abbruch angefordert',
    skipped: 'Bereits übersetzt',
    ocr_and_review: 'Texte erkennen und prüfen',
    translation: 'Mit Kapitelkontext übersetzen',
    rendering: 'Texte ins Bild einsetzen',
    complete_unit_review: 'Schwierige Textbereiche automatisch prüfen',
};
const done = (phase: string) => ['completed', 'completed_with_retained_regions'].includes(phase);
const active = (phase: string) => ['queued', 'running', 'cancelling'].includes(phase);

export function CloudTranslationScreen() {
    useAppTitle('Übersetzen');
    const [params, setParams] = useSearchParams();
    const batchId = params.get('batch');
    const chapterIds = params.get('chapterIds') || params.get('chapter') || '';
    const mangaIds = params.get('mangaIds') || '';
    const selection = useMemo<CloudSelection>(
        () => ({
            ...(chapterIds ? { chapterIds: chapterIds.split(',').map(Number) } : {}),
            ...(mangaIds ? { mangaIds: mangaIds.split(',').map(Number) } : {}),
        }),
        [chapterIds, mangaIds],
    );
    const [status, setStatus] = useState<CloudStatus>();
    const [plan, setPlan] = useState<CloudPlan>();
    const [batch, setBatch] = useState<CloudBatch>();
    const [jobs, setJobs] = useState<CloudBatch[]>([]);
    const [consent, setConsent] = useState(false);
    const [maximum, setMaximum] = useState('160');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [setupError, setSetupError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        void cloudApi<CloudStatus>('status', undefined, controller.signal)
            .then((value) => {
                if (!controller.signal.aborted) {
                    setStatus(value);
                    setSetupError('');
                }
            })
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setSetupError(reason.message);
                }
            });
        return () => controller.abort();
    }, []);
    useEffect(() => {
        setConsent(false);
        setPlan(undefined);
        setError('');
        if (batchId || (!chapterIds && !mangaIds)) {
            return;
        }
        const controller = new AbortController();
        void cloudApi<CloudPlan>('plan', selection, controller.signal)
            .then((value) => {
                if (!controller.signal.aborted) {
                    setPlan(value);
                }
            })
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setError(reason.message);
                }
            });
        return () => controller.abort();
    }, [selection, batchId]);
    const refresh = useCallback(
        async (signal?: AbortSignal) => {
            const result = await cloudApi<{ jobs: CloudBatch[] }>('jobs', undefined, signal);
            const current = batchId ? await cloudApi<CloudBatch>(`jobs/${batchId}`, undefined, signal) : undefined;
            if (!signal?.aborted) {
                setJobs(result.jobs);
                setBatch(current);
                setConnectionError('');
            }
        },
        [batchId],
    );
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                await refresh(controller.signal);
            } catch (reason) {
                if (!controller.signal.aborted) {
                    setConnectionError(reason instanceof Error ? reason.message : String(reason));
                }
            }
            if (!controller.signal.aborted) {
                timer = setTimeout(() => {
                    void poll();
                }, 2500);
            }
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [refresh]);
    const execute = async (action: () => Promise<void>) => {
        setPending(true);
        setError('');
        try {
            await action();
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setPending(false);
        }
    };
    const completed = batch?.chapters.filter((c) => c.outputReady || c.status === 'skipped').length || 0;
    const anyRunning = jobs.some((j) => active(j.phase));
    const consentField = (
        <FormControlLabel
            control={<Checkbox checked={consent} onChange={(_, checked) => setConsent(checked)} disabled={pending} />}
            label="Ausgewählte Seiten und Textausschnitte an Google Cloud Vision und OpenAI übertragen und kostenpflichtig verarbeiten."
        />
    );
    return (
        <Stack spacing={2} sx={{ p: 2, maxWidth: 1000, mx: 'auto' }}>
            <Typography variant="h5">Übersetzen</Typography>
            <Typography color="text.secondary">
                Kapitel auswählen und automatisch auf Deutsch übersetzen. Fehlende Kapitel werden zuerst über Suwayomi
                auf das NAS geladen. Texterkennung, Prüfung, Übersetzung und Textsatz laufen anschließend ohne einzelne
                Seitenfreigaben.
            </Typography>
            {setupError && <Alert severity="warning">{setupError}</Alert>}
            {status && !status.ready && (
                <Alert severity="warning">
                    Die Verbindung zum Übersetzungsdienst ist noch nicht vollständig eingerichtet.
                </Alert>
            )}
            {status?.ready && (
                <Typography variant="body2">
                    Übersetzungsdienst bereit · Google Cloud Vision · {status.model}
                </Typography>
            )}
            {error && <Alert severity="error">{error}</Alert>}
            {connectionError && (
                <Alert severity="warning">{connectionError} Eine Statusabfrage startet keine neue Übersetzung.</Alert>
            )}
            <Button component={Link} to={AppRoutes.settings.children.tasks.path} sx={{ alignSelf: 'flex-start' }}>
                Laufende Aufgaben
            </Button>
            {!batchId && plan && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={2}>
                        <Typography variant="h6">{plan.title}</Typography>
                        <Typography>
                            {plan.chapterCount} Kapitel ausgewählt · {plan.newChapters} neu zu übersetzen ·{' '}
                            {plan.alreadyTranslated} bereits übersetzt
                        </Typography>
                        {plan.missingDownloads > 0 && (
                            <Typography>
                                {plan.missingDownloads} Kapitel werden zuvor automatisch heruntergeladen.
                            </Typography>
                        )}
                        <Typography variant="body2">
                            {plan.knownPages} derzeit bekannte Seiten. Modell: {plan.model}. Originale bleiben erhalten.
                            Nicht zuverlässig erkannte oder nicht sicher ersetzbare Textbereiche bleiben im Original.
                        </Typography>
                        <TextField
                            type="number"
                            label="Maximale OpenAI-Anfragen je Kapitel"
                            value={maximum}
                            onChange={(event) => setMaximum(event.target.value)}
                            disabled={pending}
                            slotProps={{ htmlInput: { min: 1, max: 160 } }}
                        />
                        <Typography variant="body2">
                            Diese Anzahl ist kein Euro-Limit. Google-OCR und OpenAI werden separat abgerechnet; ein
                            vollständig ausgewählter Manga kann viele Kapitel umfassen.
                        </Typography>
                        {consentField}
                        <Button
                            variant="contained"
                            disabled={
                                pending ||
                                anyRunning ||
                                !consent ||
                                !status?.ready ||
                                !plan.newChapters ||
                                !Number.isInteger(Number(maximum)) ||
                                Number(maximum) < 1 ||
                                Number(maximum) > 160
                            }
                            onClick={() => {
                                void execute(async () => {
                                    const key = `suwayomi-cloud-pending:${JSON.stringify(selection)}`;
                                    const requestId = sessionStorage.getItem(key) || crypto.randomUUID();
                                    sessionStorage.setItem(key, requestId);
                                    const result = await cloudApi<CloudBatch>('start', {
                                        ...selection,
                                        requestId,
                                        consent: true,
                                        maxOpenAI: Number(maximum),
                                    });
                                    setParams({ batch: result.id });
                                    sessionStorage.removeItem(key);
                                });
                            }}
                        >
                            {pending ? 'Bitte warten …' : 'Automatisch übersetzen'}
                        </Button>
                    </Stack>
                </Paper>
            )}
            {batch && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={2}>
                        <Typography variant="h6">{batch.title}</Typography>
                        <Typography>
                            {labels[batch.phase] || batch.phase} · {completed}/{batch.chapters.length} Kapitel fertig
                        </Typography>
                        <LinearProgress
                            variant="determinate"
                            value={batch.chapters.length ? (completed / batch.chapters.length) * 100 : 0}
                        />
                        <Typography>{batch.message}</Typography>
                        {!active(batch.phase) && !done(batch.phase) && (
                            <>
                                {consentField}
                                <Button
                                    variant="contained"
                                    disabled={pending || !consent || anyRunning || !status?.ready}
                                    onClick={() => {
                                        void execute(async () => {
                                            await cloudApi('resume', { id: batch.id, consent: true });
                                        });
                                    }}
                                >
                                    Mit gespeicherten Antworten fortsetzen
                                </Button>
                            </>
                        )}
                        {active(batch.phase) && (
                            <Button
                                color="warning"
                                disabled={pending}
                                onClick={() => {
                                    void execute(async () => {
                                        await cloudApi('cancel', { id: batch.id });
                                    });
                                }}
                            >
                                Auftrag abbrechen
                            </Button>
                        )}
                        {batch.chapters.map((chapter) => (
                            <Paper key={chapter.id} variant="outlined" sx={{ p: 1.5 }}>
                                <Stack spacing={1}>
                                    <Typography>
                                        {chapter.title} – {chapter.chapterName}
                                    </Typography>
                                    <Typography variant="body2">
                                        {labels[chapter.status] || chapter.status}
                                        {chapter.remoteStatus
                                            ? ` · ${labels[chapter.remoteStatus] || chapter.remoteStatus}`
                                            : ''}
                                        {chapter.progress?.status
                                            ? ` · ${labels[chapter.progress.status] || chapter.progress.status}`
                                            : ''}
                                    </Typography>
                                    {chapter.summary?.open_regions ? (
                                        <Typography variant="body2">
                                            {chapter.summary.open_regions} Textbereiche im Original erhalten.
                                        </Typography>
                                    ) : null}
                                    {(chapter.outputReady || chapter.status === 'skipped') && (
                                        <Stack direction="row" spacing={1}>
                                            <Button
                                                component={Link}
                                                to={AppRoutes.reader.path(chapter.mangaId, chapter.sourceOrder)}
                                                onClick={enableGermanReader}
                                            >
                                                Deutsch lesen
                                            </Button>
                                            {chapter.outputReady && (
                                                <Button
                                                    component="a"
                                                    href={`/private-api/cloud-translations/files/${batch.id}/${chapter.id}/result.cbz`}
                                                >
                                                    CBZ speichern
                                                </Button>
                                            )}
                                        </Stack>
                                    )}
                                </Stack>
                            </Paper>
                        ))}
                    </Stack>
                </Paper>
            )}
            <Typography variant="h6">Gespeicherte Aufträge</Typography>
            {!jobs.length && (
                <Typography>
                    Noch keine Cloud-Übersetzungsaufträge vorhanden. Öffne „Übersetzen“ im Menü eines Kapitels oder
                    Manga.
                </Typography>
            )}
            {jobs.map((job) => (
                <Button key={job.id} component={Link} to={`/settings/translations?batch=${job.id}`} variant="outlined">
                    {job.title} · {labels[job.phase] || job.phase} ·{' '}
                    {job.chapters.filter((c) => c.outputReady || c.status === 'skipped').length}/{job.chapters.length}{' '}
                    Kapitel
                </Button>
            ))}
            <Button component={Link} to="/settings/translations?legacy=1" sx={{ alignSelf: 'flex-start' }}>
                Frühere lokale Übersetzungsaufträge öffnen
            </Button>
        </Stack>
    );
}
