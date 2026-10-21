/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AuthManager } from '@/features/authentication/AuthManager.ts';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';
import { formatLogTime } from '@/features/logs/logTime.ts';

const categories: Record<string, string> = {
    translation: 'Kapitelübersetzung',
    ocr: 'Texterkennung und Bildverarbeitung',
    ai: 'KI-Suche',
    updates: 'Private Updates',
    system: 'Private WebUI',
    suwayomi: 'Suwayomi-Server',
};
type LogResult = { category: string; title: string; generated: string; text: string };
export function LogsScreen() {
    useAppTitle('Protokolle');
    const [params, setParams] = useSearchParams();
    const selected = params.get('category') || 'translation';
    const category = Object.hasOwn(categories, selected) ? selected : 'translation';
    const [result, setResult] = useState<LogResult>();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [automatic, setAutomatic] = useState(false);
    const [revision, setRevision] = useState(0);
    const [filter, setFilter] = useState('');
    const [archiving, setArchiving] = useState(false);
    const downloadAll = async () => {
        setArchiving(true);
        try {
            const token = AuthManager.getAccessToken();
            const response = await fetch('/private-api/logs/archive', {
                credentials: 'include',
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (!response.ok) {
                throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
            }
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = `suwayomi-logs-${new Date().toISOString().replaceAll(':', '-')}.zip`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setArchiving(false);
        }
    };
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            setLoading(true);
            try {
                const token = AuthManager.getAccessToken();
                const response = await fetch(`/private-api/logs/read?category=${category}`, {
                    credentials: 'include',
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                    signal: controller.signal,
                });
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.error || `HTTP ${response.status}`);
                }
                if (!controller.signal.aborted) {
                    setResult(data);
                    setError('');
                }
            } catch (reason) {
                if (!controller.signal.aborted) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                }
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                    if (automatic) {
                        timer = setTimeout(() => {
                            void refresh();
                        }, 10000);
                    }
                }
            }
        };
        void refresh();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [category, revision, automatic]);
    const current = result?.category === category ? result : undefined;
    const visible = current?.text
        .split('\n')
        .filter((line) => !filter || line.toLowerCase().includes(filter.toLowerCase()))
        .join('\n');
    const download = () => {
        if (!current) {
            return;
        }
        const url = URL.createObjectURL(new Blob([current.text], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `suwayomi-${category}-${current.generated.replaceAll(':', '-')}.log`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return (
        <Stack spacing={2} sx={{ p: 3 }}>
            <Typography variant="h5">Protokolle</Typography>
            <Typography>
                Fehler, Verarbeitungsschritte und Container-Ausgaben nach Kategorie. Der Download enthält das
                vollständige angezeigte Protokoll ohne Textfilter.
            </Typography>
            <Alert severity="info">
                API-Schlüssel und Zugangsdaten werden ausgeblendet. Manga-Titel und technische Angaben können enthalten
                sein. Vollständige KI-Prompts und Kosten findest du weiterhin in der KI-Nutzungshistorie.
            </Alert>
            <TextField
                select
                label="Kategorie"
                value={category}
                onChange={(event) => {
                    setParams({ category: event.target.value });
                    setFilter('');
                }}
            >
                {Object.entries(categories).map(([id, title]) => (
                    <MenuItem key={id} value={id}>
                        {title}
                    </MenuItem>
                ))}
            </TextField>
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1 }}>
                <Button variant="outlined" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
                    Aktualisieren
                </Button>
                <Button variant="contained" disabled={!current} onClick={download}>
                    Log herunterladen
                </Button>
                <Button
                    variant="contained"
                    disabled={archiving}
                    onClick={() => {
                        void downloadAll();
                    }}
                >
                    {archiving ? 'ZIP wird erstellt …' : 'Alle Logs als ZIP herunterladen'}
                </Button>
                <FormControlLabel
                    control={<Switch checked={automatic} onChange={(_, checked) => setAutomatic(checked)} />}
                    label="Alle 10 Sekunden aktualisieren"
                />
            </Stack>
            {loading && <LinearProgress />}
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
                label="Text oder Auftragskennung filtern"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
            />
            {current && (
                <Typography variant="body2">
                    Stand: {formatLogTime(current.generated)} · {current.title} · Deutsche Zeit (Europe/Berlin)
                </Typography>
            )}
            <Box
                component="pre"
                sx={{
                    m: 0,
                    p: 2,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    maxHeight: '65vh',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    fontSize: '0.8rem',
                    userSelect: 'text',
                }}
            >
                {visible || (current ? 'Keine passenden Einträge.' : 'Protokoll wird geladen …')}
            </Box>
            <Typography variant="body2">
                Die Ereignisprotokolle bleiben bei Updates erhalten und rotieren je Kategorie bei 2 MiB mit drei
                Archivdateien. Die Webansicht zeigt einen begrenzten Auszug; gespeicherte Übersetzungs- und
                Updateaufträge werden zusätzlich zusammengefasst. Container-Ausgaben zeigen die letzten 500 Zeilen.
            </Typography>
        </Stack>
    );
}
