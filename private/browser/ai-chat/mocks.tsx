/* SPDX-License-Identifier: MPL-2.0 */
// Only unrelated application providers are stubbed; the actual chat, result cards,
// API helper, HTTP gateway, persistence and AI search service run unchanged.
import { useState } from 'react';
const sources = [{ id: '1', displayName: 'Testquelle', lang: 'en' }];
const data = { sources: { nodes: sources } };
export const requestManager = { useGetSourceList: () => ({ data, loading: false, error: undefined }) };
export const Sources = {
    useLanguages: () => {
        const [languages, setLanguages] = useState(['en']);
        return { languages, setLanguages };
    },
    filter: (values: unknown[]) => values,
    getLanguages: () => ['en'],
};
export const useMetadataServerSettings = () => ({ settings: { showNsfw: false } });
export const useAppTitleAndAction = () => {};
export const useAppTitle = () => {};
export const SourceLanguageSelect = () => null;
export const AppRoutes = {
    settings: { children: { ai: { path: '/settings/ai' }, aiUsage: { path: '/settings/ai-usage' } } },
    sources: {
        children: {
            aiSearch: { path: '/sources/ai-search' },
            searchAll: { path: (title: string) => '/sources/search?query=' + encodeURIComponent(title) },
        },
    },
    manga: { path: (id: number) => '/manga/' + id },
};
export const Mangas = { getThumbnailUrl: (match: { thumbnailUrl?: string }) => match.thumbnailUrl || '' };
export const SpinnerImage = ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src || undefined} />;
