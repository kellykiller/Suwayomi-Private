/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AuthManager } from '@/features/authentication/AuthManager.ts';

export type AiSettingsData = {
    enabled: boolean;
    configured: boolean;
    model: string;
    reasoning: 'low' | 'medium';
    resultCount: number;
    models: string[];
};
export type AiSourceProgress = {
    id: string;
    name: string;
    language: string;
    phase: 'pending' | 'searching' | 'completed' | 'failed' | 'interrupted';
    error: string;
    truncated: boolean;
};
export type AiSearchJob = {
    id: string;
    phase: 'planning' | 'searching' | 'completed' | 'partial' | 'cancelled' | 'failed';
    finished: string | null;
    model: string;
    summary: string;
    criteria: string[];
    notice: string;
    error: string;
    cached: boolean;
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number } | null;
    accounting?: {
        costUsd: number | null;
        costUnknown: boolean;
        balanceBeforeUsd: number;
        balanceAfterUsd: number | null;
        balanceUncertain: boolean;
    };
    checkedQueries: number;
    completedSources: number;
    sources: AiSourceProgress[];
    recommendations: {
        title: string;
        aliases: string[];
        reason: string;
        caveat: string;
        matches: {
            id: number;
            title: string;
            inLibrary: boolean;
            sourceId: string;
            sourceName: string;
            language: string;
            thumbnailUrl: string | null;
            thumbnailUrlLastFetched: string | null;
            chapterCount: number | null;
            chapterEntryCount: number | null;
            detailsPhase: 'loading' | 'ready' | 'failed' | 'interrupted';
        }[];
    }[];
};
export type AiHistoryEntry = {
    id: string;
    started: string;
    finished: string | null;
    phase: string;
    prompt: string;
    language: string;
    model: string;
    actualModel?: string;
    reasoning: string;
    resultCount: number;
    sources: { id: string; name: string; language: string }[];
    usage: AiSearchJob['usage'];
    cached: boolean;
    costUsd: number | null;
    costUnknown: boolean;
    balanceBeforeUsd: number;
    balanceAfterUsd: number | null;
    balanceUncertain: boolean;
    responseId: string | null;
    error: string;
    result: {
        summary: string;
        checkedQueries: number;
        completedSources: number;
        recommendations: AiSearchJob['recommendations'];
    } | null;
};
export type AiHistoryPage = { entries: AiHistoryEntry[]; total: number; offset: number; nextOffset: number | null };
export type AiBillingSnapshot = {
    fetchedAt: string;
    start: number;
    end: number;
    projectId: string;
    days: number;
    totalUsd: number;
    buckets: { start: number; end: number; usd: number }[];
};
export type AiUsageData = {
    balance: {
        anchor: { at: string; amountUsd: number; note: string };
        estimatedUsd: number;
        knownSpendUsd: number;
        unknownCosts: number;
        pendingCosts: number;
    };
    totals: {
        searches: number;
        cached: number;
        paid: number;
        unknown: number;
        pending: number;
        estimatedCostUsd: number;
        averageUsd: number | null;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        reasoningTokens: number;
    };
    rates: Record<string, { input: number; cachedInput: number; output: number }>;
    priceDate: string;
    checkpoints: { at: string; amountUsd: number; note: string }[];
    billing: { configured: boolean; projectId: string; last: AiBillingSnapshot | null };
};

export class AiApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export async function aiApi<T>(path: string, data?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = AuthManager.getAccessToken();
    const response = await fetch(`/private-api/ai/${path}`, {
        method: data ? 'POST' : 'GET',
        credentials: 'include',
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'Content-Type': 'application/json', 'X-Suwayomi-Private': '1' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
        signal,
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
        throw new AiApiError(value?.error || `HTTP ${response.status}`, response.status);
    }
    if (!value) {
        throw new Error('Keine lesbare Antwort vom Server.');
    }
    return value as T;
}
