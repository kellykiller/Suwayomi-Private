/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useState } from 'react';
import {
    chapterAvailability,
    type AvailabilityManga,
    type ChapterAvailability,
} from '@/features/manga/services/ChapterAvailability.ts';

export function useReadableMangas<Manga extends AvailabilityManga>(mangas: Manga[], scope: string) {
    const key = JSON.stringify([scope, mangas.map(({ id, sourceId }) => [id, sourceId])]);
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<{ key: string; statuses: Map<number, ChapterAvailability> }>({
        key: '',
        statuses: new Map(),
    });
    useEffect(() => {
        const controller = new AbortController();
        setState({ key, statuses: new Map() });
        for (const manga of mangas) {
            void chapterAvailability.inspect(manga, controller.signal).then((status) => {
                if (controller.signal.aborted) {
                    return;
                }
                setState((current) => ({
                    key,
                    statuses: new Map(current.key === key ? current.statuses : []).set(manga.id, status),
                }));
            });
        }
        return () => controller.abort();
    }, [key, attempt]);
    const statuses = state.key === key ? state.statuses : new Map<number, ChapterAvailability>();
    return {
        mangas: mangas.filter(({ id }) => statuses.get(id) === 'readable'),
        checking: mangas.some(({ id }) => !statuses.has(id)),
        failed: mangas.filter(({ id }) => statuses.get(id) === 'failed').length,
        empty: mangas.filter(({ id }) => statuses.get(id) === 'empty').length,
        statuses,
        retry: () => {
            chapterAvailability.retryFailed(mangas.map(({ id }) => id));
            setAttempt((value) => value + 1);
        },
    };
}
