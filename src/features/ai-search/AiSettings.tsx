/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLingui } from '@lingui/react/macro';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import { aiApi, type AiSettingsData } from '@/features/ai-search/Ai.api.ts';

export function AiSettings() {
    const { t } = useLingui();
    useAppTitle(t`AI settings`);
    const [settings, setSettings] = useState<AiSettingsData | null>(null);
    const [key, setKey] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [pending, setPending] = useState(false);
    const [resultCount, setResultCount] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        void aiApi<AiSettingsData>('settings', undefined, controller.signal)
            .then((value) => {
                setSettings(value);
                setResultCount(String(value.resultCount));
            })
            .catch((reason: Error) => {
                if (!controller.signal.aborted) {
                    setError(reason.message);
                }
            });
        return () => controller.abort();
    }, []);
    const execute = async (action: () => Promise<void>) => {
        setPending(true);
        setError('');
        setMessage('');
        try {
            await action();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setPending(false);
        }
    };
    return (
        <Stack spacing={2} sx={{ p: 2, maxWidth: 800, mx: 'auto' }}>
            <Typography variant="h5">{t`AI settings`}</Typography>
            <Typography color="text.secondary">{t`Your search request is sent to OpenAI when you start an AI search. The API is billed separately from ChatGPT. Manga pages and your library are not sent.`}</Typography>
            {error && <Alert severity="error">{error}</Alert>}
            {message && <Alert severity="success">{message}</Alert>}
            {settings && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={2}>
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={settings.enabled}
                                    disabled={pending}
                                    onChange={(_, enabled) => setSettings({ ...settings, enabled })}
                                />
                            }
                            label={t`Enable AI search`}
                        />
                        <TextField
                            label={t`OpenAI API key`}
                            type="password"
                            autoComplete="new-password"
                            value={key}
                            disabled={pending}
                            onChange={(event) => setKey(event.target.value)}
                            helperText={
                                settings.configured
                                    ? t`A key is saved on the NAS. Leave this field empty to keep it.`
                                    : t`No OpenAI key is configured yet.`
                            }
                        />
                        <TextField
                            select
                            label={t`AI model`}
                            value={settings.model}
                            disabled={pending}
                            onChange={(event) => setSettings({ ...settings, model: event.target.value })}
                        >
                            {settings.models.map((model) => (
                                <MenuItem key={model} value={model}>
                                    {model}
                                </MenuItem>
                            ))}
                        </TextField>
                        <TextField
                            select
                            label={t`Reasoning effort`}
                            value={settings.reasoning}
                            disabled={pending}
                            onChange={(event) =>
                                setSettings({
                                    ...settings,
                                    reasoning: event.target.value as AiSettingsData['reasoning'],
                                })
                            }
                            helperText={t`Low is the starting point for faster searches. Medium may improve difficult requests and uses more tokens.`}
                        >
                            <MenuItem value="low">{t`Low`}</MenuItem>
                            <MenuItem value="medium">{t`Medium`}</MenuItem>
                        </TextField>
                        <TextField
                            label={t`Maximum recommendations`}
                            type="number"
                            value={resultCount}
                            disabled={pending}
                            onChange={(event) => setResultCount(event.target.value)}
                            error={
                                !!resultCount &&
                                (!/^\d+$/.test(resultCount) ||
                                    Number(resultCount) < 1 ||
                                    Number(resultCount) > (settings.maxResultCount ?? 100))
                            }
                            helperText={`Standard je Antwort: ganze Zahl von 1 bis ${
                                settings.maxResultCount ?? 100
                            }. Im Chat kannst du die Zahl pro Nachricht ändern.`}
                            slotProps={{
                                htmlInput: {
                                    min: 1,
                                    max: settings.maxResultCount ?? 100,
                                    step: 1,
                                    inputMode: 'numeric',
                                },
                            }}
                        />
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Button
                                variant="contained"
                                disabled={
                                    pending ||
                                    !/^\d+$/.test(resultCount) ||
                                    Number(resultCount) < 1 ||
                                    Number(resultCount) > (settings.maxResultCount ?? 100)
                                }
                                onClick={() => {
                                    void execute(async () => {
                                        setSettings(
                                            await aiApi<AiSettingsData>('settings', {
                                                enabled: settings.enabled,
                                                model: settings.model,
                                                reasoning: settings.reasoning,
                                                resultCount: Number(resultCount),
                                                key: key.trim(),
                                            }),
                                        );
                                        setKey('');
                                        setMessage(t`AI settings saved`);
                                    });
                                }}
                            >{t`Save AI settings`}</Button>
                            <Button
                                disabled={pending || !settings.configured}
                                onClick={() => {
                                    void execute(async () => {
                                        const result = await aiApi<{ model: string }>('test', {});
                                        setMessage(`${t`Connection successful`}: ${result.model}`);
                                    });
                                }}
                            >{t`Test saved connection`}</Button>
                            <Button
                                color="error"
                                disabled={pending || !settings.configured}
                                onClick={() => {
                                    void execute(async () => {
                                        setSettings(await aiApi<AiSettingsData>('settings', { removeKey: true }));
                                        setKey('');
                                        setMessage(t`OpenAI key removed`);
                                    });
                                }}
                            >{t`Remove OpenAI key`}</Button>
                        </Stack>
                        <Typography
                            color="text.secondary"
                            variant="body2"
                        >{t`Connection testing checks model access without generating a paid AI response. It does not check your remaining API credit.`}</Typography>
                    </Stack>
                </Paper>
            )}
            <Button component={Link} to={AppRoutes.sources.children.aiSearch.path}>{t`Open AI search`}</Button>
            <Button component={Link} to={AppRoutes.settings.children.aiUsage.path}>{t`AI usage and balance`}</Button>
        </Stack>
    );
}
