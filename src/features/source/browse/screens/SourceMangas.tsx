/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { MessageDescriptor } from '@lingui/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import IconButton from '@mui/material/IconButton';
import SettingsIcon from '@mui/icons-material/Settings';
import { StringParam, useQueryParam } from 'use-query-params';
import Link from '@mui/material/Link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { styled } from '@mui/material/styles';
import FavoriteIcon from '@mui/icons-material/Favorite';
import NewReleasesIcon from '@mui/icons-material/NewReleases';
import FilterListIcon from '@mui/icons-material/FilterList';
import { useLingui } from '@lingui/react/macro';
import { msg } from '@lingui/core/macro';
import { CustomTooltip } from '@/base/components/CustomTooltip.tsx';
import type { AbortableApolloUseMutationPaginatedResponse } from '@/lib/requests/RequestManager.ts';
import { requestManager, SPECIAL_ED_SOURCES } from '@/lib/requests/RequestManager.ts';
import { SourceGridLayout } from '@/features/source/components/SourceGridLayout.tsx';
import { AppbarSearch } from '@/base/components/AppbarSearch.tsx';
import { SourceOptions } from '@/features/source/browse/components/SourceOptions.tsx';
import { BaseMangaGrid } from '@/features/manga/components/BaseMangaGrid.tsx';
import type {
    GetSourceBrowseQuery,
    GetSourceBrowseQueryVariables,
    GetSourceMangasFetchMutation,
    GetSourceMangasFetchMutationVariables,
} from '@/lib/graphql/generated/graphql.ts';
import {
    updateMetadataServerSettings,
    useMetadataServerSettings,
} from '@/features/settings/services/ServerSettingsMetadata.ts';
import { useLocalStorage, useSessionStorage } from '@/base/hooks/useStorage.tsx';
import { MANGA_GRID_SNAPSHOT_KEY } from '@/features/manga/components/MangaGrid.tsx';
import { createUpdateSourceMetadata, useGetSourceMetadata } from '@/features/source/services/SourceMetadata.ts';
import { makeToast } from '@/base/utils/Toast.ts';
import { GET_SOURCE_BROWSE } from '@/lib/graphql/source/SourceQuery.ts';
import type { IPos, RouteStateSourceBrowse, SourceIdInfo } from '@/features/source/Source.types.ts';
import { SourceContentType } from '@/features/source/Source.types.ts';
import { defaultPromiseErrorHandler } from '@/lib/DefaultPromiseErrorHandler.ts';
import { EmptyView } from '@/base/components/feedback/EmptyView.tsx';
import { EmptyViewAbsoluteCentered } from '@/base/components/feedback/EmptyViewAbsoluteCentered.tsx';
import type { MangaIdInfo } from '@/features/manga/Manga.types.ts';
import { GridLayout, SearchParam } from '@/base/Base.types';
import { AppRoutes } from '@/base/AppRoute.constants.ts';
import { getErrorMessage } from '@/lib/HelperFunctions.ts';
import { Sources } from '@/features/source/services/Sources.ts';
import { STABLE_EMPTY_ARRAY, STABLE_EMPTY_OBJECT } from '@/base/Base.constants.ts';
import { useAppTitleAndAction } from '@/features/navigation-bar/hooks/useAppTitleAndAction.ts';
import { VirtuosoUtil } from '@/lib/virtuoso/Virtuoso.util.tsx';
import { IconWebView } from '@/assets/icons/IconWebView.tsx';
import { MigrationManager } from '@/features/migration/MigrationManager.ts';
import { ReactRouter } from '@/lib/react-router/ReactRouter.ts';
import type { FilterChangeInput } from '@/lib/graphql/generated/graphql-base.types.ts';
import { OffsetComponent } from '@/base/OffsetComponent.tsx';
import { useReadableMangas } from '@/features/manga/hooks/useReadableMangas.ts';
import { ChapterAvailabilityNotice } from '@/features/manga/components/ChapterAvailabilityNotice.tsx';

const DEFAULT_SOURCE: SourceIdInfo = { id: '-1' };

const ContentTypeMenu = styled('div')(({ theme }) => ({
    display: 'flex',
    width: '100%',
    padding: theme.spacing(1),
    gap: theme.spacing(1),
    backgroundColor: theme.palette.background.default,
}));

const ContentTypeButton = styled(Button)(() => ({}));

const StyledGridWrapper = styled(Box)(() => ({
    minHeight: '100%',
    position: 'relative',
}));

const SOURCE_CONTENT_TYPE_TO_ERROR_MSG_KEY: { [contentType in SourceContentType]: MessageDescriptor } = {
    [SourceContentType.POPULAR]: msg`No manga found`,
    [SourceContentType.LATEST]: msg`No manga found`,
    [SourceContentType.SEARCH]: msg`No manga matches this filter`,
};

const getUniqueMangas = <Manga extends MangaIdInfo>(mangas: Manga[]): Manga[] => {
    const mangaIdToManga: Record<string, Manga> = {};
    const uniqueMangas: Manga[] = [];

    mangas.forEach((manga) => {
        const isDuplicate = !!mangaIdToManga[manga.id];
        if (!isDuplicate) {
            mangaIdToManga[manga.id] = manga;
            uniqueMangas.push(manga);
        }
    });

    return uniqueMangas;
};

const useSourceManga = (
    sourceId: string,
    contentType: SourceContentType,
    searchTerm: string | null | undefined,
    filters: IPos[],
    initialPages: number,
    hideLibraryEntries: boolean,
    mangaId?: MangaIdInfo['id'],
): [
    AbortableApolloUseMutationPaginatedResponse<GetSourceMangasFetchMutation, GetSourceMangasFetchMutationVariables>[0],
    AbortableApolloUseMutationPaginatedResponse<
        GetSourceMangasFetchMutation,
        GetSourceMangasFetchMutationVariables
    >[1][number] & { filteredOutAllItemsOfFetchedPage: boolean; lastPageMangaIds: number[] },
] => {
    let result: AbortableApolloUseMutationPaginatedResponse<
        GetSourceMangasFetchMutation,
        GetSourceMangasFetchMutationVariables
    >;

    switch (contentType) {
        case SourceContentType.POPULAR:
            result = requestManager.useGetSourcePopularMangas(sourceId, initialPages);
            break;
        case SourceContentType.LATEST:
            result = requestManager.useGetSourceLatestMangas(sourceId, initialPages);
            break;
        case SourceContentType.SEARCH:
            result = requestManager.useSourceSearch(
                sourceId,
                searchTerm ?? '',
                filters.map((filter) => {
                    const { positions, state } = filter;

                    const isPartOfGroup = positions.length > 1;
                    if (isPartOfGroup) {
                        return positions.reduceRight((update, position, index) => {
                            if (index === positions.length - 1) {
                                return {
                                    position: positions.slice(-1)[0],
                                    [filter.type]: state,
                                };
                            }

                            return {
                                position,
                                groupChange: update,
                            };
                        }, {} as FilterChangeInput);
                    }

                    return {
                        position: positions[0],
                        [filter.type]: state,
                    };
                }),
                initialPages,
            );
            break;
        default:
            throw new Error(`Unknown ContentType "${contentType}"`);
    }

    const pages = result[1]!;
    const lastLoadedPageIndex = pages.findLastIndex((page) => !!page.data?.fetchSourceManga);
    const lastLoadedPage = pages[lastLoadedPageIndex];
    const lastPageMangaIds = (lastLoadedPage?.data?.fetchSourceManga?.mangas ?? [])
        .filter((item) => item.id !== mangaId && (!hideLibraryEntries || !item.inLibrary))
        .map((item) => item.id);

    const isPageLoading = pages.slice(-1)[0].isLoading;
    const filteredOutAllItemsOfFetchedPage =
        !isPageLoading && !!lastLoadedPage?.data?.fetchSourceManga?.mangas.length && lastPageMangaIds.length === 0;
    const items = useMemo(() => {
        type FetchItemsResult = NonNullable<GetSourceMangasFetchMutation['fetchSourceManga']>['mangas'];
        let allItems: FetchItemsResult = [];

        pages.forEach((page) => {
            const pageItems = page.data?.fetchSourceManga?.mangas ?? [];
            const nonLibraryPageItems = pageItems.filter(
                (item) => item.id !== mangaId && (!hideLibraryEntries || !item.inLibrary),
            );
            const uniqueItems = getUniqueMangas([...allItems, ...nonLibraryPageItems]);

            allItems = uniqueItems;
        });

        return allItems;
    }, [pages, hideLibraryEntries, mangaId]);

    if (lastLoadedPageIndex === -1) {
        return [result[0], { ...result[1][result[1].length - 1], filteredOutAllItemsOfFetchedPage, lastPageMangaIds }];
    }

    return [
        result[0],
        {
            ...pages[pages.length - 1],
            data: {
                __typename: 'Mutation',
                ...lastLoadedPage!.data,
                fetchSourceManga: {
                    __typename: 'FetchSourceMangaPayload',
                    ...lastLoadedPage!.data!.fetchSourceManga,
                    hasNextPage:
                        pages.length > lastLoadedPageIndex + 1
                            ? false
                            : !!lastLoadedPage!.data!.fetchSourceManga?.hasNextPage,
                    mangas: items,
                },
            },
            filteredOutAllItemsOfFetchedPage,
            lastPageMangaIds,
        },
    ];
};

export function SourceMangas() {
    const { t } = useLingui();

    const { sourceId } = useParams<{ sourceId: string }>();

    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { key: locationKey, state: locationState } = location;
    const {
        contentType: initialContentType = SourceContentType.POPULAR,
        clearCache = false,
        mode = 'source',
        mangaId,
    } = useLocation<RouteStateSourceBrowse>().state ?? STABLE_EMPTY_OBJECT;

    const {
        settings: { hideLibraryEntries },
    } = useMetadataServerSettings();

    const [sourceGridLayout] = useLocalStorage('source-grid-layout', GridLayout.Compact);
    const [query] = useQueryParam(SearchParam.QUERY, StringParam);
    const [currentFiltersToApply, setCurrentFiltersToApply] = useSessionStorage<IPos[] | undefined>(
        `source-mangas-${sourceId}-filters`,
        [],
    );
    const [filtersToApply, setLocationFiltersToApply] = useSessionStorage<IPos[]>(
        `source-mangas-location-${locationKey}-${sourceId}-filters`,
        currentFiltersToApply ?? STABLE_EMPTY_ARRAY,
    );
    const [dialogFiltersToApply, setDialogFiltersToApply] = useState<IPos[]>(filtersToApply);
    const [currentContentType, setCurrentContentType] = useSessionStorage<SourceContentType | undefined>(
        `source-mangas-${sourceId}-content-type`,
        initialContentType,
    );
    const [contentType, setLocationContentType] = useSessionStorage(
        `source-mangas-location-${locationKey}-${sourceId}-content-type`,
        query ? SourceContentType.SEARCH : currentContentType!,
    );

    const { key: persistedGridStateKey, deleteState: deletePersistedGridState } =
        VirtuosoUtil.usePersistState(MANGA_GRID_SNAPSHOT_KEY);
    const scrollToTop = useCallback(() => {
        deletePersistedGridState();
        window.scrollTo(0, 0);
    }, [persistedGridStateKey]);

    const currentQuery = useRef(query);
    const currentAbortRequest = useRef<(reason: any) => void>(() => {});

    const didSearchChange = currentQuery.current !== query;
    if (didSearchChange && contentType === SourceContentType.SEARCH) {
        currentQuery.current = query;
        currentAbortRequest.current(new Error(`SourceMangas(${sourceId}): search string changed`));
        scrollToTop();
    }

    useEffect(
        () => () => {
            setCurrentFiltersToApply(undefined);
            setCurrentContentType(undefined);
        },
        [sourceId],
    );

    const setFiltersToApply = (filters: IPos[]) => {
        setCurrentFiltersToApply(filters);
        setLocationFiltersToApply(filters);
        scrollToTop();
    };

    const setContentType = (newContentType: SourceContentType) => {
        setCurrentContentType(newContentType);
        setLocationContentType(newContentType);
    };

    const gridKey = `${contentType}${JSON.stringify(filtersToApply)}${query}`;

    const [
        loadPage,
        {
            data,
            error,
            isLoading: loading,
            size: lastPageNum,
            abortRequest,
            filteredOutAllItemsOfFetchedPage,
            lastPageMangaIds,
        },
    ] = useSourceManga(sourceId, contentType, query, filtersToApply, 1, hideLibraryEntries, mangaId);
    currentAbortRequest.current = abortRequest;
    const candidates = data?.fetchSourceManga?.mangas ?? STABLE_EMPTY_ARRAY;
    const availabilityKey = `${sourceId}:${gridKey}`;
    const availability = useReadableMangas(candidates, availabilityKey);
    const { mangas } = availability;
    const hasNextPage = !!data?.fetchSourceManga?.hasNextPage;
    const isLoading = loading || availability.checking || (filteredOutAllItemsOfFetchedPage && hasNextPage);
    const onlyEmptyPage =
        lastPageMangaIds.length > 0 && lastPageMangaIds.every((id) => availability.statuses.get(id) === 'empty');
    const skippedPages = useRef({ key: availabilityKey, page: 0, count: 0 });
    const { data: sourceData } = requestManager.useGetSource<GetSourceBrowseQuery, GetSourceBrowseQueryVariables>(
        GET_SOURCE_BROWSE,
        sourceId,
    );
    const source = sourceData?.source;

    const filters = source?.filters ?? STABLE_EMPTY_ARRAY;
    const { savedSearches = {} } = useGetSourceMetadata(source ?? DEFAULT_SOURCE);
    const updateSourceMetadata = createUpdateSourceMetadata<'savedSearches'>(source ?? { id: '-1' }, (e) =>
        makeToast(t`Failed to save changes`, 'error', getErrorMessage(e)),
    );

    const selectSavedSearch = useCallback(
        (savedSearch: string) => {
            const { query: savedSearchQuery, filters: savedSearchFilters } = savedSearches[savedSearch];

            if (savedSearchFilters) {
                setDialogFiltersToApply(savedSearchFilters);
                setFiltersToApply(savedSearchFilters);
            }

            if (savedSearchQuery) {
                searchParams.set(SearchParam.QUERY, savedSearchQuery);
                setSearchParams(searchParams);
            }
        },
        [savedSearches, locationState],
    );

    const handleSavedSearchesUpdate = useCallback(
        (savedSearch: string, updateType: 'create' | 'delete') => {
            if (updateType === 'delete') {
                const savedSearchesCopy = { ...savedSearches };
                delete savedSearchesCopy[savedSearch];
                updateSourceMetadata('savedSearches', savedSearchesCopy);
                return;
            }

            const updatedSavedSearches = {
                ...savedSearches,
                [savedSearch]: { query: query ?? undefined, filters: dialogFiltersToApply },
            };
            updateSourceMetadata('savedSearches', updatedSavedSearches);
        },
        [savedSearches, query, dialogFiltersToApply],
    );

    const message = !isLoading ? t(SOURCE_CONTENT_TYPE_TO_ERROR_MSG_KEY[contentType]) : undefined;
    const isLocalSource = sourceId === Sources.LOCAL_SOURCE_ID;
    const messageExtra = isLocalSource ? (
        <>
            <span>{t`Check out`} </span>
            <Link href="https://github.com/Suwayomi/Suwayomi-Server/wiki/Local-Source" target="_blank" rel="noreferrer">
                {t`Local source guide`}
            </Link>
        </>
    ) : undefined;

    const updateContentType = useCallback(
        (newContentType: SourceContentType, newSearch?: string | null) => {
            setContentType(newContentType);
            scrollToTop();

            if (query && !newSearch) {
                navigate(
                    {
                        pathname: '',
                    },
                    {
                        state: {
                            ...locationState,
                            ...AppRoutes.sources.children.browse.state({ contentType: newContentType }),
                        },
                    },
                );
            }
        },
        [setContentType, query, scrollToTop],
    );

    const setSearchContentType = !!query && contentType !== SourceContentType.SEARCH;
    if (setSearchContentType) {
        updateContentType(SourceContentType.SEARCH, query);
    }

    const loadMore = useCallback(() => {
        if (!hasNextPage || loading || availability.checking) {
            return;
        }

        loadPage(lastPageNum + 1);
    }, [lastPageNum, hasNextPage, contentType, loading, availability.checking]);

    const resetFilters = () => {
        setDialogFiltersToApply([]);
        setFiltersToApply([]);
    };

    useEffect(() => {
        updateMetadataServerSettings('lastUsedSourceId', sourceId).catch(
            defaultPromiseErrorHandler('SourceMangas::setLastUsedSourceId'),
        );
    }, [sourceId]);

    useEffect(() => {
        if (filteredOutAllItemsOfFetchedPage && hasNextPage && !loading) {
            loadPage(lastPageNum + 1);
        }
    }, [filteredOutAllItemsOfFetchedPage, loading]);

    useEffect(() => {
        if (skippedPages.current.key !== availabilityKey) {
            skippedPages.current = { key: availabilityKey, page: 0, count: 0 };
        }
        if (loading || availability.checking || !hasNextPage || !onlyEmptyPage || error) {
            return;
        }
        if (skippedPages.current.page === lastPageNum || skippedPages.current.count >= 10) {
            return;
        }
        skippedPages.current.page = lastPageNum;
        skippedPages.current.count++;
        void loadPage(lastPageNum + 1).catch(defaultPromiseErrorHandler('SourceMangas::skipEmptyPage'));
    }, [availabilityKey, onlyEmptyPage, availability.checking, loading, hasNextPage, lastPageNum, error]);

    useEffect(() => {
        if (!clearCache) {
            return;
        }

        const requiresClear = SPECIAL_ED_SOURCES.REVALIDATION_UNSUPPORTED.includes(sourceId);
        if (!requiresClear) {
            return;
        }

        requestManager.clearBrowseCacheFor(sourceId);
    }, [clearCache]);

    useAppTitleAndAction(
        source?.displayName ?? t`Source`,
        <>
            <AppbarSearch searchHistoryKey="source" />
            <SourceGridLayout />
            <CustomTooltip title={t`Open in WebView`} disabled={!source?.homeUrl}>
                <IconButton
                    disabled={!source?.homeUrl}
                    href={source?.homeUrl ? requestManager.getWebviewUrl(source?.homeUrl) : ''}
                    rel="noreferrer"
                    target="_blank"
                    color="inherit"
                >
                    <IconWebView />
                </IconButton>
            </CustomTooltip>
            {source?.isConfigurable && (
                <CustomTooltip title={t`Settings`}>
                    <IconButton
                        onClick={() => navigate(AppRoutes.sources.children.configure.path(sourceId))}
                        aria-label="display more actions"
                        edge="end"
                        color="inherit"
                    >
                        <SettingsIcon />
                    </IconButton>
                </CustomTooltip>
            )}
        </>,
        [source],
    );

    const EmptyViewComponent = mangas.length ? EmptyView : EmptyViewAbsoluteCentered;

    return (
        <StyledGridWrapper>
            <OffsetComponent>
                <ContentTypeMenu>
                    <ContentTypeButton
                        variant={contentType === SourceContentType.POPULAR ? 'contained' : 'outlined'}
                        startIcon={<FavoriteIcon />}
                        onClick={() => updateContentType(SourceContentType.POPULAR)}
                    >
                        {t`Popular`}
                    </ContentTypeButton>
                    {source?.supportsLatest === undefined || source.supportsLatest ? (
                        <ContentTypeButton
                            disabled={!source?.supportsLatest}
                            variant={contentType === SourceContentType.LATEST ? 'contained' : 'outlined'}
                            startIcon={<NewReleasesIcon />}
                            onClick={() => updateContentType(SourceContentType.LATEST)}
                        >
                            {t`Latest`}
                        </ContentTypeButton>
                    ) : null}
                    <ContentTypeButton
                        variant={contentType === SourceContentType.SEARCH ? 'contained' : 'outlined'}
                        startIcon={<FilterListIcon />}
                        onClick={() => updateContentType(SourceContentType.SEARCH, query)}
                    >
                        {t`Filter`}
                    </ContentTypeButton>
                </ContentTypeMenu>
            </OffsetComponent>
            <ChapterAvailabilityNotice {...availability} />
            {onlyEmptyPage && hasNextPage && !loading && !availability.checking && (
                <Button onClick={loadMore}>Weitere Treffer prüfen</Button>
            )}
            {(isLoading || !error || (!!error && !!mangas.length)) && (
                <BaseMangaGrid
                    // the key needs to include filters and query to force a re-render of the virtuoso grid to prevent https://github.com/petyosi/react-virtuoso/issues/1242
                    key={gridKey}
                    gridWrapperProps={{ sx: { px: 1, pb: 1 } }}
                    mangas={mangas}
                    hasNextPage={hasNextPage}
                    loadMore={loadMore}
                    message={message}
                    messageExtra={messageExtra}
                    isLoading={isLoading}
                    gridLayout={sourceGridLayout}
                    mode={mode}
                    inLibraryIndicator
                    onMigrateSelect={
                        mangaId
                            ? (match) => {
                                  MigrationManager.selectManualMatch(mangaId, {
                                      ...match,
                                      sourceTitle: Sources.getFromCache(match.sourceId)?.displayName,
                                      latestChapterNumber: undefined,
                                  });
                                  ReactRouter.navigate(AppRoutes.migrate.path);
                              }
                            : undefined
                    }
                />
            )}
            {error && (
                <EmptyViewComponent
                    message={t`Unable to load data`}
                    messageExtra={getErrorMessage(error)}
                    retry={() => loadPage(lastPageNum).catch(defaultPromiseErrorHandler('SourceMangas::refetch'))}
                />
            )}
            {contentType === SourceContentType.SEARCH && (
                <SourceOptions
                    savedSearches={savedSearches}
                    selectSavedSearch={selectSavedSearch}
                    updateSavedSearches={handleSavedSearchesUpdate}
                    sourceFilter={filters}
                    updateFilterValue={setDialogFiltersToApply}
                    setTriggerUpdate={() => {
                        setFiltersToApply(dialogFiltersToApply);
                    }}
                    resetFilterValue={resetFilters}
                    update={dialogFiltersToApply}
                />
            )}
        </StyledGridWrapper>
    );
}
