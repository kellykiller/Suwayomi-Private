/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AuthManager } from '@/features/authentication/AuthManager.ts';

export type CloudSelection = { chapterIds?: number[]; mangaIds?: number[] };
export type CloudStatus = {
    ready: boolean;
    linked: boolean;
    model: string;
    credentials: { google: boolean; openai: boolean };
};
export type CloudPlan = {
    title: string;
    chapterCount: number;
    newChapters: number;
    alreadyTranslated: number;
    missingDownloads: number;
    knownPages: number;
    model: string;
    maxOpenAI: number;
};
export type CloudChapter = {
    id: string;
    chapterId: number;
    mangaId: number;
    sourceOrder: number;
    title: string;
    chapterName: string;
    pageCount: number;
    status: string;
    remoteStatus?: string;
    outputReady: boolean;
    summary?: { open_regions: number };
    progress?: { status?: string; input_pages?: number; completed_pages?: number };
};
export type CloudBatch = {
    id: string;
    title: string;
    phase: string;
    message: string;
    model: string;
    maxOpenAI: number;
    created: string;
    updated: string;
    currentChapter?: number;
    chapters: CloudChapter[];
};

export async function cloudApi<T>(path: string, data?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = AuthManager.getAccessToken();
    const response = await fetch(`/private-api/cloud-translations/${path}`, {
        method: data ? 'POST' : 'GET',
        credentials: 'include',
        signal,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'Content-Type': 'application/json', 'X-Suwayomi-Private': '1' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
        throw new Error(result?.error || `Übersetzungsdienst: HTTP ${response.status}`);
    }
    return result as T;
}
