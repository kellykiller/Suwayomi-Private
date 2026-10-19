/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLingui } from '@lingui/react/macro';
import Alert from '@mui/material/Alert';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import { SpinnerImage } from '@/base/components/SpinnerImage.tsx';
import { Mangas } from '@/features/manga/services/Mangas.ts';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import type { AiSearchJob } from '@/features/ai-search/Ai.api.ts';

export function AiSearchResults({ job, onMoreLike }: { job: AiSearchJob; onMoreLike: (title: string) => void }) {
    const { t, i18n } = useLingui();
    const [onlyFound, setOnlyFound] = useState(false);
    const chapterLabel = (match: AiSearchJob['recommendations'][number]['matches'][number]) => {
        if (match.chapterCount !== null) {
            return `${match.chapterCount} ${t`Chapters`}`;
        }
        if (match.detailsPhase === 'loading') {
            return t`Loading chapters`;
        }
        return t`Chapter count unknown`;
    };
    const phases = {
        planning: t`Understanding your request`,
        searching: t`Searching installed sources`,
        completed: t`Search completed`,
        partial: t`Search time limit reached`,
        cancelled: t`Search cancelled`,
        failed: t`Search failed`,
        interrupted: 'Unterbrochen',
    };
    const sourcePhases = {
        pending: t`Waiting`,
        searching: t`Searching`,
        completed: t`Checked`,
        failed: t`Failed`,
        interrupted: t`Not fully checked`,
    };

    const recommendations = job.recommendations.filter((item) => !onlyFound || item.matches.length);
    return (
        <Stack spacing={2}>
            <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={1}>
                    <Typography variant="h6">
                        {job.phase === 'completed' && !job.recommendations.length ? 'Antwort' : phases[job.phase]}
                    </Typography>
                    {!job.finished && <LinearProgress />}
                    <Typography color="text.secondary">
                        {t`Sources checked`}: {job.completedSources}/{job.sources.length} · {t`Source queries`}:{' '}
                        {job.checkedQueries}
                    </Typography>
                    {job.summary && (
                        <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{job.summary}</Typography>
                    )}
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        {job.criteria.map((criterion) => (
                            <Chip key={criterion} label={criterion} />
                        ))}
                    </Stack>
                    {job.notice && <Alert severity="info">{job.notice}</Alert>}
                    {job.error && <Alert severity="error">{job.error}</Alert>}
                    {job.cached && (
                        <Typography variant="body2" color="text.secondary">{t`AI answer reused from cache`}</Typography>
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
            {recommendations.map((item) => (
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
                                        ? Mangas.getThumbnailUrl(item.matches.find((match) => !!match.thumbnailUrl)!)
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
                                {job.recommendations.indexOf(item) + 1}. {item.title}
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
                            <Button onClick={() => onMoreLike(item.title)} sx={{ alignSelf: 'flex-start' }}>
                                Mehr wie dieser Titel
                            </Button>
                            <Button
                                component={Link}
                                to={AppRoutes.sources.children.searchAll.path(item.title)}
                                sx={{ alignSelf: 'flex-start' }}
                            >{t`Search this title manually`}</Button>
                        </Stack>
                    </Stack>
                </Paper>
            ))}
            {job.finished && job.recommendations.length > 0 && !recommendations.length && (
                <Typography>{t`No recommendations to display. Try adjusting your request or sources.`}</Typography>
            )}
            {job.recommendations.length > 0 && (
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
            )}
        </Stack>
    );
}
