/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useEffect, useRef } from 'react';

export function useReaderOriginalPages(
    chapterId: number,
    translationLoading: boolean,
    hasTranslation: boolean,
    loadOriginal: () => void,
) {
    const load = useRef(loadOriginal);
    load.current = loadOriginal;
    // The mutation callback can change identity on every render. Only the chapter
    // and the resolved language preference should trigger another fetch.
    useEffect(() => {
        if (chapterId > 0 && !translationLoading && !hasTranslation) {
            load.current();
        }
    }, [chapterId, translationLoading, hasTranslation]);
}
