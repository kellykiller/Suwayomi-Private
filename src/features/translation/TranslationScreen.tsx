/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';
import { SpinnerImage } from '@/base/components/SpinnerImage.tsx';
import { OcrPreview } from '@/features/translation/OcrPreview.tsx';
import { translationApi, translationImage } from '@/features/translation/Translation.api.ts';
import type {
    OcrPerformance,
    TranslationBlock,
    TranslationChapter,
    TranslationJob,
} from '@/features/translation/Translation.api.ts';
import { AppRoutes } from '@/base/AppRoute.constants.ts';

const phases: Record<string, string> = {
    queued: 'Vorbereitung',
    downloading: 'Vorhandenen NAS-Download einlesen',
    ocr: 'Lokale Texterkennung',
    ready: 'Texterkennung fertig – bereit zur Prüfung',
    context: 'Kapitelkontext und Glossar',
    translating: 'KI-Übersetzung',
    rendering: 'Übersetzung in Seiten einsetzen',
    completed: 'Übersetzung fertig',
    paused: 'Pausiert',
};
const isRunning = (phase?: string) => !!phase && !['ready', 'paused', 'completed'].includes(phase);
const money = (value: number | null | undefined) =>
    value === null || value === undefined ? 'unbekannt' : `$${value.toFixed(5)}`;

export function TranslationScreen() {
    useAppTitle('Kapitelübersetzung');
    const [params, setParams] = useSearchParams();
    const chapterId = Number(params.get('chapter') || 0);
    const jobId = params.get('job');
    const [chapter, setChapter] = useState<TranslationChapter>();
    const [job, setJob] = useState<TranslationJob>();
    const [jobs, setJobs] = useState<TranslationJob[]>([]);
    const [source, setSource] = useState<'ja' | 'en'>('en');
    const [model, setModel] = useState('gpt-5.4-mini');
    const [reasoning, setReasoning] = useState('medium');
    const [budget, setBudget] = useState('0.50');
    const [consent, setConsent] = useState(false);
    const [acknowledgeUnknown, setAcknowledgeUnknown] = useState(false);
    const [page, setPage] = useState(0);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [draft, setDraft] = useState<TranslationBlock[]>([]);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [pending, setPending] = useState(false);
    const [performance, setPerformance] = useState<OcrPerformance>();
    const [profile, setProfile] = useState<OcrPerformance['profile']>('balanced');
    useEffect(() => {
        const controller = new AbortController();
        void translationApi<OcrPerformance>('performance', undefined, controller.signal)
            .then((value) => {
                setPerformance(value);
                setProfile(value.profile);
            })
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setError(reason.message);
                }
            });
        return () => controller.abort();
    }, []);
    const refresh = useCallback(
        async (signal?: AbortSignal) => {
            const all = await translationApi<{ jobs: TranslationJob[] }>('jobs', undefined, signal);
            setJobs(all.jobs);
            if (jobId) {
                setJob(await translationApi<TranslationJob>(`jobs/${jobId}`, undefined, signal));
            } else {
                setJob(undefined);
                const pendingId = sessionStorage.getItem('suwayomi-translation-pending');
                const recovered =
                    all.jobs.find((item) => item.id === pendingId) || all.jobs.find((item) => isRunning(item.phase));
                if (recovered) {
                    setParams({ chapter: String(recovered.chapterId), job: recovered.id });
                    sessionStorage.removeItem('suwayomi-translation-pending');
                }
            }
            setConnectionError('');
        },
        [jobId],
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
                }, 2000);
            }
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [refresh]);
    useEffect(() => {
        setChapter(undefined);
        if (!chapterId) {
            return undefined;
        }
        const controller = new AbortController();
        void translationApi<{ chapter: TranslationChapter }>(`chapter/${chapterId}`, undefined, controller.signal)
            .then(({ chapter: info }) => {
                setChapter(info);
                setSource(info.manga.source.lang === 'ja' ? 'ja' : 'en');
            })
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setError(reason.message);
                }
            });
        return () => controller.abort();
    }, [chapterId]);
    useEffect(() => {
        setPage(0);
        setPreviewOpen(false);
        setConsent(false);
        setAcknowledgeUnknown(false);
    }, [jobId]);
    useEffect(() => {
        setDraft(structuredClone(job?.pages?.[page]?.blocks || []));
    }, [job?.id, job?.phase, job?.revision, page]);
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
    const running = isRunning(job?.phase);
    const anyRunning = jobs.some((item) => isRunning(item.phase));
    const current = job?.pages?.[page];
    return (
        <Stack spacing={2} sx={{ p: 2, maxWidth: 1200, mx: 'auto' }}>
            <Typography variant="h5">Kapitelübersetzung</Typography>
            <Typography color="text.secondary">
                Japanisch: manga-ocr. Englisch: EasyOCR. Die Texterkennung läuft lokal auf dem NAS; erst die
                ausdrücklich gestartete KI-Übersetzung überträgt Texte und Kontextbilder an OpenAI. Originale bleiben
                unverändert.
            </Typography>
            <Alert severity="info">
                Erster Ausbau: ein vollständig heruntergeladenes Kapitel mit maximal 80 Seiten, Ziel Deutsch. Normale
                helle Sprechblasen werden ersetzt. Schrift auf Zeichnungen, dunklen Flächen und schwierige Soundeffekte
                bleibt bei Unsicherheit erhalten und wird als Hinweis aufgeführt.
            </Alert>
            <Button component={Link} to={AppRoutes.settings.children.tasks.path}>
                Laufende Aufgaben öffnen
            </Button>
            <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={2}>
                    <Typography variant="h6">Lokale OCR-Leistung</Typography>
                    <TextField
                        select
                        label="Leistungsprofil"
                        value={profile}
                        disabled={pending || anyRunning || !performance}
                        onChange={(event) => setProfile(event.target.value as OcrPerformance['profile'])}
                    >
                        <MenuItem value="economical">Sparsam – bis zu 2 CPU-Kerne</MenuItem>
                        <MenuItem value="balanced">Ausgewogen – bis zu 4 CPU-Kerne</MenuItem>
                        <MenuItem value="fast">Schnell – bis zu 8 CPU-Kerne</MenuItem>
                    </TextField>
                    <Typography variant="body2">
                        Wird auf die verfügbaren CPUs begrenzt. Container und OCR-Rechenthreads werden gemeinsam
                        eingestellt; RAM-Limit bleibt 3 GiB. Eine Änderung gilt für den nächsten Verarbeitungslauf.
                        Laufende Texterkennung zuerst abschließen oder abbrechen.
                    </Typography>
                    <Button
                        variant="outlined"
                        disabled={pending || anyRunning || !performance || profile === performance.profile}
                        onClick={() => {
                            void execute(async () => {
                                setPerformance(await translationApi<OcrPerformance>('performance', { profile }));
                            });
                        }}
                    >
                        Leistungsprofil speichern
                    </Button>
                </Stack>
            </Paper>
            {error && <Alert severity="error">{error}</Alert>}
            {connectionError && (
                <Alert severity="warning">{connectionError} Keine KI-Anfrage wird automatisch erneut gestartet.</Alert>
            )}
            <Button component={Link} to={AppRoutes.settings.children.aiUsage.path} sx={{ alignSelf: 'flex-start' }}>
                KI-Verbrauch und Guthaben
            </Button>
            {chapter && !job && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={2}>
                        <Typography variant="h6">
                            {chapter.manga.title} – {chapter.name}
                        </Typography>
                        <Typography>
                            {chapter.pageCount} Seiten ·{' '}
                            {chapter.isDownloaded
                                ? 'Auf dem NAS heruntergeladen'
                                : 'Noch nicht vollständig heruntergeladen'}
                        </Typography>
                        <TextField
                            select
                            label="Quellsprache"
                            value={source}
                            onChange={(event) => setSource(event.target.value as 'ja' | 'en')}
                        >
                            <MenuItem value="en">Englisch</MenuItem>
                            <MenuItem value="ja">Japanisch</MenuItem>
                        </TextField>
                        <Button
                            variant="contained"
                            disabled={pending || anyRunning || !chapter.isDownloaded}
                            onClick={() => {
                                void execute(async () => {
                                    const requestId = crypto.randomUUID();
                                    sessionStorage.setItem('suwayomi-translation-pending', requestId);
                                    try {
                                        const created = await translationApi<TranslationJob>('analyze', {
                                            chapterId,
                                            sourceLanguage: source,
                                            requestId,
                                        });
                                        setJob(created);
                                        setParams({ chapter: String(chapterId), job: created.id });
                                        sessionStorage.removeItem('suwayomi-translation-pending');
                                    } catch (reason) {
                                        // Keep the id for recovery after a lost response; never start another job automatically.
                                        sessionStorage.setItem('suwayomi-translation-pending', requestId);
                                        throw reason;
                                    }
                                });
                            }}
                        >
                            Texterkennung starten – lokal, ohne OpenAI-Aufruf
                        </Button>
                    </Stack>
                </Paper>
            )}
            {!chapter && !job && (
                <Typography>
                    Öffne bei einem heruntergeladenen Kapitel das Menü „Übersetzen“ oder wähle unten einen bestehenden
                    Auftrag.
                </Typography>
            )}
            {job && (
                <>
                    <Paper variant="outlined" sx={{ p: 2 }}>
                        <Stack spacing={2}>
                            <Typography variant="h6">
                                {job.title} – {job.chapterName}
                            </Typography>
                            <Typography>
                                {phases[job.phase] || job.phase} ·{' '}
                                {job.sourceLanguage === 'ja' ? 'Japanisch' : 'Englisch'} → Deutsch
                            </Typography>
                            <Typography>
                                {job.engine} · {job.pageCount} Seiten ·{' '}
                                {job.progress?.stage === 'ocr'
                                    ? (job.progress.blockCount ?? job.blockCount)
                                    : job.blockCount}{' '}
                                Textbereiche · {job.completedPages} Seiten übersetzt
                            </Typography>
                            {!!job.pages?.length && (
                                <Button variant="outlined" onClick={() => setPreviewOpen(true)}>
                                    OCR-Vorschau – erkannte Textbereiche anzeigen
                                </Button>
                            )}
                            {job.progress?.stage === 'ocr' && (
                                <Alert severity="info">
                                    Texterkennung: {job.progress.completed} von {job.progress.total} Seiten bearbeitet.
                                    {job.progress.lastPageSeconds !== undefined &&
                                        ` Letzte Seite: ${job.progress.lastPageSeconds.toFixed(1)} s.`}
                                    {job.progress.elapsedSeconds !== undefined &&
                                        (job.progress.processedThisRun ?? job.progress.completed) > 0 &&
                                        ` Durchschnitt: ${(job.progress.elapsedSeconds / (job.progress.processedThisRun ?? job.progress.completed)).toFixed(1)} s/Seite (ohne Modellstart).`}{' '}
                                    Die Übersetzung startet erst nach Abschluss und Prüfung der Texterkennung.
                                    {!!job.progress.restoredPages &&
                                        ` ${job.progress.restoredPages} Seiten aus dem Zwischenspeicher übernommen.`}
                                </Alert>
                            )}
                            {running && job.resources && (
                                <Typography variant="body2">
                                    Zugewiesen: bis zu {job.resources.cpuCount} CPUs · RAM-Limit{' '}
                                    {(job.resources.memoryLimitBytes / 1024 ** 3).toFixed(0)} GiB.
                                    {job.resources.memoryUsageBytes != null &&
                                        ` RAM-Nutzung: ${(job.resources.memoryUsageBytes / 1024 ** 3).toFixed(2)} GiB.`}
                                    {job.resources.cpuPercent != null &&
                                        ` CPU: ${job.resources.cpuPercent.toFixed(0)} % (100 % = ein Kern).`}
                                    {job.resources.sampledAt &&
                                        ` Messung: ${new Date(job.resources.sampledAt).toLocaleTimeString()}.`}
                                </Typography>
                            )}
                            {job.currentPage && running && <Typography>Aktuelle Seite: {job.currentPage}</Typography>}
                            {running && (
                                <LinearProgress
                                    variant={job.progress?.total ? 'determinate' : 'indeterminate'}
                                    value={
                                        job.progress?.total
                                            ? (job.progress.completed / job.progress.total) * 100
                                            : undefined
                                    }
                                />
                            )}
                            {job.pauseRequested && (
                                <Alert severity="info">
                                    Pausieren angefordert. Die laufende Seite oder KI-Antwort wird noch fertig
                                    gespeichert. Danach kann das Update gestartet werden.
                                </Alert>
                            )}
                            {job.error && (
                                <Alert severity="warning">
                                    {job.error}
                                    <Box>
                                        <Button component={Link} to="/settings/logs?category=ocr">
                                            OCR-Protokoll öffnen
                                        </Button>
                                        <Button component={Link} to="/settings/logs?category=translation">
                                            Übersetzungsprotokoll öffnen
                                        </Button>
                                    </Box>
                                </Alert>
                            )}
                            <Typography>
                                Erfasste geschätzte Kosten: {money(job.costUsd)} · Kostenlimit: {money(job.budgetUsd)}
                            </Typography>
                            {job.unknownCalls > 0 && (
                                <Alert severity="warning">
                                    {job.unknownCalls} Aufruf(e) mit unbekannten Kosten. Diese sind nicht in der
                                    Kostensumme enthalten.
                                </Alert>
                            )}
                            {running && (
                                <Button
                                    variant="outlined"
                                    disabled={pending || job.pauseRequested}
                                    onClick={() => {
                                        void execute(async () => {
                                            setJob(await translationApi<TranslationJob>('pause', { id: job.id }));
                                        });
                                    }}
                                >
                                    {job.pauseRequested ? 'Pausieren angefordert …' : 'Verarbeitung pausieren'}
                                </Button>
                            )}
                            {running && (
                                <Button
                                    color="warning"
                                    disabled={pending}
                                    onClick={() => {
                                        void execute(async () => {
                                            await translationApi('cancel', { id: job.id });
                                        });
                                    }}
                                >
                                    Verarbeitung sofort abbrechen
                                </Button>
                            )}
                            {job.phase === 'completed' && (
                                <Button
                                    component={Link}
                                    to={AppRoutes.reader.path(job.mangaId, job.sourceOrder)}
                                    variant="contained"
                                >
                                    Im Reader öffnen – Übersetzung über das Sprachsymbol einschalten
                                </Button>
                            )}
                        </Stack>
                    </Paper>
                    {['ready', 'paused'].includes(job.phase) && (
                        <Paper variant="outlined" sx={{ p: 2 }}>
                            <Stack spacing={2}>
                                <Typography variant="h6">
                                    {job.blockCount
                                        ? 'Übersetzung starten oder fortsetzen'
                                        : 'Lokale Texterkennung fortsetzen'}
                                </Typography>
                                <Typography color="text.secondary">
                                    {job.blockCount
                                        ? 'Prüfe unten den erkannten Text. Kapitelkontext und fertige Übersetzungen werden wiederverwendet. Nach einem Abbruch kann ein bereits berechneter, aber unvollständiger API-Aufruf erneut kostenpflichtig sein.'
                                        : 'Die lokale Vorbereitung wurde angehalten. Fortsetzen verwendet die gespeicherten OCR-Seiten und beginnt bei der nächsten fehlenden Seite. Dabei wird noch keine OpenAI-Anfrage gestartet.'}
                                </Typography>
                                {!!job.blockCount && (
                                    <>
                                        {!job.calls.length && (
                                            <>
                                                <TextField
                                                    select
                                                    label="Übersetzungsmodell"
                                                    value={model}
                                                    onChange={(event) => setModel(event.target.value)}
                                                >
                                                    <MenuItem value="gpt-5.4-mini">GPT-5.4 mini</MenuItem>
                                                    <MenuItem value="gpt-5.4">GPT-5.4</MenuItem>
                                                </TextField>
                                                <TextField
                                                    select
                                                    label="Reasoning"
                                                    value={reasoning}
                                                    onChange={(event) => setReasoning(event.target.value)}
                                                >
                                                    <MenuItem value="low">Niedrig</MenuItem>
                                                    <MenuItem value="medium">Mittel</MenuItem>
                                                </TextField>
                                            </>
                                        )}
                                        <TextField
                                            label="Gesamtes Kostenlimit dieses Kapitels in USD"
                                            value={budget}
                                            onChange={(event) => setBudget(event.target.value)}
                                            slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                                            helperText="Vorsorgliche Prüfung vor jedem Aufruf. Keine automatische Wiederholung; unbekannte oder externe Kosten können nicht exakt begrenzt werden."
                                        />
                                        <FormControlLabel
                                            control={
                                                <Checkbox
                                                    checked={consent}
                                                    onChange={(_, value) => setConsent(value)}
                                                />
                                            }
                                            label="Kapiteltexte und Kontextbilder zur Übersetzung an OpenAI senden (kostenpflichtige API)."
                                        />
                                        {job.unknownCalls > 0 && (
                                            <FormControlLabel
                                                control={
                                                    <Checkbox
                                                        checked={acknowledgeUnknown}
                                                        onChange={(_, value) => setAcknowledgeUnknown(value)}
                                                    />
                                                }
                                                label="Unbekannte Kosten sind geprüft; unvollständige Aufrufe dürfen gegebenenfalls erneut berechnet werden."
                                            />
                                        )}
                                    </>
                                )}
                                <Button
                                    variant="contained"
                                    disabled={
                                        pending ||
                                        anyRunning ||
                                        (!!job.blockCount &&
                                            (!consent || (job.unknownCalls > 0 && !acknowledgeUnknown)))
                                    }
                                    onClick={() => {
                                        void execute(async () => {
                                            setJob(
                                                await translationApi<TranslationJob>('translate', {
                                                    id: job.id,
                                                    consent,
                                                    acknowledgeUnknown,
                                                    model,
                                                    reasoning,
                                                    budgetUsd: Number(budget.replace(',', '.')),
                                                }),
                                            );
                                        });
                                    }}
                                >
                                    {job.blockCount
                                        ? 'Kapitel übersetzen / fortsetzen'
                                        : 'Lokale Vorbereitung fortsetzen'}
                                </Button>
                            </Stack>
                        </Paper>
                    )}
                    {current && (
                        <>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                                <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
                                    Zurück
                                </Button>
                                <Typography>
                                    Seite {page + 1} / {job.pages?.length}
                                </Typography>
                                <Button
                                    disabled={page + 1 >= (job.pages?.length || 0)}
                                    onClick={() => setPage(page + 1)}
                                >
                                    Weiter
                                </Button>
                            </Stack>
                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                                {(
                                    ['original', ...(job.phase === 'completed' ? ['translated'] : [])] as (
                                        | 'original'
                                        | 'translated'
                                    )[]
                                ).map((kind) => (
                                    <Box key={kind} sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography>{kind === 'original' ? 'Original' : 'Übersetzung'}</Typography>
                                        <SpinnerImage
                                            src={translationImage(job.id, kind, page, job.revision)}
                                            alt={`${kind} Seite ${page + 1}`}
                                            useFetchApi
                                            imgStyle={{ width: '100%', height: 'auto', objectFit: 'contain' }}
                                        />
                                    </Box>
                                ))}
                            </Stack>
                            {current.warnings.map((warning) => (
                                <Alert severity="warning" key={warning}>
                                    {warning}
                                </Alert>
                            ))}
                            <Accordion>
                                <AccordionSummary expandIcon={<ExpandMore />}>
                                    <Typography>Textbereiche prüfen und korrigieren ({draft.length})</Typography>
                                </AccordionSummary>
                                <AccordionDetails>
                                    <Stack spacing={2}>
                                        {draft.map((block, index) => (
                                            <Paper key={block.id} variant="outlined" sx={{ p: 2 }}>
                                                <Stack spacing={1}>
                                                    <Typography variant="caption">
                                                        {block.id} ·{' '}
                                                        {block.rendered
                                                            ? 'Ins Bild eingesetzt'
                                                            : 'Nicht ins Bild eingesetzt'}
                                                        {block.confidence === null
                                                            ? ' · manga-ocr liefert keinen verlässlichen Konfidenzwert'
                                                            : ` · OCR-Wert ${(block.confidence * 100).toFixed(0)} % (keine Garantie)`}
                                                    </Typography>
                                                    <TextField
                                                        multiline
                                                        label="Erkannter Originaltext"
                                                        value={block.text}
                                                        disabled={running || job.calls.length > 0}
                                                        onChange={(event) =>
                                                            setDraft(
                                                                draft.map((item, i) =>
                                                                    i === index
                                                                        ? { ...item, text: event.target.value }
                                                                        : item,
                                                                ),
                                                            )
                                                        }
                                                    />
                                                    {job.calls.length > 0 && (
                                                        <TextField
                                                            multiline
                                                            label="Deutsche Übersetzung"
                                                            value={block.translated}
                                                            disabled={running || !current.translationComplete}
                                                            onChange={(event) =>
                                                                setDraft(
                                                                    draft.map((item, i) =>
                                                                        i === index
                                                                            ? {
                                                                                  ...item,
                                                                                  translated: event.target.value,
                                                                              }
                                                                            : item,
                                                                    ),
                                                                )
                                                            }
                                                        />
                                                    )}
                                                    {block.note && (
                                                        <Typography color="warning.main">{block.note}</Typography>
                                                    )}
                                                </Stack>
                                            </Paper>
                                        ))}
                                        <Button
                                            disabled={
                                                pending ||
                                                running ||
                                                anyRunning ||
                                                (job.calls.length > 0 && !current.translationComplete)
                                            }
                                            onClick={() => {
                                                void execute(async () => {
                                                    await translationApi('edit', {
                                                        id: job.id,
                                                        page,
                                                        blocks: draft.map((block) => ({
                                                            id: block.id,
                                                            ...(job.calls.length
                                                                ? { translated: block.translated }
                                                                : { text: block.text }),
                                                        })),
                                                    });
                                                });
                                            }}
                                        >
                                            Korrekturen speichern – ohne neuen KI-Aufruf
                                        </Button>
                                    </Stack>
                                </AccordionDetails>
                            </Accordion>
                        </>
                    )}
                    {!!job.calls.length && (
                        <Accordion>
                            <AccordionSummary expandIcon={<ExpandMore />}>
                                <Typography>API-Aufrufe und Kosten ({job.calls.length})</Typography>
                            </AccordionSummary>
                            <AccordionDetails>
                                <Stack spacing={1}>
                                    {job.calls.map((call) => (
                                        <Typography key={call.id} variant="body2">
                                            {call.stage} · {money(call.costUsd)}
                                            {call.costUnknown ? ' (unvollständig)' : ''} · Guthaben vorher{' '}
                                            {money(call.balanceBeforeUsd)} / danach {money(call.balanceAfterUsd)} ·{' '}
                                            {call.usage?.inputTokens || 0} Eingabe- / {call.usage?.outputTokens || 0}{' '}
                                            Ausgabetokens
                                        </Typography>
                                    ))}
                                </Stack>
                            </AccordionDetails>
                        </Accordion>
                    )}
                </>
            )}
            {previewOpen && job && <OcrPreview key={job.id} job={job} onClose={() => setPreviewOpen(false)} />}
            <Typography variant="h6">Gespeicherte Aufträge</Typography>
            {jobs.slice(0, 30).map((item) => (
                <Button
                    key={item.id}
                    variant={item.id === jobId ? 'outlined' : 'text'}
                    sx={{ justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setParams({ chapter: String(item.chapterId), job: item.id })}
                >
                    {item.title} – {item.chapterName} · {phases[item.phase] || item.phase} · {money(item.costUsd)}
                </Button>
            ))}
        </Stack>
    );
}
