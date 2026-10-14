/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiLedger, estimateCost, createBillingClient } from '../server/ai-ledger.mjs';

const job = (id) => ({
    id,
    started: new Date().toISOString(),
    sources: [{ id: '1', name: 'MangaDex', language: 'en' }],
});
const config = { model: 'gpt-5.4-mini', reasoning: 'low', resultCount: 6 };
const details = {
    model: 'gpt-5.4-mini-2026-03-17',
    tier: 'default',
    responseId: 'resp_fixture',
    usage: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500, reasoningTokens: 200 },
};
const done = (id, phase = 'completed') => ({
    id,
    phase,
    finished: new Date().toISOString(),
    error: '',
    summary: 'Recommendation',
    criteria: [],
    notice: '',
    checkedQueries: 1,
    completedSources: 1,
    sources: [],
    recommendations: [],
});
async function directory(t) {
    const root = await fs.mkdtemp(join(tmpdir(), 'ai-ledger-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
test('Price estimates charge cached input at the discounted rate and count reasoning only once', () => {
    const result = estimateCost(details.model, details.usage);
    assert.equal(result.usd, 0.00273);
    assert.equal(result.nanos, 2730000);
    assert.equal(estimateCost('gpt-5.4', details.usage).usd, 0.0091);
    assert.equal(estimateCost('unpriced-model', details.usage), null);
    assert.equal(estimateCost(details.model, details.usage, 'priority'), null);
    assert.equal(estimateCost(details.model, { ...details.usage, cachedInputTokens: 1001 }), null);
});
test('Search ledger persists prompts, price snapshots, exact before/after balance, and zero-cost local cache hits', async (t) => {
    const root = await directory(t);
    let ledger = createAiLedger({ stateRoot: root });
    const prompt = 'Romance mit echter Entwicklung\nund ohne Missverständnisse';
    await ledger.begin(job('one'), prompt, 'de', config);
    await ledger.apiStarted('one');
    await assert.rejects(ledger.setBalance({ amountUsd: 10, note: 'Während der Suche' }), /laufende Suche/);
    const entry = await ledger.providerUsage('one', details);
    assert.equal(entry.balanceBeforeUsd, 2.31);
    assert.equal(entry.balanceAfterUsd, 2.30727);
    await ledger.finish(done('one'));
    await ledger.begin(job('two'), prompt, 'de', config);
    await ledger.cacheHit('two');
    await ledger.finish(done('two'));
    assert.equal((await ledger.summary()).totals.estimatedCostUsd, 0.00273);
    ledger.close();
    ledger = createAiLedger({ stateRoot: root });
    const history = await ledger.history();
    assert.equal(history.entries[1].prompt, prompt);
    assert.equal(history.entries[1].pricing.output, 4.5);
    assert.equal(history.entries[0].cached, true);
    assert.equal(history.entries[0].costUsd, 0);
    assert.equal(history.entries[0].balanceBeforeUsd, history.entries[0].balanceAfterUsd);
    assert.equal((await fs.stat(root + '/ai-usage.sqlite')).mode & 0o777, 0o600);
    await ledger.setBalance({ amountUsd: 5.0, note: 'Aktueller Stand nach Aufladung' });
    assert.equal((await ledger.summary()).balance.estimatedUsd, 5);
    await ledger.begin(job('three'), 'Weiterer Wunsch', 'de', config);
    await ledger.apiStarted('three');
    await ledger.providerUsage('three', details);
    await ledger.finish(done('three'));
    assert.equal((await ledger.summary()).balance.estimatedUsd, 4.99727);
    assert.equal((await ledger.history()).entries.length, 3);
    assert.equal((await ledger.summary()).checkpoints.length, 2);
    assert.equal((await ledger.history(1, 1)).nextOffset, 2);
    await assert.rejects(ledger.setBalance({ amountUsd: 1.234, note: 'bad' }), /Nachkommastellen/);
    ledger.close();
});
test('Crash recovery preserves known costs and marks an in-flight request as unknown rather than free', async (t) => {
    const root = await directory(t);
    let ledger = createAiLedger({ stateRoot: root });
    await ledger.begin(job('pending'), 'Vor Absturz', 'de', config);
    await ledger.apiStarted('pending');
    ledger.close();
    ledger = createAiLedger({ stateRoot: root });
    const history = await ledger.history();
    assert.equal(history.entries[0].phase, 'interrupted');
    assert.equal(history.entries[0].costUsd, null);
    assert.equal(history.entries[0].balanceAfterUsd, null);
    assert.equal((await ledger.summary()).balance.unknownCosts, 1);
    assert.equal((await ledger.summary()).totals.averageUsd, null);
    await ledger.begin(job('next'), 'Danach', 'de', config);
    assert.equal((await ledger.history()).entries[0].balanceUncertain, true);
    await ledger.finish(done('next'));
    await ledger.setBalance({ amountUsd: 2.3, note: 'Mit OpenAI abgeglichen' });
    assert.equal((await ledger.summary()).balance.unknownCosts, 0);
    assert.equal((await ledger.summary()).totals.unknown, 1);
    ledger.close();
});
test('A received token usage is retained when a response is incomplete or source scanning fails', async (t) => {
    const root = await directory(t);
    const ledger = createAiLedger({ stateRoot: root });
    await ledger.begin(job('failed'), 'Fehlgeschlagene Suche', 'de', config);
    await ledger.apiStarted('failed');
    await ledger.providerUsage('failed', details);
    await ledger.finish(done('failed', 'failed'));
    assert.equal((await ledger.history()).entries[0].costUsd, 0.00273);
    assert.equal((await ledger.summary()).balance.estimatedUsd, 2.30727);
    await ledger.begin(job('auth'), 'Abgewiesener Key', 'de', config);
    await ledger.apiStarted('auth');
    await ledger.rejected('auth', 401);
    await ledger.finish(done('auth', 'failed'));
    assert.equal((await ledger.history()).entries[0].costUsd, 0);
    ledger.close();
});
test('Official cost retrieval uses only the separate admin credential, handles pagination and does not expose keys', async (t) => {
    const root = await directory(t);
    const admin = 'sk-admin-' + 'fixture'.repeat(8);
    const calls = [];
    let page = 0;
    const client = createBillingClient({
        stateRoot: root,
        secretRoot: root,
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            page++;
            return new Response(
                JSON.stringify({
                    data: [
                        {
                            start_time: 100,
                            end_time: 200,
                            results: [
                                {
                                    object: 'organization.costs.result',
                                    amount: { currency: 'usd', value: page % 2 ? '0.01' : '0.02' },
                                },
                            ],
                        },
                    ],
                    has_more: page % 2 === 1,
                    next_page: page % 2 ? 'cursor' : null,
                }),
            );
        },
    });
    await client.save({ key: admin, projectId: 'proj_fixture' });
    const result = await client.sync(30);
    assert(Math.abs(result.totalUsd - 0.03) < 1e-10);
    assert.equal(result.buckets.length, 2);
    assert(
        calls.every(
            (call) =>
                call.url.startsWith('https://api.openai.com/v1/organization/costs?') &&
                call.options.headers.Authorization === `Bearer ${admin}` &&
                call.options.redirect === 'error',
        ),
    );
    assert.equal(new URL(calls[0].url).searchParams.get('project_ids[]'), 'proj_fixture');
    assert.equal(new URL(calls[1].url).searchParams.get('page'), 'cursor');
    assert(!JSON.stringify(await client.status()).includes(admin));
    assert.equal((await fs.stat(root + '/openai-admin.token')).mode & 0o777, 0o600);
    await client.save({ removeKey: true });
    assert.equal((await client.status()).configured, false);
    await assert.rejects(client.sync(), /separaten/);
});
test('A rejected admin key or redirect cannot overwrite the saved billing connection or leak response bodies', async (t) => {
    const root = await directory(t);
    const admin = 'sk-admin-' + 'fixture'.repeat(8);
    const client = createBillingClient({
        stateRoot: root,
        secretRoot: root,
        fetchImpl: async () => new Response(admin, { status: 403 }),
    });
    await assert.rejects(
        client.save({ key: admin }),
        (error) => /Leserechten/.test(error.message) && !error.message.includes(admin),
    );
    assert.equal((await client.status()).configured, false);
});
