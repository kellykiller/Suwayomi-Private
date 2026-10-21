/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogTime, formatLogText, timestampBuildLog } from '../server/log-time.mjs';
import { formatLogTime as browserTime } from '../../src/features/logs/logTime.ts';

test('Log dates use the exact German format and Berlin daylight saving in server and browser', () => {
    for (const [input, expected] of [
        ['2026-01-02T23:04:59Z', '03.01.2026 00:04'],
        ['2026-07-02T23:04:59Z', '03.07.2026 01:04'],
        ['2026-10-25T00:30:00Z', '25.10.2026 02:30'],
        ['2026-10-25T01:30:00Z', '25.10.2026 02:30'],
    ]) {
        assert.equal(formatLogTime(input), expected);
        assert.equal(browserTime(input), expected);
    }
});

test('Every physical build line receives its capture time, including multiline Docker output', () => {
    assert.equal(
        timestampBuildLog('Step 17\r\nBuilding frontend\n', new Date('2026-01-02T23:04:59Z')),
        '03.01.2026 00:04 Step 17\n03.01.2026 00:04 Building frontend\n',
    );
});

test('Legacy and Docker ISO log prefixes are formatted without inventing times or rewriting message contents', () => {
    const text =
        '2026-07-02T23:04:59.123456789Z [INFO] Ready\n  [2026-01-02T23:04:59+00:00] Failed\nOld build without time\nMessage: 2026-01-02T23:04:59Z';
    const expected =
        '03.07.2026 01:04 [INFO] Ready\n  [03.01.2026 00:04] Failed\nOld build without time\nMessage: 2026-01-02T23:04:59Z';
    assert.equal(formatLogText(text), expected);
    assert.equal(formatLogText(expected), expected);
});
