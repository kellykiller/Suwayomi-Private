/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLingui } from '@lingui/react/macro';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import { aiApi, type AiHistoryPage, type AiUsageData } from '@/features/ai-search/Ai.api.ts';

function csvCell(value: unknown) {
    let content = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r\n]/.test(content)) {
        content = `'${content}`;
    }
    return `"${content.replaceAll('"', '""')}"`;
}

export function AiUsage() {
    const { t, i18n } = useLingui();
    useAppTitle(t`AI usage and balance`);
    const [usage, setUsage] = useState<AiUsageData | null>(null);
    const [history, setHistory] = useState<AiHistoryPage | null>(null);
    const [offset, setOffset] = useState(0);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [message, setMessage] = useState('');
    const [pending, setPending] = useState(false);
    const [balance, setBalance] = useState('');
    const [note, setNote] = useState('');
    const [adminKey, setAdminKey] = useState('');
    const [projectId, setProjectId] = useState<string | null>(null);
    const [days, setDays] = useState(30);
    const money = (amount: number | null) =>
        amount === null
            ? t`Unknown`
            : new Intl.NumberFormat(i18n.locale, {
                  style: 'currency',
                  currency: 'USD',
                  minimumFractionDigits: 4,
                  maximumFractionDigits: 6,
              }).format(amount);
    const date = (value: string) => new Date(value).toLocaleString(i18n.locale);
    const refresh = useCallback(
        async (signal?: AbortSignal) => {
            const [summary, page] = await Promise.all([
                aiApi<AiUsageData>('usage', undefined, signal),
                aiApi<AiHistoryPage>(`history?offset=${offset}&limit=25`, undefined, signal),
            ]);
            setUsage(summary);
            setHistory(page);
            setConnectionError('');
        },
        [offset],
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
                }, 5000);
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
        setMessage('');
        try {
            await action();
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setPending(false);
        }
    };
    const phases: Record<string, string> = {
        planning: t`Understanding your request`,
        searching: t`Searching`,
        completed: t`Search completed`,
        failed: t`Search failed`,
        cancelled: t`Search cancelled`,
        partial: t`Search time limit reached`,
        interrupted: t`Interrupted by restart`,
    };
    const exportCsv = async () => {
        const rows: unknown[][] = [
            [
                t`Started`,
                t`Finished`,
                t`Prompt`,
                t`AI model`,
                t`Reasoning effort`,
                t`Maximum recommendations`,
                t`Status`,
                t`Local cache`,
                t`Input tokens`,
                t`OpenAI cached input tokens`,
                t`Output tokens`,
                t`Reasoning tokens`,
                t`Estimated search cost`,
                t`Estimated balance before search`,
                t`Estimated balance after search`,
                t`Sources`,
                t`Recommended titles`,
            ],
        ];
        let position: number | null = 0;
        while (position !== null) {
            // The next page depends on the cursor returned by this request.
            // eslint-disable-next-line no-await-in-loop
            const page: AiHistoryPage = await aiApi(`history?offset=${position}&limit=100`);
            for (const entry of page.entries) {
                rows.push([
                    entry.started,
                    entry.finished,
                    entry.prompt,
                    entry.actualModel || entry.model,
                    entry.reasoning,
                    entry.resultCount,
                    entry.phase,
                    entry.cached,
                    entry.usage?.inputTokens,
                    entry.usage?.cachedInputTokens,
                    entry.usage?.outputTokens,
                    entry.usage?.reasoningTokens,
                    entry.costUsd,
                    entry.balanceBeforeUsd,
                    entry.balanceAfterUsd,
                    entry.sources.map((source) => `${source.name} (${source.language})`).join(' | '),
                    entry.result?.recommendations.map((item) => item.title).join(' | '),
                ]);
            }
            position = page.nextOffset;
        }
        const url = URL.createObjectURL(
            new Blob(['\uFEFF', rows.map((row) => row.map(csvCell).join(';')).join('\r\n')], {
                type: 'text/csv;charset=utf-8',
            }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'suwayomi-ai-history.csv';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return (
        <Stack spacing={2} sx={{ p: 2, maxWidth: 1100, mx: 'auto' }}>
            <Stack
                direction="row"
                spacing={1}
                sx={{ flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}
            >
                <Typography variant="h5">{t`AI usage and balance`}</Typography>
                <Button component={Link} to={AppRoutes.sources.children.aiSearch.path}>{t`Open AI search`}</Button>
            </Stack>
            {error && <Alert severity="error">{error}</Alert>}
            {connectionError && <Alert severity="error">{connectionError}</Alert>}
            {message && <Alert severity="success">{message}</Alert>}
            {usage && (
                <>
                    <Paper variant="outlined" sx={{ p: 2 }}>
                        <Stack spacing={1}>
                            <Typography variant="subtitle1">{t`Estimated remaining balance`}</Typography>
                            <Typography variant="h4">{money(usage.balance.estimatedUsd)}</Typography>
                            <Typography color="text.secondary">
                                {t`Last manually entered balance`}: {money(usage.balance.anchor.amountUsd)} ·{' '}
                                {date(usage.balance.anchor.at)}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                {usage.balance.anchor.note}
                            </Typography>
                            <Typography>
                                {t`Estimated spend since that balance`}: {money(usage.balance.knownSpendUsd)}
                            </Typography>
                            <Typography color="text.secondary">{t`This is a local estimate, not a live prepaid balance from OpenAI. Other API usage, top-ups, refunds and expiring credits are not detected automatically.`}</Typography>
                            {!!(usage.balance.unknownCosts + usage.balance.pendingCosts) && (
                                <Alert severity="warning">
                                    {t`Some API requests have no final token usage. Their cost is unknown and is not subtracted from this estimate.`}{' '}
                                    ({usage.balance.unknownCosts + usage.balance.pendingCosts})
                                </Alert>
                            )}
                            <Button
                                href="https://platform.openai.com/settings/organization/billing/overview"
                                target="_blank"
                                rel="noopener noreferrer"
                                sx={{ alignSelf: 'flex-start' }}
                            >{t`Open OpenAI billing`}</Button>
                        </Stack>
                    </Paper>
                    <Paper variant="outlined" sx={{ p: 2 }}>
                        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Typography>
                                {t`Searches`}: {usage.totals.searches}
                            </Typography>
                            <Typography>
                                {t`Paid searches`}: {usage.totals.paid}
                            </Typography>
                            <Typography>
                                {t`Local cache`}: {usage.totals.cached}
                            </Typography>
                            <Typography>
                                {t`Total estimated cost`}: {money(usage.totals.estimatedCostUsd)}
                            </Typography>
                            <Typography>
                                {t`Average per search with known cost`}: {money(usage.totals.averageUsd)}
                            </Typography>
                            <Typography>
                                {t`Requests with unknown cost`}: {usage.totals.unknown}
                            </Typography>
                        </Stack>
                    </Paper>
                    <Accordion>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Typography>{t`Update manual balance`}</Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                            <Stack spacing={2}>
                                <Typography color="text.secondary">{t`Enter the current amount shown in OpenAI after other usage or a top-up. This creates a new checkpoint and preserves all previous search records.`}</Typography>
                                <TextField
                                    label={t`Current balance in USD`}
                                    value={balance}
                                    onChange={(event) => setBalance(event.target.value)}
                                    slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                                />
                                <TextField
                                    label={t`Reason for balance update`}
                                    value={note}
                                    onChange={(event) => setNote(event.target.value)}
                                    slotProps={{ htmlInput: { maxLength: 300 } }}
                                />
                                <Button
                                    disabled={pending || !balance.trim() || !note.trim()}
                                    onClick={() => {
                                        void execute(async () => {
                                            await aiApi('balance', {
                                                amountUsd: Number(balance.replace(',', '.')),
                                                note: note.trim(),
                                            });
                                            setBalance('');
                                            setNote('');
                                            setMessage(t`Balance checkpoint saved`);
                                        });
                                    }}
                                >{t`Save balance checkpoint`}</Button>
                                {usage.checkpoints.map((checkpoint) => (
                                    <Typography key={`${checkpoint.at}-${checkpoint.amountUsd}`} variant="body2">
                                        {date(checkpoint.at)} · {money(checkpoint.amountUsd)} · {checkpoint.note}
                                    </Typography>
                                ))}
                            </Stack>
                        </AccordionDetails>
                    </Accordion>
                    <Accordion>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Typography>{t`Official OpenAI costs`}</Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                            <Stack spacing={2}>
                                <Typography color="text.secondary">{t`The official Costs API returns daily billed totals, not your remaining credit or a bill for each prompt. It requires a separate OpenAI admin key with usage read permission.`}</Typography>
                                <TextField
                                    label={t`Optional OpenAI admin key`}
                                    type="password"
                                    autoComplete="new-password"
                                    value={adminKey}
                                    onChange={(event) => setAdminKey(event.target.value)}
                                    helperText={usage.billing.configured ? t`Saved` : t`Not configured`}
                                />
                                <TextField
                                    label={t`Optional OpenAI project ID`}
                                    value={projectId ?? usage.billing.projectId}
                                    onChange={(event) => setProjectId(event.target.value)}
                                    helperText={t`Leave empty to retrieve costs for the entire organization.`}
                                />
                                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                                    <Button
                                        disabled={pending || (!adminKey.trim() && projectId === null)}
                                        onClick={() => {
                                            void execute(async () => {
                                                await aiApi('billing', {
                                                    key: adminKey.trim(),
                                                    projectId: projectId ?? usage.billing.projectId,
                                                });
                                                setAdminKey('');
                                                setProjectId(null);
                                                setMessage(t`Billing connection saved`);
                                            });
                                        }}
                                    >{t`Save billing connection`}</Button>
                                    <Button
                                        disabled={pending || !usage.billing.configured}
                                        color="error"
                                        onClick={() => {
                                            void execute(async () => {
                                                await aiApi('billing', { removeKey: true });
                                                setMessage(t`Admin key removed`);
                                            });
                                        }}
                                    >{t`Remove admin key`}</Button>
                                </Stack>
                                <TextField
                                    select
                                    label={t`Cost period in days`}
                                    value={days}
                                    onChange={(event) => setDays(Number(event.target.value))}
                                >
                                    {[7, 30, 90].map((count) => (
                                        <MenuItem key={count} value={count}>
                                            {count}
                                        </MenuItem>
                                    ))}
                                </TextField>
                                <Button
                                    variant="outlined"
                                    disabled={pending || !usage.billing.configured}
                                    onClick={() => {
                                        void execute(async () => {
                                            await aiApi('costs', { days });
                                            setMessage(t`OpenAI costs retrieved`);
                                        });
                                    }}
                                >{t`Retrieve OpenAI costs`}</Button>
                                {usage.billing.last && (
                                    <>
                                        <Typography>
                                            {t`Billed total for retrieved period`}: {money(usage.billing.last.totalUsd)}{' '}
                                            · {usage.billing.last.days} {t`Days`}
                                        </Typography>
                                        <Typography variant="body2" color="text.secondary">
                                            {t`Retrieved at`}: {date(usage.billing.last.fetchedAt)} ·{' '}
                                            {usage.billing.last.projectId || t`Entire organization`}
                                        </Typography>
                                        <Typography
                                            variant="body2"
                                            color="text.secondary"
                                        >{t`Billing totals may be delayed. They are shown separately and are not subtracted again from the local balance estimate.`}</Typography>
                                        {usage.billing.last.buckets
                                            .filter((bucket) => bucket.usd !== 0)
                                            .map((bucket) => (
                                                <Typography key={bucket.start} variant="body2">
                                                    {new Date(bucket.start * 1000).toISOString().slice(0, 10)} UTC ·{' '}
                                                    {money(bucket.usd)}
                                                </Typography>
                                            ))}
                                    </>
                                )}
                            </Stack>
                        </AccordionDetails>
                    </Accordion>
                    <Accordion>
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Typography>{t`Price basis`}</Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                            <Stack spacing={1}>
                                <Typography color="text.secondary">
                                    {t`Standard USD prices per million tokens, checked on`}: {usage.priceDate}
                                </Typography>
                                {Object.entries(usage.rates).map(([model, rates]) => (
                                    <Typography key={model}>
                                        {model}: {t`Input tokens`} ${rates.input} · {t`OpenAI cached input tokens`} $
                                        {rates.cachedInput} · {t`Output tokens`} ${rates.output}
                                    </Typography>
                                ))}
                                <Typography color="text.secondary">{t`Reasoning tokens are included in output tokens and are not charged twice. Each search retains its original price basis. Local answer-cache hits cost zero.`}</Typography>
                            </Stack>
                        </AccordionDetails>
                    </Accordion>
                </>
            )}
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="h6">{t`AI search history`}</Typography>
                <Button
                    disabled={pending || !history?.total}
                    onClick={() => {
                        void execute(exportCsv);
                    }}
                >{t`Export CSV`}</Button>
            </Stack>
            <Typography color="text.secondary">{t`Prompts and results are stored privately on the NAS from this version onward. Searches made before tracking was installed cannot be reconstructed.`}</Typography>
            {history?.entries.map((entry) => (
                <Accordion key={entry.id}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Stack spacing={1} sx={{ width: '100%' }}>
                            <Typography>
                                {date(entry.started)} · {entry.model} · {phases[entry.phase] || entry.phase}
                            </Typography>
                            <Typography sx={{ overflowWrap: 'anywhere' }}>
                                {entry.prompt.length > 160 ? `${entry.prompt.slice(0, 160)}…` : entry.prompt}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                {t`Estimated search cost`}: {money(entry.costUsd)} · {t`Before`}:{' '}
                                {money(entry.balanceBeforeUsd)} → {t`After`}: {money(entry.balanceAfterUsd)}
                                {entry.cached ? ` · ${t`Local cache`}` : ''}
                            </Typography>
                        </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                        <Stack spacing={1}>
                            <Typography variant="subtitle1">{t`Prompt`}</Typography>
                            <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                {entry.prompt}
                            </Typography>
                            <Typography color="text.secondary">
                                {t`Reasoning effort`}: {entry.reasoning} · {t`Maximum recommendations`}:{' '}
                                {entry.resultCount} · {t`Sources`}:{' '}
                                {entry.sources.map((source) => `${source.name} (${source.language})`).join(', ')}
                            </Typography>
                            {entry.finished && (
                                <Typography variant="body2">
                                    {t`Finished`}: {date(entry.finished)}
                                </Typography>
                            )}
                            {entry.usage && (
                                <Typography variant="body2">
                                    {t`Input tokens`}: {entry.usage.inputTokens} · {t`OpenAI cached input tokens`}:{' '}
                                    {entry.usage.cachedInputTokens ?? 0} · {t`Output tokens`}:{' '}
                                    {entry.usage.outputTokens} · {t`Reasoning tokens`}:{' '}
                                    {entry.usage.reasoningTokens ?? 0}
                                </Typography>
                            )}
                            {(entry.costUnknown || entry.balanceUncertain) && (
                                <Alert severity="warning">{t`This balance comparison is incomplete because at least one API request has unknown cost.`}</Alert>
                            )}
                            {entry.error && <Alert severity="warning">{entry.error}</Alert>}
                            {entry.result?.summary && <Typography>{entry.result.summary}</Typography>}
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                                {entry.result?.recommendations.map((item) => (
                                    <Chip
                                        key={item.title}
                                        label={`${item.title} · ${item.matches.length} ${t`Source matches`}`}
                                    />
                                ))}
                            </Stack>
                            {entry.responseId && (
                                <Typography variant="caption" color="text.secondary">
                                    {t`OpenAI response ID`}: {entry.responseId}
                                </Typography>
                            )}
                        </Stack>
                    </AccordionDetails>
                </Accordion>
            ))}
            {history?.total === 0 && <Typography>{t`No AI searches have been recorded yet.`}</Typography>}
            {history && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Button
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 25))}
                    >{t`Previous page`}</Button>
                    <Typography>
                        {Math.min(offset + 1, history.total)}–{Math.min(offset + history.entries.length, history.total)}{' '}
                        / {history.total}
                    </Typography>
                    <Button
                        disabled={history.nextOffset === null}
                        onClick={() => setOffset(history.nextOffset!)}
                    >{t`Next page`}</Button>
                </Stack>
            )}
        </Stack>
    );
}
