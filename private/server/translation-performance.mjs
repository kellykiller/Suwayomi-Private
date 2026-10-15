/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { assert, writeJson } from './common.mjs';

export const OCR_PROFILES = { economical: 2, balanced: 4, fast: 8 };
export async function readOcrPerformance(stateRoot = '/update') {
    let value;
    try {
        value = JSON.parse(await fs.readFile(stateRoot + '/translation-performance.json', 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const profile = value?.profile || 'balanced';
    assert(Object.hasOwn(OCR_PROFILES, profile), 'Ungültiges OCR-Leistungsprofil.');
    return { profile, maxCpus: OCR_PROFILES[profile], memoryGiB: 3 };
}
export async function saveOcrPerformance(input, stateRoot = '/update') {
    assert(
        input && Object.keys(input).length === 1 && Object.hasOwn(OCR_PROFILES, input.profile),
        'Ungültiges OCR-Leistungsprofil.',
    );
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await writeJson(stateRoot + '/translation-performance.json', { profile: input.profile });
    return readOcrPerformance(stateRoot);
}
