/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLingui } from '@lingui/react/macro';
import Alert from '@mui/material/Alert';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import { requestManager } from '@/lib/requests/RequestManager.ts';
import { Sources } from '@/features/source/services/Sources.ts';
import { useMetadataServerSettings } from '@/features/settings/services/ServerSettingsMetadata.ts';
import { SourceLanguageSelect } from '@/features/source/components/SourceLanguageSelect.tsx';
import { useAppTitleAndAction } from '@/features/navigation-bar/hooks/useAppTitleAndAction.ts';
import {
    aiApi,
    aiRequestId,
    AiApiError,
    type AiSearchJob,
    type AiSettingsData,
    type AiConversation,
    type AiConversationSummary,
} from '@/features/ai-search/Ai.api.ts';
import { AiSearchResults } from '@/features/ai-search/AiSearchResults.tsx';

const JOB_KEY = 'suwayomi-private-ai-job';
function storedJob() {
    try {
        return sessionStorage.getItem(JOB_KEY);
    } catch {
        return null;
    }
}
function rememberJob(id: string | null) {
    try {
        if (id) {
            sessionStorage.setItem(JOB_KEY, id);
        } else {
            sessionStorage.removeItem(JOB_KEY);
        }
    } catch {
        /* Private browser storage can be unavailable. */
    }
}

export function AiSearch() {
    const { t, i18n } = useLingui();
    useAppTitleAndAction('KI-Suche', null);
    const [routeParams] = useSearchParams();
    const query = routeParams.toString();
    const [settings, setSettings] = useState<AiSettingsData | null>(null);
    const [prompt, setPrompt] = useState('');
    const [count, setCount] = useState('');
    const [conversation, setConversation] = useState<AiConversation | null>(null);
    const [conversations, setConversations] = useState<AiConversationSummary[]>([]);
    const [job, setJob] = useState<AiSearchJob | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [pending, setPending] = useState(false);
    const [allLanguages, setAllLanguages] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
    const attempt = useRef<{ hash: string; id: string } | null>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const { data, loading, error: sourceError } = requestManager.useGetSourceList();
    const {
        settings: { showNsfw },
    } = useMetadataServerSettings();
    const { languages, setLanguages } = Sources.useLanguages();
    const allSources = useMemo(() => data?.sources.nodes ?? [], [data]);
    const filteredSources = useMemo(
        () =>
            Sources.filter(allSources, {
                enabled: true,
                isNsfw: showNsfw ? undefined : false,
                languages: allLanguages ? undefined : languages,
                keepLocalSource: true,
            }),
        [allSources, showNsfw, allLanguages, languages],
    );
    const selectedSources = useMemo(
        () => (selectedIds ? filteredSources.filter((source) => selectedIds.includes(source.id)) : filteredSources),
        [filteredSources, selectedIds],
    );
    const busy = pending || (!!job && !job.finished);
    const maximum = settings?.maxResultCount ?? 100;
    const validCount = /^\d+$/.test(count) && Number(count) >= 1 && Number(count) <= maximum;
    const refreshList = async (signal?: AbortSignal) => {
        const result = await aiApi<{ conversations: AiConversationSummary[] }>('conversations', undefined, signal);
        setConversations(result.conversations);
    };
    const showConversation = (value: AiConversation) => {
        setConversation(value);
        const last = value.turns.at(-1) ?? null;
        setJob(last);
        setJobId(last?.id ?? null);
        rememberJob(last?.id ?? null);
        if (last) {
            setCount(String(last.resultCount ?? 6));
            setAllLanguages(true);
            setSelectedIds(last.sources.map((source) => source.id));
        }
        setConnectionError('');
    };
    const openConversation = async (id: string, signal?: AbortSignal) => {
        showConversation(await aiApi<AiConversation>(`conversations/${encodeURIComponent(id)}`, undefined, signal));
    };
    const acceptJob = async (value: AiSearchJob, signal?: AbortSignal) => {
        setJob(value);
        setJobId(value.id);
        rememberJob(value.id);
        if (value.conversationId) {
            await openConversation(value.conversationId, signal);
        }
    };
    useEffect(() => {
        const controller = new AbortController();
        void aiApi<AiSettingsData>('settings', undefined, controller.signal)
            .then((value) => {
                setSettings(value);
                setCount((current) => current || String(value.resultCount));
            })
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setError(reason.message);
                }
            });
        return () => controller.abort();
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        setPending(true);
        const restore = async () => {
            await refreshList(controller.signal);
            const route = new URLSearchParams(query);
            if (route.get('conversation')) {
                await openConversation(route.get('conversation')!, controller.signal);
            } else if (route.get('historyJob')) {
                showConversation(
                    await aiApi<AiConversation>(
                        'conversations/import',
                        { jobId: route.get('historyJob') },
                        controller.signal,
                    ),
                );
            } else {
                const active = await aiApi<{ job: AiSearchJob | null }>('active', undefined, controller.signal);
                if (active.job) {
                    await acceptJob(active.job, controller.signal);
                } else if (storedJob()) {
                    try {
                        await acceptJob(
                            await aiApi<AiSearchJob>(
                                `jobs/${encodeURIComponent(storedJob()!)}`,
                                undefined,
                                controller.signal,
                            ),
                            controller.signal,
                        );
                    } catch (reason) {
                        if (reason instanceof AiApiError && reason.status === 404) {
                            rememberJob(null);
                        } else {
                            throw reason;
                        }
                    }
                }
            }
        };
        void restore()
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setError(reason.message);
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) {
                    setPending(false);
                }
            });
        return () => controller.abort();
    }, [query]);
    useEffect(() => {
        if (!jobId) {
            return undefined;
        }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const result = await aiApi<AiSearchJob>(
                    `jobs/${encodeURIComponent(jobId)}`,
                    undefined,
                    controller.signal,
                );
                setJob(result);
                setConnectionError('');
                setConversation((current) =>
                    current && current.id === result.conversationId
                        ? { ...current, turns: [...current.turns.filter((turn) => turn.id !== result.id), result] }
                        : current,
                );
                if (!result.finished) {
                    timer = setTimeout(() => {
                        void poll();
                    }, 1500);
                } else {
                    await refreshList(controller.signal);
                }
            } catch (reason) {
                if (controller.signal.aborted) {
                    return;
                }
                setConnectionError(reason instanceof Error ? reason.message : String(reason));
                if (reason instanceof AiApiError && reason.status === 404) {
                    setJobId(null);
                    rememberJob(null);
                    return;
                }
                timer = setTimeout(() => {
                    void poll();
                }, 5000);
            }
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [jobId]);
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [job?.id, job?.finished]);
    const send = async () => {
        if (
            busy ||
            !validCount ||
            !prompt.trim() ||
            !settings?.enabled ||
            !settings.configured ||
            !selectedSources.length ||
            selectedSources.length > 100
        ) {
            return;
        }
        setPending(true);
        setError('');
        const payload = {
            prompt: prompt.trim(),
            language: i18n.locale,
            sourceIds: selectedSources.map((source) => source.id),
            resultCount: Number(count),
            ...(conversation ? { conversationId: conversation.id, parentJobId: job?.id } : {}),
        };
        const hash = JSON.stringify(payload);
        if (attempt.current?.hash !== hash) {
            attempt.current = { hash, id: aiRequestId() };
        }
        const requestId = attempt.current!.id;
        rememberJob(requestId);
        try {
            const result = await aiApi<AiSearchJob>('search', { ...payload, requestId });
            await acceptJob(result);
            setPrompt('');
            attempt.current = null;
            await refreshList();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            // Read the exact accepted request after an ambiguous response. Never retry a paid POST automatically.
            try {
                await acceptJob(await aiApi<AiSearchJob>(`jobs/${requestId}`));
                setPrompt('');
                attempt.current = null;
                setError('');
            } catch {
                /* Keep draft and request ID for an explicit retry with identical content. */
                await refreshList().catch(() => {});
            }
        } finally {
            setPending(false);
        }
    };
    const moreLike = (title: string) => {
        setPrompt(`Mehr wie „${title}“, das du mir vorgeschlagen hast. Was kannst du mir noch empfehlen?`);
        inputRef.current?.focus();
        bottomRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const selectedChat =
        conversations.find((value) => value.id === conversation?.id) ??
        (conversation
            ? {
                  id: conversation.id,
                  title: conversation.title,
                  updated: conversation.updated,
                  turnCount: conversation.turns.length,
              }
            : null);
    const turns = conversation?.turns ?? (job ? [job] : []);
    return (
        <Stack spacing={2} sx={{ p: 2, maxWidth: 1100, mx: 'auto' }}>
            <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}
            >
                <Typography variant="h5">KI-Suche</Typography>
                <Button component={Link} to={AppRoutes.settings.children.ai.path}>
                    KI-Einstellungen
                </Button>
                <Button component={Link} to={AppRoutes.settings.children.aiUsage.path}>
                    Nutzung und Suchhistorie
                </Button>
            </Stack>
            <Typography color="text.secondary">
                Beschreibe, was du lesen möchtest. Du kannst danach nachfragen, Wünsche ergänzen oder mehr wie einen
                vorgeschlagenen Titel suchen.
            </Typography>
            {error && (
                <Alert severity="error" onClose={() => setError('')}>
                    {error}
                </Alert>
            )}
            {sourceError && <Alert severity="error">{sourceError.message}</Alert>}
            {connectionError && <Alert severity="error">{connectionError}</Alert>}
            {settings && (!settings.configured || !settings.enabled) && (
                <Alert severity="info">
                    Bitte die KI-Suche zuerst in den Einstellungen aktivieren und einen API-Schlüssel hinterlegen.
                </Alert>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Autocomplete
                    sx={{ flex: 1 }}
                    options={conversations}
                    value={selectedChat}
                    disabled={busy}
                    isOptionEqualToValue={(a, b) => a.id === b.id}
                    getOptionLabel={(value) => value.title}
                    onChange={(_, value) => {
                        if (!value) {
                            return;
                        }
                        setPending(true);
                        setPrompt('');
                        attempt.current = null;
                        void openConversation(value.id)
                            .catch((reason: Error) => setError(reason.message))
                            .finally(() => setPending(false));
                    }}
                    renderInput={(props) => <TextField {...props} label="Gespeichertes Gespräch öffnen" />}
                />
                <Button
                    disabled={busy}
                    variant="outlined"
                    onClick={() => {
                        setConversation(null);
                        setJob(null);
                        setJobId(null);
                        setPrompt('');
                        setCount(String(settings?.resultCount ?? 6));
                        setError('');
                        setConnectionError('');
                        attempt.current = null;
                        rememberJob(null);
                    }}
                >
                    Neues Gespräch
                </Button>
            </Stack>
            <Stack spacing={2} aria-label="Gesprächsverlauf">
                {turns.map((turn, index) => (
                    <Stack key={turn.id} spacing={1}>
                        <Paper
                            variant="outlined"
                            sx={{ p: 2, alignSelf: 'flex-end', maxWidth: '95%', bgcolor: 'action.selected' }}
                        >
                            <Typography variant="caption" color="text.secondary">
                                Du
                            </Typography>
                            <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                {turn.prompt || 'Frühere Suche'}
                            </Typography>
                        </Paper>
                        <Typography variant="caption" color="text.secondary">
                            KI · maximal {turn.resultCount ?? settings?.resultCount} Vorschläge
                        </Typography>
                        {index === turns.length - 1 ? (
                            <AiSearchResults job={turn} onMoreLike={moreLike} />
                        ) : (
                            <Stack spacing={1}>
                                <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                    {turn.summary || turn.error || 'Keine vollständige Antwort.'}
                                </Typography>
                                <Accordion>
                                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                        <Typography>
                                            {turn.recommendations.length} frühere Vorschläge und Suchdetails anzeigen
                                        </Typography>
                                    </AccordionSummary>
                                    <AccordionDetails>
                                        <AiSearchResults job={turn} onMoreLike={moreLike} />
                                    </AccordionDetails>
                                </Accordion>
                            </Stack>
                        )}
                    </Stack>
                ))}
            </Stack>
            <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={2}>
                    <TextField
                        label={conversation ? 'Nachricht an die KI' : 'Was möchtest du lesen?'}
                        placeholder={
                            conversation
                                ? 'Zum Beispiel: Mehr wie dein zweiter Vorschlag, aber ohne Harem.'
                                : 'Welche Geschichten, Genres und Entwicklungen suchst du?'
                        }
                        multiline
                        minRows={3}
                        value={prompt}
                        inputRef={inputRef}
                        disabled={busy}
                        onChange={(event) => setPrompt(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        slotProps={{ htmlInput: { maxLength: 2000, enterKeyHint: 'send' } }}
                    />
                    <TextField
                        label="Maximale Vorschläge pro Antwort"
                        type="number"
                        value={count}
                        onChange={(event) => setCount(event.target.value)}
                        disabled={busy}
                        error={!!count && !validCount}
                        helperText={`Ganze Zahl von 1 bis ${
                            maximum
                        }. Die KI darf weniger nennen, wenn passende Titel fehlen.`}
                        slotProps={{ htmlInput: { min: 1, max: maximum, step: 1, inputMode: 'numeric' } }}
                    />
                    <Accordion disableGutters>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Typography>
                                {t`Sources and languages`}: {selectedSources.length}
                            </Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                            <Stack spacing={2}>
                                <FormControlLabel
                                    control={
                                        <Switch
                                            checked={allLanguages}
                                            disabled={busy}
                                            onChange={(_, value) => {
                                                setAllLanguages(value);
                                                setSelectedIds(null);
                                            }}
                                        />
                                    }
                                    label={t`All source languages`}
                                />
                                {!allLanguages && (
                                    <SourceLanguageSelect
                                        selectedLanguages={languages}
                                        setSelectedLanguages={setLanguages}
                                        languages={Sources.getLanguages(allSources, { excludeLocalSource: true })}
                                        sources={allSources}
                                    />
                                )}
                                <Autocomplete
                                    multiple
                                    options={filteredSources}
                                    value={selectedSources}
                                    disabled={busy || loading}
                                    isOptionEqualToValue={(a, b) => a.id === b.id}
                                    getOptionLabel={(source) => `${source.displayName} (${source.lang})`}
                                    onChange={(_, value) => setSelectedIds(value.map((source) => source.id))}
                                    renderInput={(params) => <TextField {...params} label={t`Selected sources`} />}
                                    limitTags={3}
                                />
                                <Button
                                    disabled={busy}
                                    onClick={() => setSelectedIds(null)}
                                >{t`Select all enabled sources`}</Button>
                                <Typography
                                    variant="body2"
                                    color="text.secondary"
                                >{t`Disabled sources and your adult-content preference are respected. Pinning does not limit AI search. Up to 100 sources can be checked per search.`}</Typography>
                            </Stack>
                        </AccordionDetails>
                    </Accordion>

                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <Button
                            variant="contained"
                            disabled={
                                busy ||
                                loading ||
                                !prompt.trim() ||
                                !validCount ||
                                !settings?.enabled ||
                                !settings.configured ||
                                !selectedSources.length ||
                                selectedSources.length > 100
                            }
                            onClick={() => {
                                void send();
                            }}
                        >
                            Nachricht senden
                        </Button>
                        {job && !job.finished && (
                            <Button
                                disabled={pending}
                                onClick={() => {
                                    setPending(true);
                                    void aiApi<AiSearchJob>('cancel', { id: job.id })
                                        .then(setJob)
                                        .catch((reason: Error) => setError(reason.message))
                                        .finally(() => setPending(false));
                                }}
                            >
                                Aktuelle Antwort abbrechen
                            </Button>
                        )}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                        Enter sendet, Umschalt+Enter fügt einen Zeilenumbruch ein. Neue Antworten können API-Kosten
                        verursachen; bisherige Nachrichten werden als Kontext mitgesendet. Das Öffnen des gespeicherten
                        Verlaufs startet keine KI-Anfrage.
                    </Typography>
                </Stack>
            </Paper>
            <div ref={bottomRef} />
        </Stack>
    );
}
