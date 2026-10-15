/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import TranslateIcon from '@mui/icons-material/Translate';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { translationApi } from '@/features/translation/Translation.api.ts';
import type { TranslationAvailable } from '@/features/translation/Translation.api.ts';

const eventName = 'suwayomi-translation-reader';
const preference = () => localStorage.getItem(eventName) === 'de';
const subscribe = (listener: () => void) => {
    window.addEventListener(eventName, listener);
    window.addEventListener('storage', listener);
    return () => {
        window.removeEventListener(eventName, listener);
        window.removeEventListener('storage', listener);
    };
};
export function useTranslationReader(chapterId: number) {
    const enabled = useSyncExternalStore(subscribe, preference, () => false);
    const [result, setResult] = useState<{ chapterId: number; available: TranslationAvailable; error?: string }>();
    useEffect(() => {
        const controller = new AbortController();
        if (enabled && chapterId > 0) {
            void translationApi<{ available: TranslationAvailable }>(
                `chapter/${chapterId}`,
                undefined,
                controller.signal,
            )
                .then(({ available }) => setResult({ chapterId, available }))
                .catch((reason: Error) => {
                    if (!controller.signal.aborted) {
                        setResult({ chapterId, available: null, error: reason.message });
                    }
                });
        }
        return () => controller.abort();
    }, [enabled, chapterId]);
    return {
        enabled,
        loading: enabled && result?.chapterId !== chapterId,
        translatedPages: result?.chapterId === chapterId ? result.available?.translatedPages : undefined,
        pageCount: result?.chapterId === chapterId ? result.available?.pageCount : undefined,
        pages: enabled && result?.chapterId === chapterId ? result.available?.pages : undefined,
        error: enabled ? result?.error : undefined,
    };
}
export function TranslationReaderActions({ chapterId }: { chapterId: number }) {
    const { enabled, loading, pages, error, translatedPages, pageCount } = useTranslationReader(chapterId);
    let title = 'Vorhandene deutsche Übersetzung im Reader bevorzugen';
    if (enabled) {
        title =
            error || 'Keine deutsche Übersetzung verfügbar – das Original wird angezeigt. Sprachpräferenz ausschalten.';
        if (loading) {
            title = 'Gespeicherte Übersetzung wird geprüft';
        } else if (pages) {
            title =
                translatedPages !== undefined && pageCount !== undefined && translatedPages < pageCount
                    ? `${translatedPages} von ${pageCount} Seiten übersetzt; übrige Seiten im Original. Zum Original wechseln.`
                    : 'Deutsche Übersetzung aktiv. Zum Original wechseln.';
        }
    }
    return (
        <Tooltip title={title}>
            <IconButton
                color={enabled && pages ? 'primary' : 'inherit'}
                aria-label={enabled ? 'Original anzeigen' : 'Deutsche Übersetzung bevorzugen'}
                onClick={() => {
                    localStorage.setItem(eventName, enabled ? 'original' : 'de');
                    window.dispatchEvent(new Event(eventName));
                }}
            >
                <TranslateIcon />
            </IconButton>
        </Tooltip>
    );
}
