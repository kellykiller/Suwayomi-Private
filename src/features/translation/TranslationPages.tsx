/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { TranslationJob } from '@/features/translation/Translation.api.ts';

export function TranslationPages({
    job,
    scope,
    selected,
    currentPage,
    onScope,
    onSelected,
}: {
    job: TranslationJob;
    scope: 'all' | 'selected';
    selected: number[];
    currentPage: number;
    onScope: (scope: 'all' | 'selected') => void;
    onSelected: (pages: number[]) => void;
}) {
    const pages = job.pages ?? [];
    const included = pages.filter((page) => scope === 'all' || selected.includes(page.index));
    const complete = included.filter((page) => page.translationComplete).length;
    return (
        <Stack spacing={1}>
            <TextField
                select
                label="Übersetzungsumfang"
                value={scope}
                onChange={(event) => onScope(event.target.value as 'all' | 'selected')}
            >
                <MenuItem value="all">Gesamtes Kapitel – nur fehlende Seiten übersetzen</MenuItem>
                <MenuItem value="selected">Einzelne Seiten auswählen</MenuItem>
            </TextField>
            {scope === 'selected' && (
                <>
                    <Stack direction="row" spacing={1}>
                        <Button onClick={() => onSelected([currentPage])}>
                            Nur aktuell angezeigte Seite ({currentPage + 1})
                        </Button>
                        <Button disabled={!selected.length} onClick={() => onSelected([])}>
                            Auswahl leeren
                        </Button>
                    </Stack>
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
                            maxHeight: 300,
                            overflowY: 'auto',
                            p: 1,
                        }}
                    >
                        {pages.map((page) => (
                            <FormControlLabel
                                key={page.index}
                                sx={{ m: 0 }}
                                control={
                                    <Checkbox
                                        checked={selected.includes(page.index)}
                                        onChange={(_, checked) =>
                                            onSelected(
                                                checked
                                                    ? [...selected, page.index]
                                                    : selected.filter((index) => index !== page.index),
                                            )
                                        }
                                    />
                                }
                                label={`Seite ${page.index + 1}${page.translationComplete ? ' · übersetzt' : ''}`}
                            />
                        ))}
                    </Box>
                </>
            )}
            <Typography variant="body2" color="text.secondary">
                {included.length} Seiten im Umfang · {included.length - complete} noch zu übersetzen · {complete}{' '}
                bereits übersetzt. Fertige Übersetzungen werden übernommen und nicht erneut bei OpenAI angefragt. Beim
                ersten Test wird einmal der Kontext aus dem gesamten Kapiteltext erstellt. Auch Nachbarbilder dienen als
                Kontext; übersetzt werden nur die ausgewählten Seiten.
            </Typography>
            {scope === 'selected' && !selected.length && (
                <Typography color="warning.main">Bitte mindestens eine Seite auswählen.</Typography>
            )}
        </Stack>
    );
}
