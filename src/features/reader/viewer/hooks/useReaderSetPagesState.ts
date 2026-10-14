/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useLayoutEffect, useRef } from 'react';
import { getInitialReaderPageIndex } from '@/features/reader/Reader.utils.ts';
import { createPagesData } from '@/features/reader/viewer/pager/ReaderPager.utils.tsx';
import type {
    ReaderPageBackgroundColor,
    ReaderPageSpreadState,
    ReaderResumeMode,
    ReaderStatePages,
} from '@/features/reader/Reader.types.ts';
import { ReaderTransitionPageMode } from '@/features/reader/Reader.types.ts';
import type { TChapterReader } from '@/features/chapter/Chapter.types.ts';
import type { ReaderChaptersStoreSlice } from '@/features/reader/stores/ReaderChaptersStore.ts';
import { getReaderStore, getReaderPagesStore } from '@/features/reader/stores/ReaderStore.ts';
import { UrlUtil } from '@/lib/UrlUtil.ts';

export const useReaderSetPagesState = (
    isCurrentChapter: boolean,
    sourcePageUrls: string[] | undefined,
    isTranslated: boolean,
    resumeMode: ReaderResumeMode,
    lastPageRead: TChapterReader['lastPageRead'] | undefined,
    pages: ReaderStatePages['pages'],
    pageLoadStates: ReaderStatePages['pageLoadStates'],
    pagesToSpreadState: ReaderPageSpreadState[],
    pageBackgroundColors: ReaderPageBackgroundColor[],
    arePagesFetched: boolean,
    setArePagesFetched: (fetched: boolean) => void,
    setReaderStateChapters: ReaderChaptersStoreSlice['chapters']['setReaderStateChapters'],
    setTotalPages: ReaderStatePages['setTotalPages'],
    setPages: ReaderStatePages['setPages'],
    setPageUrls: ReaderStatePages['setPageUrls'],
    setPageLoadStates: ReaderStatePages['setPageLoadStates'],
    setPagesToSpreadState: (state: ReaderPageSpreadState[]) => void,
    setPageBackgroundColors: (state: ReaderPageBackgroundColor[]) => void,
    setCurrentPageIndex: ReaderStatePages['setCurrentPageIndex'],
    setPageToScrollToIndex: ReaderStatePages['setPageToScrollToIndex'],
    setTransitionPageMode: ReaderStatePages['setTransitionPageMode'],
) => {
    const previousPageData = useRef<string[]>(undefined);
    const previousView = useRef({ translated: isTranslated, current: isCurrentChapter });

    useLayoutEffect(() => {
        if (!sourcePageUrls) {
            return;
        }

        const pagesFromResponse = sourcePageUrls;
        const tmpPages = pagesFromResponse.length ? pagesFromResponse : [''];
        const newPages = tmpPages.map((page) =>
            UrlUtil.addParams(page, { sourceId: getReaderStore().manga?.sourceId }),
        );
        const isLanguageToggle =
            previousPageData.current &&
            isCurrentChapter &&
            previousView.current.current &&
            previousView.current.translated !== isTranslated;
        const initialReaderPageIndex = isLanguageToggle
            ? Math.min(getReaderPagesStore().currentPageIndex, newPages.length - 1)
            : getInitialReaderPageIndex(resumeMode, lastPageRead ?? 0, newPages.length - 1);

        const didPagesChange = previousPageData.current !== sourcePageUrls;
        if (didPagesChange) {
            previousPageData.current = sourcePageUrls;
            const newPageData = createPagesData(newPages);

            setArePagesFetched(true);
            setPages(newPageData);
            setPageUrls(newPages);
            setPageLoadStates(newPageData.map(({ primary: { url } }) => ({ url, loaded: false })));
            setPagesToSpreadState(newPageData.map(({ primary: { url } }) => ({ url, isSpread: false })));
            setPageBackgroundColors(newPageData.map(({ primary: { url } }) => ({ url, color: undefined })));
        } else {
            setPages(pages);
            setPageLoadStates(pageLoadStates);
            setPagesToSpreadState(pagesToSpreadState);
            setPageBackgroundColors(pageBackgroundColors);
        }

        setTotalPages(sourcePageUrls.length);
        setPageUrls(newPages);
        setCurrentPageIndex(initialReaderPageIndex);
        setPageToScrollToIndex(initialReaderPageIndex);
        setReaderStateChapters((prevState) => ({
            ...prevState,
            isCurrentChapterReady: arePagesFetched || didPagesChange,
        }));

        setTransitionPageMode(ReaderTransitionPageMode.NONE);
        previousView.current = { translated: isTranslated, current: isCurrentChapter };
    }, [sourcePageUrls, isCurrentChapter, isTranslated]);
};
