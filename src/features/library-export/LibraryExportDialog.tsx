/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useRef, useState } from 'react';
import type { AwaitableComponentProps } from 'awaitable-component';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { requestManager } from '@/lib/requests/RequestManager.ts';
import { AuthManager } from '@/features/authentication/AuthManager.ts';
import { getErrorMessage } from '@/lib/HelperFunctions.ts';

type Selection = { mangaIds?: number[]; chapterIds?: number[] };
type ExportPlan = {
    title: string;
    chapterCount: number;
    readyCount: number;
    mangaCount: number;
    missingIds: number[];
};
type Props = AwaitableComponentProps<void> & Selection;

async function getPlan(selection: Selection, signal: AbortSignal): Promise<ExportPlan> {
    const token = AuthManager.getAccessToken();
    const response = await fetch('/private-api/exports/plan', {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: {
            'Content-Type': 'application/json',
            'X-Suwayomi-Private': '1',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(selection),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Export: HTTP ${response.status}`);
    return result as ExportPlan;
}

function waitForDownload(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const stop = () => {
            clearTimeout(timer);
            reject(new Error('Exportvorbereitung abgebrochen.'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
        }, 3000);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
    });
}

export function LibraryExportDialog({ mangaIds, chapterIds, isVisible, onDismiss, onExitComplete }: Props) {
    const [plan, setPlan] = useState<ExportPlan | null>(null);
    const [format, setFormat] = useState<'cbz' | 'folders'>('folders');
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState('');
    const [handedOff, setHandedOff] = useState(false);
    const active = useRef<AbortController | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        active.current = controller;
        setLoading(true);
        getPlan({ mangaIds, chapterIds }, controller.signal)
            .then(setPlan)
            .catch((reason: unknown) => {
                if (!controller.signal.aborted) setError(getErrorMessage(reason));
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [mangaIds, chapterIds]);

    const close = () => {
        active.current?.abort();
        onDismiss();
    };

    const start = async () => {
        const controller = new AbortController();
        active.current = controller;
        setWorking(true);
        setError('');
        setHandedOff(false);
        try {
            let current = await getPlan({ mangaIds, chapterIds }, controller.signal);
            setPlan(current);
            if (current.missingIds.length) {
                // Explicit export action uses the existing Suwayomi downloader, never a second source fetcher.
                await requestManager.addChaptersToDownloadQueue(current.missingIds).response;
                const deadline = Date.now() + 30 * 60 * 1000;
                while (current.missingIds.length) {
                    if (Date.now() > deadline)
                        throw new Error(
                            'NAS-Downloads sind noch nicht vollständig. Bitte die Download-Warteschlange prüfen und den Export erneut starten.',
                        );
                    await waitForDownload(controller.signal);
                    current = await getPlan({ mangaIds, chapterIds }, controller.signal);
                    setPlan(current);
                }
            }
            controller.signal.throwIfAborted();
            const parameters = new URLSearchParams({ format });
            if (mangaIds?.length) parameters.set('mangaIds', mangaIds.join(','));
            if (chapterIds?.length) parameters.set('chapterIds', chapterIds.join(','));
            const anchor = document.createElement('a');
            anchor.href = `/private-api/exports/archive?${parameters}`;
            anchor.download = '';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setHandedOff(true);
        } catch (reason) {
            if (!controller.signal.aborted) setError(getErrorMessage(reason));
        } finally {
            if (!controller.signal.aborted) setWorking(false);
        }
    };

    return (
        <Dialog open={isVisible} onClose={close} onTransitionExited={onExitComplete} fullWidth maxWidth="sm">
            <DialogTitle>Auf Gerät speichern</DialogTitle>
            <DialogContent dividers>
                <Stack spacing={2}>
                    {(loading || working) && <LinearProgress />}
                    {error && <Alert severity="error">{error}</Alert>}
                    {plan && (
                        <Typography>
                            {plan.title} · {plan.chapterCount} Kapitel · {plan.readyCount} auf dem NAS verfügbar
                        </Typography>
                    )}
                    <RadioGroup value={format} onChange={(_, value) => setFormat(value as 'cbz' | 'folders')}>
                        <FormControlLabel
                            value="cbz"
                            control={<Radio />}
                            disabled={working}
                            label="CBZ – Comic-Archiv je Kapitel"
                        />
                        <FormControlLabel
                            value="folders"
                            control={<Radio />}
                            disabled={working}
                            label="Kapitelordner mit nummerierten Bildern (ZIP)"
                        />
                    </RadioGroup>
                    <Typography variant="body2">
                        Originalbilder ohne Qualitätsverlust. Seiten heißen 0001.jpg, 0002.jpg usw.; das ursprüngliche
                        Bildformat bleibt erhalten. Bei mehreren Kapiteln enthält der Download ein ZIP mit einem Ordner
                        oder einer CBZ-Datei je Kapitel. Das ZIP nach dem Download entpacken. CBR/RAR wird nicht
                        erzeugt.
                    </Typography>
                    {!!plan?.missingIds.length && (
                        <Alert severity="info">
                            {plan.missingIds.length} Kapitel fehlen auf dem NAS. „Herunterladen und speichern“ lädt sie
                            zuerst über Suwayomis Download-Warteschlange und startet anschließend den Geräte-Download.
                        </Alert>
                    )}
                    {working && (
                        <Typography variant="body2">
                            Warte auf vollständige NAS-Downloads. Beim Schließen endet die Exportvorbereitung; bereits
                            eingereihte NAS-Downloads laufen weiter.
                        </Typography>
                    )}
                    {handedOff && (
                        <Alert severity="success">
                            Download an den Browser übergeben. Fortschritt und eventuelle Fehler stehen in dessen
                            Downloadanzeige.
                        </Alert>
                    )}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={close}>{working ? 'Vorbereitung abbrechen' : 'Schließen'}</Button>
                <Button
                    variant="contained"
                    disabled={loading || working || !plan || handedOff}
                    onClick={() => void start()}
                >
                    {plan?.missingIds.length ? 'Herunterladen und speichern' : 'Auf Gerät speichern'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
