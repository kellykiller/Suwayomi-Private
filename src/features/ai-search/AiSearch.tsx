/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLingui } from '@lingui/react/macro';
import Alert from '@mui/material/Alert';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import { SpinnerImage } from '@/base/components/SpinnerImage.tsx';
import { Mangas } from '@/features/manga/services/Mangas.ts';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import { requestManager } from '@/lib/requests/RequestManager.ts';
import { Sources } from '@/features/source/services/Sources.ts';
import { useMetadataServerSettings } from '@/features/settings/services/ServerSettingsMetadata.ts';
import { SourceLanguageSelect } from '@/features/source/components/SourceLanguageSelect.tsx';
import { useAppTitleAndAction } from '@/features/navigation-bar/hooks/useAppTitleAndAction.ts';
import { aiApi, AiApiError, type AiSearchJob, type AiSettingsData } from '@/features/ai-search/Ai.api.ts';

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
        /* Storage may be unavailable in private browser sessions. */
    }
}

export function AiSearch() {
    const { t, i18n } = useLingui();
    useAppTitleAndAction(t`AI search`, null);
    const [settings, setSettings] = useState<AiSettingsData | null>(null);
    const [prompt, setPrompt] = useState('');
    const [job, setJob] = useState<AiSearchJob | null>(null);
    const [jobId, setJobId] = useState<string | null>(storedJob);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [pending, setPending] = useState(false);
    const [allLanguages, setAllLanguages] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
    const [onlyFound, setOnlyFound] = useState(false);
    const resumeActive = async (signal?: AbortSignal) => {
        const result = await aiApi<{ job: AiSearchJob | null }>('active', undefined, signal);
        if (result.job) {
            setJob(result.job);
            setJobId(result.job.id);
            rememberJob(result.job.id);
        }
    };
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
    useEffect(() => {
        const controller = new AbortController();
        void aiApi<AiSettingsData>('settings', undefined, controller.signal)
            .then(setSettings)
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setError(reason.message);
                }
            });
        void resumeActive(controller.signal).catch(() => {
            /* Polling an existing job handles connection failures. */
        });
        return () => controller.abort();
    }, []);
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
                if (!result.finished) {
                    timer = setTimeout(() => {
                        void poll();
                    }, 1500);
                }
            } catch (reason) {
                if (controller.signal.aborted) {
                    return;
                }
                setConnectionError(reason instanceof Error ? reason.message : String(reason));
                if (reason instanceof AiApiError && reason.status === 404) {
                    setJobId(null);
                    setJob(null);
                    rememberJob(null);
                    return;
                }
                // Never restart a paid search automatically after a lost connection.
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
    const chapterLabel = (match: AiSearchJob['recommendations'][number]['matches'][number]) => {
        if (match.chapterCount !== null) {
            return `${match.chapterCount} ${t`Chapters`}`;
        }
        if (match.detailsPhase === 'loading') {
            return t`Loading chapters`;
        }
        return t`Chapter count unknown`;
    };
    const busy = pending || (!!job && !job.finished);
    const phases = {
        planning: t`Understanding your request`,
        searching: t`Searching installed sources`,
        completed: t`Search completed`,
        partial: t`Search time limit reached`,
        cancelled: t`Search cancelled`,
        failed: t`Search failed`,
    };
    const sourcePhases = {
        pending: t`Waiting`,
        searching: t`Searching`,
        completed: t`Checked`,
        failed: t`Failed`,
        interrupted: t`Not fully checked`,
    };
    const recommendations = job?.recommendations.filter((item) => !onlyFound || item.matches.length) ?? [];
    return (
        <Stack spacing={2} sx={{ p: 2, maxWidth: 1100, mx: 'auto' }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="h5">{t`AI search`}</Typography>
                <Button component={Link} to={AppRoutes.settings.children.ai.path}>{t`AI settings`}</Button>
                <Button
                    component={Link}
                    to={AppRoutes.settings.children.aiUsage.path}
                >{t`AI usage and balance`}</Button>
            </Stack>
            <Typography color="text.secondary">{t`Describe what you want to read. AI suggests titles and Suwayomi looks for them across your selected installed sources.`}</Typography>
            {error && (
                <Alert severity="error" onClose={() => setError('')}>
                    {error}
                </Alert>
            )}
            {sourceError && <Alert severity="error">{sourceError.message}</Alert>}
            {connectionError && <Alert severity="error">{connectionError}</Alert>}
            {settings && (!settings.configured || !settings.enabled) && (
                <Alert severity="info">{t`Configure and enable AI search in the settings first.`}</Alert>
            )}
            <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={2}>
                    <TextField
                        label={t`What would you like to read?`}
                        multiline
                        minRows={3}
                        value={prompt}
                        disabled={busy}
                        onChange={(event) => setPrompt(event.target.value)}
                        slotProps={{ htmlInput: { maxLength: 2000 } }}
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
                                !settings?.enabled ||
                                !settings.configured ||
                                !selectedSources.length ||
                                selectedSources.length > 100
                            }
                            onClick={() => {
                                setPending(true);
                                setError('');
                                void aiApi<AiSearchJob>('search', {
                                    prompt: prompt.trim(),
                                    language: i18n.locale,
                                    sourceIds: selectedSources.map((source) => source.id),
                                })
                                    .then((result) => {
                                        setJob(result);
                                        setJobId(result.id);
                                        rememberJob(result.id);
                                    })
                                    .catch(async (reason: Error) => {
                                        setError(reason.message);
                                        await resumeActive().catch(() => {
                                            /* The next visit can resume the active job. */
                                        });
                                    })
                                    .finally(() => setPending(false));
                            }}
                        >{t`Find recommendations`}</Button>
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
                            >{t`Cancel search`}</Button>
                        )}
                        {jobId && (
                            <Button
                                disabled={busy}
                                onClick={() => {
                                    setJobId(null);
                                    setJob(null);
                                    rememberJob(null);
                                    setError('');
                                }}
                            >{t`Clear results`}</Button>
                        )}
                    </Stack>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >{t`One AI request per new search. Identical requests reuse the AI answer for 24 hours; source availability is checked again.`}</Typography>
                </Stack>
            </Paper>
            {job && (
                <>
                    <Paper variant="outlined" sx={{ p: 2 }}>
                        <Stack spacing={1}>
                            <Typography variant="h6">{phases[job.phase]}</Typography>
                            {!job.finished && <LinearProgress />}
                            <Typography color="text.secondary">
                                {t`Sources checked`}: {job.completedSources}/{job.sources.length} · {t`Source queries`}:{' '}
                                {job.checkedQueries}
                            </Typography>
                            {job.summary && <Typography>{job.summary}</Typography>}
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                                {job.criteria.map((criterion) => (
                                    <Chip key={criterion} label={criterion} />
                                ))}
                            </Stack>
                            {job.notice && <Alert severity="info">{job.notice}</Alert>}
                            {job.error && <Alert severity="error">{job.error}</Alert>}
                            {job.cached && (
                                <Typography
                                    variant="body2"
                                    color="text.secondary"
                                >{t`AI answer reused from cache`}</Typography>
                            )}
                            {job.usage && !job.cached && (
                                <Typography variant="body2" color="text.secondary">
                                    {job.model} · {t`Input tokens`}: {job.usage.inputTokens} · {t`Output tokens`}:{' '}
                                    {job.usage.outputTokens}
                                </Typography>
                            )}
                            {job.accounting && (
                                <Typography variant="body2" color="text.secondary">
                                    {t`Estimated search cost`}:{' '}
                                    {job.accounting.costUsd === null
                                        ? t`Unknown`
                                        : new Intl.NumberFormat(i18n.locale, {
                                              style: 'currency',
                                              currency: 'USD',
                                              minimumFractionDigits: 4,
                                              maximumFractionDigits: 6,
                                          }).format(job.accounting.costUsd)}
                                    {' · '}
                                    {t`Estimated balance after search`}:{' '}
                                    {job.accounting.balanceAfterUsd === null
                                        ? t`Unknown`
                                        : new Intl.NumberFormat(i18n.locale, {
                                              style: 'currency',
                                              currency: 'USD',
                                              minimumFractionDigits: 4,
                                              maximumFractionDigits: 6,
                                          }).format(job.accounting.balanceAfterUsd)}
                                </Typography>
                            )}
                        </Stack>
                    </Paper>
                    {!!job.recommendations.length && (
                        <>
                            <Alert severity="info">{t`Recommendation reasons are AI assessments. A source match confirms a title listing, not chapter completeness or the claimed story development. Missing matches may be caused by title variants, source errors or search limits.`}</Alert>
                            <FormControlLabel
                                control={<Switch checked={onlyFound} onChange={(_, value) => setOnlyFound(value)} />}
                                label={t`Only show titles found in sources`}
                            />
                        </>
                    )}
                    {recommendations.map((item, index) => (
                        <Paper key={item.title} variant="outlined" sx={{ p: 2 }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                <Box
                                    sx={{
                                        width: { xs: 100, sm: 130 },
                                        aspectRatio: '2 / 3',
                                        flexShrink: 0,
                                        borderRadius: 1,
                                        overflow: 'hidden',
                                        position: 'relative',
                                        bgcolor: 'action.hover',
                                    }}
                                >
                                    <SpinnerImage
                                        alt={item.title}
                                        src={
                                            item.matches.find((match) => !!match.thumbnailUrl)
                                                ? Mangas.getThumbnailUrl(
                                                      item.matches.find((match) => !!match.thumbnailUrl)!,
                                                  )
                                                : ''
                                        }
                                        imgStyle={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                        spinnerStyle={{
                                            width: '100%',
                                            height: '100%',
                                            display: 'grid',
                                            placeItems: 'center',
                                        }}
                                    />
                                </Box>
                                <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
                                    <Typography variant="h6">
                                        {index + 1}. {item.title}
                                    </Typography>
                                    {!!item.aliases.length && (
                                        <Typography variant="body2" color="text.secondary">
                                            {item.aliases.join(' · ')}
                                        </Typography>
                                    )}
                                    <Typography>{item.reason}</Typography>
                                    {item.caveat && (
                                        <Typography color="text.secondary">
                                            {t`Considerations`}: {item.caveat}
                                        </Typography>
                                    )}
                                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                                        {item.matches.map((match) => (
                                            <Button
                                                key={match.id}
                                                component={Link}
                                                to={AppRoutes.manga.path(match.id)}
                                                variant="outlined"
                                            >
                                                {match.sourceName} · {match.language}
                                                {' · '}
                                                {chapterLabel(match)}
                                                {match.chapterEntryCount !== null &&
                                                match.chapterEntryCount !== match.chapterCount
                                                    ? ` (${match.chapterEntryCount} ${t`Entries`})`
                                                    : ''}
                                                {match.inLibrary ? ` · ${t`In library`}` : ''}
                                            </Button>
                                        ))}
                                    </Stack>
                                    {!item.matches.length && (
                                        <Typography color="text.secondary">
                                            {job.finished
                                                ? t`No matching listing found in the checked sources`
                                                : t`No matching listing found yet`}
                                        </Typography>
                                    )}
                                    <Button
                                        component={Link}
                                        to={AppRoutes.sources.children.searchAll.path(item.title)}
                                        sx={{ alignSelf: 'flex-start' }}
                                    >{t`Search this title manually`}</Button>
                                </Stack>
                            </Stack>
                        </Paper>
                    ))}
                    {job.finished && !recommendations.length && (
                        <Typography>{t`No recommendations to display. Try adjusting your request or sources.`}</Typography>
                    )}
                    <Accordion>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Typography>{t`Source check details`}</Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                            <Stack spacing={1}>
                                <Typography
                                    color="text.secondary"
                                    variant="body2"
                                >{t`Sources are checked three at a time, using titles and alternative names on the first two result pages. The search stops after four minutes and keeps partial results.`}</Typography>
                                {job.sources.map((source) => (
                                    <Typography key={source.id} variant="body2">
                                        {source.name} ({source.language}) · {sourcePhases[source.phase]}
                                        {source.truncated ? ` · ${t`More result pages remain unchecked`}` : ''}
                                    </Typography>
                                ))}
                            </Stack>
                        </AccordionDetails>
                    </Accordion>
                </>
            )}
        </Stack>
    );
}
