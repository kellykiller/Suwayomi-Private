/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useState } from 'react';
import Chip from '@mui/material/Chip';
import TranslateIcon from '@mui/icons-material/Translate';
import { translationApi } from '@/features/translation/Translation.api.ts';

export type ChapterTranslationStatus = {
    chapterId: number;
    state: 'translated' | 'partial' | 'retained' | 'unavailable';
    translatedPages: number;
    pageCount: number;
};
export function useChapterTranslationStatuses(mangaId: number) {
    const [result, setResult] = useState<{ mangaId: number; statuses: ChapterTranslationStatus[] }>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        const refresh = async () => {
            try {
                const value = await translationApi<{ mangaId: number; statuses: ChapterTranslationStatus[] }>(
                    `statuses?mangaId=${mangaId}`,
                    undefined,
                    controller.signal,
                );
                if (!controller.signal.aborted) {
                    setResult(value);
                    setError('');
                }
            } catch (reason) {
                if (!controller.signal.aborted) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                }
            }
        };
        let refreshing = false;
        const update = () => {
            if (refreshing) {
                return;
            }
            refreshing = true;
            void refresh().finally(() => {
                refreshing = false;
            });
        };
        update();
        const timer = setInterval(() => {
            if (!document.hidden) {
                update();
            }
        }, 30000);
        window.addEventListener('focus', update);
        return () => {
            controller.abort();
            clearInterval(timer);
            window.removeEventListener('focus', update);
        };
    }, [mangaId]);
    return {
        statuses: new Map(
            (result?.mangaId === mangaId ? result.statuses : []).map((status) => [status.chapterId, status]),
        ),
        error,
    };
}

export function ChapterTranslationBadge({ status }: { status?: ChapterTranslationStatus }) {
    if (!status) {
        return null;
    }
    let label = 'Bereits übersetzt · Deutsch';
    if (status.state === 'partial') {
        label = `Teilübersetzt · ${status.translatedPages}/${status.pageCount} Seiten`;
    }
    if (status.state === 'retained') {
        label = 'Übersetzt · mit offenen Stellen';
    }
    if (status.state === 'unavailable') {
        label = 'Übersetzung gespeichert · Dateien prüfen';
    }
    return (
        <Chip
            size="small"
            icon={<TranslateIcon />}
            label={label}
            title={label}
            color={status.state === 'translated' ? 'success' : 'warning'}
            variant="outlined"
            sx={{ alignSelf: 'flex-start', mt: 0.5, maxWidth: '100%' }}
        />
    );
}
