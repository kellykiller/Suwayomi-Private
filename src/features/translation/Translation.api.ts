/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AuthManager } from '@/features/authentication/AuthManager.ts';

export type TranslationBlock = {
    id: string;
    box: number[];
    text: string;
    translated: string;
    confidence: number | null;
    note: string;
    rendered: boolean;
};
export type TranslationJob = {
    id: string;
    chapterId: number;
    mangaId: number;
    sourceOrder: number;
    title: string;
    chapterName: string;
    sourceLanguage: 'ja' | 'en';
    phase: string;
    error: string;
    started: string;
    updated: string;
    pageCount: number;
    blockCount: number;
    completedPages: number;
    currentPage?: number;
    model: string;
    reasoning: 'low' | 'medium';
    budgetUsd: number;
    costUsd: number;
    unknownCalls: number;
    revision?: number;
    engine?: string;
    warnings?: string[];
    progress?: { completed: number; total: number };
    calls: {
        id: string;
        stage: string;
        costUsd: number | null;
        costUnknown: boolean;
        balanceBeforeUsd?: number;
        balanceAfterUsd?: number | null;
        usage?: { inputTokens: number; outputTokens: number };
    }[];
    pages?: {
        index: number;
        width: number;
        height: number;
        blocks: TranslationBlock[];
        warnings: string[];
        translationComplete?: boolean;
    }[];
};
export type TranslationChapter = {
    id: number;
    mangaId: number;
    sourceOrder: number;
    name: string;
    isDownloaded: boolean;
    pageCount: number;
    manga: { id: number; title: string; source: { lang: string } };
};
export type TranslationAvailable = { id: string; revision: number; pages: string[] } | null;
export async function translationApi<T>(
    path: string,
    data?: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<T> {
    const token = AuthManager.getAccessToken();
    const response = await fetch(`/private-api/translations/${path}`, {
        method: data ? 'POST' : 'GET',
        credentials: 'include',
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'Content-Type': 'application/json', 'X-Suwayomi-Private': '1' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
        throw new Error(result?.error || `Übersetzungsdienst: HTTP ${response.status}`);
    }
    return result as T;
}
export const translationPath = (chapterId: number) => `/settings/translations?chapter=${chapterId}`;
export const translationImage = (id: string, kind: 'original' | 'translated' | 'preview', page: number, revision = 0) =>
    `/private-api/translations/files/${id}/${kind}/${page}?v=${revision}`;
