/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AuthManager } from '@/features/authentication/AuthManager.ts';
export type TaskSummary = {
    kind: 'translation' | 'ai' | 'update' | 'downloads' | 'library';
    id: string;
    title: string;
    phase: string;
    active: boolean;
    cancellable: boolean;
    pausable?: boolean;
    pauseRequested?: boolean;
    href: string;
    detail: string;
    progress?: { completed: number; total: number; blockCount?: number };
};
export type TaskList = { tasks: TaskSummary[]; warnings: string[] };
export async function tasksApi<T>(path = '', data?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = AuthManager.getAccessToken();
    const response = await fetch(`/private-api/tasks${path}`, {
        method: data ? 'POST' : 'GET',
        credentials: 'include',
        signal,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'Content-Type': 'application/json', 'X-Suwayomi-Private': '1' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
    });
    const value = await response.json();
    if (!response.ok) {
        throw new Error(value.error || `HTTP ${response.status}`);
    }
    return value;
}
