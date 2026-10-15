/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';
import { tasksApi, type TaskList } from '@/features/tasks/Tasks.api.ts';

const phases: Record<string, string> = {
    queued: 'Wartet',
    downloading: 'Lokalen Download einlesen',
    ocr: 'Texterkennung',
    ready: 'Bereit zur Prüfung',
    paused: 'Pausiert',
    context: 'Kapitelkontext',
    translating: 'Übersetzen',
    rendering: 'Texte einsetzen',
    planning: 'Suchanfrage auswerten',
    searching: 'Quellen durchsuchen',
    checking: 'Vorprüfung',
    building: 'Image erstellen',
    deploying: 'Bereitstellen',
    STARTED: 'Downloadwarteschlange aktiv',
    STOPPED: 'Downloads pausiert',
    running: 'Läuft',
};
export function TasksScreen() {
    useAppTitle('Laufende Aufgaben');
    const [data, setData] = useState<TaskList>();
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    const [cancelling, setCancelling] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const value = await tasksApi<TaskList>('', undefined, controller.signal);
                if (!controller.signal.aborted) {
                    setData(value);
                    setError('');
                }
            } catch (reason) {
                if (!controller.signal.aborted) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                }
            }
            if (!controller.signal.aborted) {
                timer = setTimeout(() => {
                    void poll();
                }, 4000);
            }
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [revision]);
    const cancel = async (kind: string, id: string, action: 'cancel' | 'pause' = 'cancel') => {
        setCancelling(id);
        setError('');
        try {
            await tasksApi(`/${action}`, { kind, id });
            setRevision((value) => value + 1);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setCancelling('');
        }
    };
    const tasks = data?.tasks || [];
    return (
        <Stack spacing={2} sx={{ p: 3 }}>
            <Typography variant="h5">Laufende Aufgaben</Typography>
            <Typography>
                Kapitelverarbeitung, KI-Suche, Private Updates, Downloads und Bibliotheksaktualisierung. Die Übersicht
                wird automatisch aktualisiert und ist unabhängig vom ursprünglichen Fenster.
            </Typography>
            <Button variant="outlined" onClick={() => setRevision((value) => value + 1)}>
                Aktualisieren
            </Button>
            {!data && !error && <LinearProgress />}
            {error && <Alert severity="error">{error}</Alert>}
            {data?.warnings.map((warning) => (
                <Alert severity="warning" key={warning}>
                    {warning}
                </Alert>
            ))}
            {data && !tasks.some((task) => task.active) && (
                <Alert severity={data.warnings.length ? 'warning' : 'info'}>
                    {data.warnings.length
                        ? 'In den erreichbaren Bereichen ist keine aktive Aufgabe bekannt. Andere Bereiche konnten nicht geprüft werden.'
                        : 'Aktuell läuft keine Aufgabe.'}
                </Alert>
            )}
            {tasks.map((task) => (
                <Paper key={`${task.kind}-${task.id}`} variant="outlined" sx={{ p: 2 }}>
                    <Stack spacing={1}>
                        <Typography variant="h6">{task.title}</Typography>
                        <Typography>
                            {phases[task.phase] || task.phase}
                            {!task.active ? ' · Angehalten oder bereit zur Prüfung' : ''}
                        </Typography>
                        <Typography variant="body2">{task.detail}</Typography>
                        {task.pauseRequested && (
                            <Alert severity="info">
                                Pausieren angefordert – laufende Seite oder KI-Antwort wird noch gespeichert.
                            </Alert>
                        )}
                        {task.progress && task.progress.total > 0 && (
                            <>
                                <LinearProgress
                                    variant="determinate"
                                    value={Math.max(
                                        0,
                                        Math.min(100, (task.progress.completed / task.progress.total) * 100),
                                    )}
                                />
                                <Typography variant="body2">
                                    {task.progress.completed}/{task.progress.total}
                                    {task.progress.blockCount !== undefined
                                        ? ` · ${task.progress.blockCount} Textbereiche`
                                        : ''}
                                </Typography>
                            </>
                        )}
                        <Stack direction="row" spacing={1}>
                            <Button component={Link} to={task.href} variant="outlined">
                                {!task.active && task.kind === 'translation' ? 'Öffnen / fortsetzen' : 'Vorgang öffnen'}
                            </Button>
                            {task.active && task.pausable && (
                                <Button
                                    variant="outlined"
                                    disabled={!!cancelling || task.pauseRequested}
                                    onClick={() => {
                                        void cancel(task.kind, task.id, 'pause');
                                    }}
                                >
                                    {task.pauseRequested ? 'Pausieren angefordert …' : 'Pausieren'}
                                </Button>
                            )}
                            {task.cancellable && (
                                <Button
                                    color="warning"
                                    disabled={!!cancelling}
                                    onClick={() => {
                                        void cancel(task.kind, task.id);
                                    }}
                                >
                                    {cancelling === task.id ? 'Bitte warten …' : 'Abbrechen'}
                                </Button>
                            )}
                        </Stack>
                    </Stack>
                </Paper>
            ))}
            <Typography variant="body2">
                Ein Abbruch beendet laufende Anfragen, kann bereits angefallene API-Kosten aber nicht zurücknehmen.
                Fertige Ergebnisse bleiben gespeichert. Downloads werden in ihrer Warteschlange verwaltet; laufende
                Software-Updates werden während der Bereitstellung nicht zwangsweise beendet.
            </Typography>
        </Stack>
    );
}
