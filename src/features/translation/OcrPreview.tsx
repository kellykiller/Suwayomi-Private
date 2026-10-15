/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { SpinnerImage } from '@/base/components/SpinnerImage.tsx';
import { translationImage } from '@/features/translation/Translation.api.ts';
import type { TranslationJob } from '@/features/translation/Translation.api.ts';

export function OcrPreview({ job, onClose }: { job: TranslationJob; onClose: () => void }) {
    const [pageIndex, setPageIndex] = useState(0);
    const [showBoxes, setShowBoxes] = useState(true);
    const [selectedId, setSelectedId] = useState<string>();
    const [loadedImage, setLoadedImage] = useState('');
    const scrollArea = useRef<HTMLDivElement>(null);
    const pages = job.pages ?? [];
    const page = pages[pageIndex];
    const selected = page?.blocks.find((block) => block.id === selectedId);
    const image = translationImage(job.id, 'original', page?.index ?? pageIndex, job.revision);
    const navigate = (index: number) => {
        setPageIndex(index);
        setSelectedId(undefined);
        scrollArea.current?.scrollTo({ top: 0, left: 0 });
    };
    return (
        <Dialog open fullScreen onClose={onClose} aria-labelledby="ocr-preview-title">
            <Stack sx={{ height: '100%', minHeight: 0 }}>
                <Paper square sx={{ p: 2, zIndex: 1 }}>
                    <Stack spacing={1}>
                        <Stack
                            direction="row"
                            spacing={2}
                            sx={{ justifyContent: 'space-between', alignItems: 'center' }}
                        >
                            <Typography id="ocr-preview-title" variant="h6">
                                OCR-Vorschau
                            </Typography>
                            <Button onClick={onClose}>Schließen</Button>
                        </Stack>
                        <Typography variant="body2" noWrap title={`${job.title} – ${job.chapterName}`}>
                            {job.title} – {job.chapterName}
                        </Typography>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                            <Button disabled={pageIndex === 0} onClick={() => navigate(pageIndex - 1)}>
                                Zurück
                            </Button>
                            <TextField
                                select
                                size="small"
                                label="Seite"
                                value={pageIndex}
                                onChange={(event) => navigate(Number(event.target.value))}
                                sx={{ minWidth: 130 }}
                            >
                                {pages.map((item, index) => (
                                    <MenuItem key={item.index} value={index}>
                                        {index + 1} / {pages.length}
                                    </MenuItem>
                                ))}
                            </TextField>
                            <Button disabled={pageIndex >= pages.length - 1} onClick={() => navigate(pageIndex + 1)}>
                                Weiter
                            </Button>
                            <FormControlLabel
                                control={
                                    <Checkbox checked={showBoxes} onChange={(_, checked) => setShowBoxes(checked)} />
                                }
                                label="Textbereiche markieren"
                            />
                        </Stack>
                        <Box sx={{ minHeight: 60, maxHeight: 110, overflowY: 'auto' }} aria-live="polite">
                            <Typography variant="body2" color="text.secondary">
                                {page?.blocks.length ?? 0} erkannte Textbereiche auf dieser Seite.{' '}
                                {page?.blocks.length
                                    ? 'Kästchen anklicken, um den erkannten Originaltext zu lesen.'
                                    : 'Auf dieser Seite wurde kein Text erkannt.'}
                            </Typography>
                            <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                {selected?.text ||
                                    'Nur gespeicherte OCR-Ergebnisse – keine Übersetzung oder KI-Anfrage.'}
                            </Typography>
                        </Box>
                    </Stack>
                </Paper>
                <Box
                    ref={scrollArea}
                    sx={{ flex: 1, minHeight: 0, overflow: 'auto', bgcolor: 'grey.900', p: { xs: 0, sm: 2 } }}
                >
                    {page && (
                        <Box
                            sx={{
                                position: 'relative',
                                width: '100%',
                                maxWidth: 1200,
                                mx: 'auto',
                                aspectRatio: `${page.width} / ${page.height}`,
                            }}
                        >
                            <SpinnerImage
                                key={image}
                                src={image}
                                alt={`Originalseite ${pageIndex + 1}`}
                                useFetchApi
                                onLoad={() => setLoadedImage(image)}
                                onError={() => setLoadedImage('')}
                                imgStyle={{ display: 'block', width: '100%', height: 'auto' }}
                            />
                            {showBoxes &&
                                loadedImage === image &&
                                page.blocks.map((block, index) => (
                                    <Box
                                        key={block.id}
                                        component="button"
                                        type="button"
                                        aria-label={`Textbereich ${index + 1}: ${block.text}`}
                                        aria-pressed={selectedId === block.id}
                                        title={block.text}
                                        onClick={() => setSelectedId(block.id)}
                                        sx={(theme) => ({
                                            position: 'absolute',
                                            left: `${(block.box[0] / page.width) * 100}%`,
                                            top: `${(block.box[1] / page.height) * 100}%`,
                                            width: `${((block.box[2] - block.box[0]) / page.width) * 100}%`,
                                            height: `${((block.box[3] - block.box[1]) / page.height) * 100}%`,
                                            minWidth: 0,
                                            p: 0,
                                            cursor: 'pointer',
                                            border: `2px solid ${selectedId === block.id ? '#e65100' : '#1565c0'}`,
                                            bgcolor: alpha(selectedId === block.id ? '#ff9800' : '#2196f3', 0.22),
                                            '&:hover, &:focus-visible': {
                                                bgcolor: alpha('#ff9800', 0.35),
                                                outline: `2px solid ${theme.palette.common.white}`,
                                                outlineOffset: 1,
                                                zIndex: 1,
                                            },
                                        })}
                                    />
                                ))}
                        </Box>
                    )}
                </Box>
            </Stack>
        </Dialog>
    );
}
