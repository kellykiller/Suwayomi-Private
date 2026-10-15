/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Link } from 'react-router-dom';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import type { TaskSummary } from '@/features/tasks/Tasks.api.ts';
import { tasksApi } from '@/features/tasks/Tasks.api.ts';
import { AuthManager } from '@/features/authentication/AuthManager.ts';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';

type Job = { id: string; phase: string; action: string; message: string; logs: string[]; finished: string | null };
type Status = {
    manifest: { version: string; commit: string; upstreamTag: string };
    repository: string;
    serverRevision: number;
    configured: { github: boolean; portainer: boolean };
    busy: boolean;
    taskBlockers?: TaskSummary[];
    canRollback: boolean;
    job: Job | null;
};
type Check = {
    latest: { sha: string; message: string; date: string; url: string };
    version: string;
    compatible: boolean;
    minimumServerRevision: number;
    hasUpdate: boolean;
};

async function api<T>(path: string, data?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = AuthManager.getAccessToken();
    const response = await fetch(`/private-api/${path}`, {
        method: data ? 'POST' : 'GET',
        credentials: 'include',
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'Content-Type': 'application/json', 'X-Suwayomi-Private': '1' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        signal,
    });
    const value = await response.json();
    if (!response.ok) {
        throw new Error(value.error || `HTTP ${response.status}`);
    }
    return value as T;
}

export function PrivateUpdates() {
    const { t } = useLingui();
    useAppTitle(t`Private updates`);
    const [status, setStatus] = useState<Status | null>(null);
    const [check, setCheck] = useState<Check | null>(null);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [pending, setPending] = useState(false);
    const [github, setGithub] = useState('');
    const [portainer, setPortainer] = useState('');
    const [saved, setSaved] = useState(false);
    const loadedCommit = useRef<string | null>(null);

    const refresh = useCallback(async (signal?: AbortSignal) => {
        const value = await api<Status>('status', undefined, signal);
        loadedCommit.current ||= value.manifest.commit;
        setStatus(value);
        setConnectionError('');
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        let stopped = false;
        const poll = () =>
            refresh(controller.signal).catch((reason: Error) => {
                if (!stopped) {
                    setConnectionError(reason.message);
                }
            });
        void poll();
        const timer = window.setInterval(() => {
            void poll();
        }, 4000);
        return () => {
            stopped = true;
            controller.abort();
            window.clearInterval(timer);
        };
    }, [refresh]);

    const execute = async (action: () => Promise<void>) => {
        setError('');
        setSaved(false);
        setPending(true);
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
        queued: t`Waiting`,
        checking: t`Checking version`,
        downloading: t`Downloading project`,
        building: t`Building update`,
        deploying: t`Installing and checking startup`,
        succeeded: t`Completed`,
        failed: t`Failed`,
    };
    const busy = pending || !!status?.busy;
    const blocked = !!status?.taskBlockers?.length;
    const changed = !!status && loadedCommit.current !== status.manifest.commit;
    const hasUpdate = !!check && check.latest.sha !== status?.manifest.commit;

    return (
        <Stack spacing={2} sx={{ p: 2, maxWidth: 900, mx: 'auto' }}>
            {(error || connectionError) && (
                <Alert
                    severity="error"
                    action={
                        <Button
                            onClick={() => {
                                void execute(() => refresh());
                            }}
                        >{t`Retry`}</Button>
                    }
                >
                    {error || connectionError}
                </Alert>
            )}
            <Button component={Link} to={AppRoutes.settings.children.tasks.path}>
                Laufende Aufgaben öffnen
            </Button>
            {status?.taskBlockers?.map((task) => (
                <Alert severity="warning" key={task.id}>
                    Update wartet auf: {task.title}.
                    <Stack direction="row" spacing={1}>
                        <Button component={Link} to={task.href}>
                            Vorgang öffnen
                        </Button>
                        {task.pausable && (
                            <Button
                                variant="outlined"
                                disabled={pending || task.pauseRequested}
                                onClick={() => {
                                    void execute(async () => {
                                        await tasksApi('/pause', { kind: task.kind, id: task.id });
                                    });
                                }}
                            >
                                {task.pauseRequested ? 'Pausieren angefordert …' : 'Vorgang pausieren'}
                            </Button>
                        )}
                        <Button
                            color="warning"
                            disabled={pending}
                            onClick={() => {
                                void execute(async () => {
                                    await tasksApi('/cancel', { kind: task.kind, id: task.id });
                                });
                            }}
                        >
                            Vorgang abbrechen
                        </Button>
                    </Stack>
                </Alert>
            ))}
            <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack spacing={1}>
                    <Typography variant="h6">Suwayomi-Private</Typography>
                    <Typography>
                        {t`Installed version`}: {status?.manifest.version ?? '…'}{' '}
                        {status ? `(${status.manifest.commit.slice(0, 12)})` : ''}
                    </Typography>
                    <Typography>
                        {t`Based on Suwayomi WebUI`}: {status?.manifest.upstreamTag ?? '…'}
                    </Typography>
                    <Typography color="text.secondary">
                        {status?.repository ?? 'kellykiller/Suwayomi-Private'}
                    </Typography>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', pt: 1 }}>
                        <Button
                            variant="outlined"
                            disabled={busy || !status}
                            onClick={() => {
                                void execute(async () => setCheck(await api<Check>('check', {})));
                            }}
                        >{t`Check for updates`}</Button>
                        <Button
                            variant="contained"
                            disabled={busy || blocked || !hasUpdate || !check?.compatible}
                            onClick={() => {
                                void execute(async () => {
                                    await api('update', { commit: check!.latest.sha });
                                });
                            }}
                        >{t`Install update`}</Button>
                        <Button
                            disabled={busy || blocked || !status?.canRollback}
                            onClick={() => {
                                void execute(async () => {
                                    await api('rollback', {});
                                });
                            }}
                        >{t`Restore previous version`}</Button>
                    </Stack>
                </Stack>
            </Paper>
            {check && (
                <Alert severity={check.compatible ? 'info' : 'warning'}>
                    {hasUpdate ? t`Changes are available` : t`This version is up to date`}
                    {hasUpdate && (
                        <Typography sx={{ pt: 1 }}>
                            {check.latest.message} ({check.latest.sha.slice(0, 12)})
                        </Typography>
                    )}
                    {!check.compatible && (
                        <Typography>
                            {t`A newer Suwayomi server is required before installing this update`}: r
                            {check.minimumServerRevision}
                        </Typography>
                    )}
                </Alert>
            )}
            {status?.job && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={1}>
                        <Typography variant="subtitle1">{phases[status.job.phase] ?? status.job.phase}</Typography>
                        {status.busy && <LinearProgress />}
                        {status.job.message && (
                            <Alert severity={status.job.phase === 'failed' ? 'error' : 'info'}>
                                {status.job.message}
                            </Alert>
                        )}
                        {status.busy && (
                            <Typography color="text.secondary">{t`The update continues if you close this page. The connection may briefly drop during installation.`}</Typography>
                        )}
                        {changed && (
                            <Button
                                variant="contained"
                                onClick={() => window.location.reload()}
                            >{t`Reload page`}</Button>
                        )}
                        {!!status.job.logs.length && (
                            <Accordion>
                                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                    <Typography>{t`Build log`}</Typography>
                                </AccordionSummary>
                                <AccordionDetails>
                                    <Typography
                                        component="pre"
                                        sx={{
                                            fontFamily: 'monospace',
                                            fontSize: 12,
                                            whiteSpace: 'pre-wrap',
                                            overflowWrap: 'anywhere',
                                            maxHeight: 360,
                                            overflow: 'auto',
                                        }}
                                    >
                                        {status.job.logs.join('\n')}
                                    </Typography>
                                </AccordionDetails>
                            </Accordion>
                        )}
                    </Stack>
                </Paper>
            )}
            <Accordion>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography>{t`API keys`}</Typography>
                </AccordionSummary>
                <AccordionDetails>
                    <Stack spacing={2}>
                        <Typography color="text.secondary">{t`Saved keys are never displayed. Leave a field empty to keep its current key.`}</Typography>
                        <TextField
                            label={t`GitHub read token`}
                            type="password"
                            autoComplete="new-password"
                            value={github}
                            onChange={(event) => setGithub(event.target.value)}
                            helperText={status?.configured.github ? t`Saved` : t`Not configured`}
                        />
                        <TextField
                            label={t`Portainer API key`}
                            type="password"
                            autoComplete="new-password"
                            value={portainer}
                            onChange={(event) => setPortainer(event.target.value)}
                            helperText={status?.configured.portainer ? t`Saved` : t`Not configured`}
                        />
                        <Button
                            disabled={busy || (!github.trim() && !portainer.trim())}
                            onClick={() => {
                                void execute(async () => {
                                    await api('credentials', { github: github.trim(), portainer: portainer.trim() });
                                    setGithub('');
                                    setPortainer('');
                                    setSaved(true);
                                });
                            }}
                        >{t`Save API keys`}</Button>
                        {saved && <Alert severity="success">{t`API keys saved`}</Alert>}
                    </Stack>
                </AccordionDetails>
            </Accordion>
        </Stack>
    );
}
