/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAiService, recommend, titleMatches, validatePlan, chapterMetrics, AI_DEFAULTS } from '../server/ai.mjs';
import { createGateway } from '../server/gateway.mjs';

const key = 'sk-proj-' + 'fixtureOnly'.repeat(5);
const request = { headers: { authorization: 'Basic Zml4dHVyZTpwYXNzd29yZA==' } };
const plan = {
    summary: 'Kämpfe und eine zusammenhängende Abenteuerhandlung.',
    criteria: ['Viele Kämpfe', 'Abenteuer'],
    notice: '',
    recommendations: [
        {
            title: 'Naruto',
            aliases: ['ナルト'],
            reason: 'Viele Kämpfe und eine feste Hauptgruppe.',
            caveat: 'Einige längere Rückblicke.',
        },
    ],
};
const json = (value, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const modelResult = (value = plan) =>
    json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        usage: { input_tokens: 100, output_tokens: 80 },
    });
async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(join(tmpdir(), 'suwayomi-ai-'));
    const secrets = root + '/secrets';
    await fs.mkdir(secrets);
    let modelCalls = 0;
    const calls = [];
    const fetchImpl = async (url, input) => {
        calls.push({ url: String(url), input });
        if (String(url) === 'https://api.openai.com/v1/responses') {
            modelCalls++;
            return options.model ? options.model(input) : modelResult();
        }
        if (String(url).startsWith('https://api.openai.com/v1/models/')) return json({ id: 'gpt-5.4-mini' });
        const body = JSON.parse(input.body);
        if (body.query.includes('AiMatchDetails'))
            return options.details
                ? options.details(body.variables.id, input)
                : json({
                      data: {
                          fetchMangaAndChapters: {
                              manga: {
                                  id: body.variables.id,
                                  thumbnailUrl: `/api/v1/manga/${body.variables.id}/thumbnail`,
                              },
                              chapters: [
                                  { id: 1, chapterNumber: 1 },
                                  { id: 2, chapterNumber: 2 },
                              ],
                          },
                      },
                  });
        if (body.query.includes('query AiSources'))
            return json({
                data: {
                    sources: {
                        nodes: [
                            { id: '1', displayName: 'Source A', lang: 'en' },
                            { id: '2', displayName: 'Source B', lang: 'de' },
                            { id: '3', displayName: 'Source C', lang: 'ja' },
                            { id: '0', displayName: 'Local', lang: 'other' },
                        ],
                    },
                },
            });
        return options.source
            ? options.source(body.variables.input, input)
            : json({
                  data: {
                      fetchSourceManga: { hasNextPage: false, mangas: [{ id: 10, title: 'Naruto', inLibrary: true }] },
                  },
              });
    };
    const service = createAiService({
        upstream: 'http://127.0.0.1:18082',
        stateRoot: root,
        secretRoot: secrets,
        fetchImpl,
        requestDelay: 0,
        cooldown: 0,
        ...options.timing,
    });
    await service.save({ key, enabled: true });
    t.after(async () => {
        await service.stop();
        await fs.rm(root, { recursive: true, force: true });
    });
    return { service, root, secrets, calls, fetchImpl, modelCalls: () => modelCalls };
}
async function finished(service, id, req = request) {
    for (let i = 0; i < 200; i++) {
        const job = service.get(id, req);
        if (job.finished) return job;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Fixture search did not finish');
}
const input = { prompt: 'Wie One Piece, aber mit mehr Kämpfen', language: 'de', sourceIds: ['1', '2', '3'] };

test('Follow-up requests include the actual user messages and prior ordered suggestions, including verified source observations', async (t) => {
    const f = await fixture(t);
    const first = await f.service.start({ ...input, requestId: randomUUID(), resultCount: 7 }, request);
    const done = await finished(f.service, first.id);
    const second = await f.service.start(
        {
            ...input,
            prompt: 'Mehr wie der erste Vorschlag, bitte ohne Rückblicke.',
            conversationId: done.conversationId,
            parentJobId: done.id,
            requestId: randomUUID(),
            resultCount: 3,
        },
        request,
    );
    await finished(f.service, second.id);
    const bodies = f.calls.filter((call) => call.url.endsWith('/responses')).map((call) => JSON.parse(call.input.body));
    assert.equal(bodies.length, 2);
    assert.deepEqual(
        bodies[1].input.map((message) => message.role),
        ['user', 'assistant', 'user'],
    );
    assert.equal(bodies[1].input[0].content, input.prompt);
    const previous = JSON.parse(bodies[1].input[1].content);
    assert.equal(previous.recommendations[0].title, 'Naruto');
    assert.equal(previous.recommendations[0].sourceMatches[0].chapterCount, 2);
    assert.match(bodies[1].input[2].content, /ohne Rückblicke/);
    assert.equal(bodies[1].text.format.schema.properties.recommendations.maxItems, 3);
    assert.equal(bodies[1].store, false);
    const chat = await f.service.conversation(done.conversationId, request);
    assert.equal(chat.turns.length, 2);
    assert.equal(chat.turns[0].resultCount, 7);
    assert.equal(chat.turns[1].resultCount, 3);
    assert(!JSON.stringify(chat).includes('owner'));
    assert(!JSON.stringify(chat).includes(request.headers.authorization));
    const persisted = await fs.readFile(f.root + '/ai-conversations/' + chat.id + '.json', 'utf8');
    assert(!persisted.includes(key) && !persisted.includes(request.headers.authorization));
    assert.equal((await fs.stat(f.root + '/ai-conversations/' + chat.id + '.json')).mode & 0o777, 0o600);
});
test('Conversation ownership and stale-tab checks run before any further model call', async (t) => {
    const f = await fixture(t);
    const a = await finished(f.service, (await f.service.start(input, request)).id);
    const next = {
        ...input,
        prompt: 'Mehr davon',
        conversationId: a.conversationId,
        parentJobId: a.id,
        requestId: randomUUID(),
    };
    const foreign = { headers: { authorization: 'Basic other-user' } };
    assert.equal((await f.service.conversations(foreign)).length, 0);
    await assert.rejects(f.service.conversation(a.conversationId, foreign), (error) => error.status === 404);
    await assert.rejects(f.service.start(next, foreign), (error) => error.status === 404);
    const b = await finished(f.service, (await f.service.start(next, request)).id);
    await assert.rejects(f.service.start({ ...next, requestId: randomUUID() }, request), /inzwischen/);
    assert.equal(f.modelCalls(), 2);
    assert.equal((await f.service.conversation(a.conversationId, request)).turns.at(-1).id, b.id);
});
test('An exact retry after a lost response returns the same turn without billing again, even after a service restart', async (t) => {
    const f = await fixture(t),
        message = { ...input, requestId: randomUUID(), resultCount: 9 };
    const first = await finished(f.service, (await f.service.start(message, request)).id);
    const again = await f.service.start(message, request);
    assert.equal(again.id, first.id);
    assert.equal(f.modelCalls(), 1);
    await assert.rejects(f.service.start({ ...message, prompt: 'different' }, request), /anderen Inhalt/);
    await f.service.stop();
    const restarted = createAiService({
        upstream: 'http://127.0.0.1:18082',
        stateRoot: f.root,
        secretRoot: f.secrets,
        fetchImpl: f.fetchImpl,
        requestDelay: 0,
        cooldown: 0,
    });
    t.after(() => restarted.stop());
    assert.equal((await restarted.readJob(first.id, request)).id, first.id);
    assert.equal((await restarted.start(message, request)).id, first.id);
    assert.equal(f.modelCalls(), 1);
    const next = await restarted.start(
        {
            ...message,
            prompt: 'Mehr wie Naruto',
            conversationId: first.conversationId,
            parentJobId: first.id,
            requestId: randomUUID(),
        },
        request,
    );
    await finished(restarted, next.id);
    assert.equal((await restarted.conversation(first.conversationId, request)).turns.length, 2);
    assert.equal(f.modelCalls(), 2);
});
test('A reopened interrupted turn preserves known cost and never automatically restarts an API request', async (t) => {
    const f = await fixture(t);
    const done = await finished(f.service, (await f.service.start(input, request)).id);
    await f.service.stop();
    const path = f.root + '/ai-conversations/' + done.conversationId + '.json';
    const record = JSON.parse(await fs.readFile(path, 'utf8'));
    record.turns[0].finished = null;
    record.turns[0].phase = 'searching';
    await fs.writeFile(path, JSON.stringify(record));
    const restarted = createAiService({
        upstream: 'http://127.0.0.1:18082',
        stateRoot: f.root,
        secretRoot: f.secrets,
        fetchImpl: f.fetchImpl,
        requestDelay: 0,
        cooldown: 0,
    });
    t.after(() => restarted.stop());
    const chat = await restarted.conversation(done.conversationId, request);
    assert.equal(chat.turns[0].phase, 'interrupted');
    assert.equal(chat.turns[0].accounting.costUsd, done.accounting.costUsd);
    assert(chat.turns[0].finished);
    assert.equal(restarted.active(request), null);
    assert.equal(f.modelCalls(), 1);
});
test('The same follow-up text in different conversations does not reuse a cached answer with the wrong context', async (t) => {
    const f = await fixture(t);
    const a = await finished(f.service, (await f.service.start({ ...input, prompt: 'Kämpfe' }, request)).id);
    const b = await finished(f.service, (await f.service.start({ ...input, prompt: 'Romantik' }, request)).id);
    for (const parent of [a, b])
        await finished(
            f.service,
            (
                await f.service.start(
                    {
                        ...input,
                        prompt: 'Mehr davon',
                        conversationId: parent.conversationId,
                        parentJobId: parent.id,
                        requestId: randomUUID(),
                    },
                    request,
                )
            ).id,
        );
    assert.equal(f.modelCalls(), 4);
});
test('Questions about previous suggestions can return an ordinary answer without another source scan', async (t) => {
    let calls = 0;
    const f = await fixture(t, {
        model: async () =>
            ++calls === 1
                ? modelResult()
                : modelResult({
                      summary: 'Die Hauptgruppe und die Kämpfe passen zu deinem Wunsch.',
                      criteria: [],
                      notice: '',
                      recommendations: [],
                  }),
    });
    const a = await finished(f.service, (await f.service.start(input, request)).id);
    const b = await finished(
        f.service,
        (
            await f.service.start(
                {
                    ...input,
                    prompt: 'Warum passt der erste Vorschlag?',
                    conversationId: a.conversationId,
                    parentJobId: a.id,
                },
                request,
            )
        ).id,
    );
    assert.equal(b.recommendations.length, 0);
    assert.equal(b.checkedQueries, 0);
    assert.match(b.summary, /Hauptgruppe/);
    assert.equal((await f.service.history()).entries[0].conversationId, a.conversationId);
    assert(!JSON.stringify(await f.service.history()).includes('ownerHash'));
});
test('Any whole result count from 1 to 100 works globally or per turn; invalid counts never start a provider request', async (t) => {
    const f = await fixture(t);
    await f.service.save({ resultCount: 17 });
    assert.equal((await f.service.status()).resultCount, 17);
    assert.equal((await f.service.status()).maxResultCount, 100);
    for (const value of [0, -1, 101, 1.5, '8', NaN]) {
        await assert.rejects(f.service.save({ resultCount: value }));
        await assert.rejects(f.service.start({ ...input, resultCount: value }, request));
    }
    assert.equal(f.modelCalls(), 0);
    const job = await finished(f.service, (await f.service.start({ ...input, resultCount: 1 }, request)).id);
    assert.equal(job.resultCount, 1);
    assert.equal((await f.service.status()).resultCount, 17);
    const many = Array.from({ length: 100 }, (_, index) => ({
        title: 'Title ' + index,
        aliases: [],
        reason: 'Reason',
        caveat: '',
    }));
    assert.equal(validatePlan({ ...plan, recommendations: many }, 37).recommendations.length, 37);
    let seen;
    await recommend({
        key,
        settings: { ...AI_DEFAULTS, resultCount: 100 },
        prompt: 'test',
        language: 'de',
        fetchImpl: async (_url, input) => {
            seen = JSON.parse(input.body);
            return modelResult({ ...plan, recommendations: many });
        },
    });
    assert.equal(seen.text.format.schema.properties.recommendations.maxItems, 100);
    assert(seen.max_output_tokens > 4500 && seen.max_output_tokens <= 48000);
});
test('A previously recorded search can be imported as a conversation without a provider call or duplicate billing', async (t) => {
    const f = await fixture(t);
    const id = randomUUID();
    const legacy = {
        id,
        started: new Date().toISOString(),
        finished: new Date().toISOString(),
        phase: 'completed',
        summary: plan.summary,
        criteria: plan.criteria,
        notice: '',
        recommendations: [{ ...plan.recommendations[0], matches: [] }],
        checkedQueries: 0,
        completedSources: 0,
        sources: [],
    };
    await f.service.ledger.begin(legacy, 'Frühere Suche', 'de', AI_DEFAULTS);
    await f.service.ledger.finish(legacy);
    const chat = await f.service.importConversation(id, request);
    assert.equal(chat.turns[0].prompt, 'Frühere Suche');
    assert.equal(chat.turns[0].recommendations[0].title, 'Naruto');
    assert.equal(f.modelCalls(), 0);
    assert.equal((await f.service.importConversation(id, request)).id, chat.id);
    const next = await f.service.start(
        { ...input, prompt: 'Mehr wie dein Vorschlag', conversationId: chat.id, parentJobId: id },
        request,
    );
    await finished(f.service, next.id);
    assert.equal(f.modelCalls(), 1);
});

test('AI requests use a fixed OpenAI endpoint, bounded structured output and no storage; errors never echo provider bodies', async () => {
    let seen;
    const result = await recommend({
        key,
        settings: AI_DEFAULTS,
        prompt: 'Romance mit Fortschritt',
        language: 'de',
        signal: AbortSignal.timeout(1000),
        fetchImpl: async (url, options) => {
            seen = { url, options };
            return modelResult();
        },
    });
    const body = JSON.parse(seen.options.body);
    assert.equal(seen.url, 'https://api.openai.com/v1/responses');
    assert.equal(seen.options.redirect, 'error');
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.max_output_tokens, 4500);
    assert.equal(body.reasoning.effort, 'low');
    assert(!seen.options.body.includes(key));
    assert.equal(result.plan.recommendations[0].title, 'Naruto');
    await assert.rejects(
        recommend({
            key,
            settings: AI_DEFAULTS,
            prompt: 'test',
            language: 'de',
            fetchImpl: async () => json({ message: key }, 401),
        }),
        (error) => /API-Key/.test(error.message) && !error.message.includes(key),
    );
    await assert.rejects(
        recommend({
            key,
            settings: AI_DEFAULTS,
            prompt: 'test',
            language: 'de',
            fetchImpl: async () => json({ status: 'incomplete', output: [] }),
        }),
        /vollständig/,
    );
    await assert.rejects(
        recommend({
            key,
            settings: AI_DEFAULTS,
            prompt: 'test',
            language: 'de',
            fetchImpl: async () =>
                json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }),
        }),
        /nicht beantworten/,
    );
});
test('Title matching tolerates punctuation and accents but does not merge sequels, spin-offs or related works', () => {
    assert(titleMatches('One-Piece', ['One Piece']));
    assert(titleMatches('Pokémon', ['Pokemon']));
    assert(titleMatches('ナルト', ['Naruto', 'ナルト']));
    assert(!titleMatches('バトル', ['ハトル']));
    assert(!titleMatches('ヴァンパイア', ['ウァンパイア']));
    assert(!titleMatches('Boruto', ['Naruto']));
    assert(!titleMatches('Naruto: Sasuke Story', ['Naruto']));
    assert(!titleMatches('One Piece Novel', ['One Piece']));
    assert.throws(() =>
        validatePlan({ ...plan, recommendations: [{ ...plan.recommendations[0], aliases: Array(5).fill('fake') }] }, 6),
    );
    const deduped = validatePlan(
        { ...plan, recommendations: [plan.recommendations[0], { ...plan.recommendations[0], title: 'NARUTO' }] },
        6,
    );
    assert.equal(deduped.recommendations.length, 1);
});
test(
    'Cross-source search uses real manga IDs, aliases and second result pages while a failing source does not block others',
    { timeout: 4000 },
    async (t) => {
        const f = await fixture(t, {
            source: async ({ source, query, page }) => {
                if (source === '2') return json({ errors: [{ message: 'never expose backend credentials' }] });
                if (source === '1' && page === 1)
                    return json({
                        data: {
                            fetchSourceManga: {
                                hasNextPage: true,
                                mangas: [{ id: 999, title: 'Boruto', inLibrary: false }],
                            },
                        },
                    });
                if (source === '1')
                    return json({
                        data: {
                            fetchSourceManga: {
                                hasNextPage: false,
                                mangas: [{ id: 10, title: 'Naruto', inLibrary: true }],
                            },
                        },
                    });
                return json({
                    data: {
                        fetchSourceManga: {
                            hasNextPage: false,
                            mangas: query === 'ナルト' ? [{ id: 30, title: 'ナルト', inLibrary: false }] : [],
                        },
                    },
                });
            },
        });
        const job = await f.service.start(input, request);
        const result = await finished(f.service, job.id);
        assert.equal(result.phase, 'completed');
        assert.equal(result.completedSources, 2);
        assert.deepEqual(result.recommendations[0].matches.map((match) => match.id).sort(), [10, 30]);
        assert.equal(result.sources.find((source) => source.id === '2').phase, 'failed');
        assert(!JSON.stringify(result).includes('never expose'));
        assert(!JSON.stringify(result).includes(key));
        assert(!JSON.stringify(result).includes(request.headers.authorization));
        const backendCalls = f.calls.filter((call) => call.url.endsWith('/api/graphql'));
        assert(backendCalls.every((call) => call.input.headers.Authorization === request.headers.authorization));
        assert(
            f.calls
                .filter((call) => call.url.includes('api.openai.com'))
                .every((call) => call.input.headers.Authorization === `Bearer ${key}`),
        );
        assert.equal(f.modelCalls(), 1);
    },
);
test(
    'Repeated requests reuse the protected AI plan but re-check source availability; credentials remain masked and removable',
    { timeout: 4000 },
    async (t) => {
        let available = true;
        const f = await fixture(t, {
            source: async () =>
                json({
                    data: {
                        fetchSourceManga: {
                            hasNextPage: false,
                            mangas: available ? [{ id: 10, title: 'Naruto', inLibrary: false }] : [],
                        },
                    },
                }),
        });
        const first = await f.service.start({ ...input, sourceIds: ['1'] }, request);
        const a = await finished(f.service, first.id);
        assert.equal(a.recommendations[0].matches.length, 1);
        available = false;
        const second = await f.service.start({ ...input, sourceIds: ['1'] }, request);
        const b = await finished(f.service, second.id);
        assert.equal(b.cached, true);
        assert.equal(b.recommendations[0].matches.length, 0);
        assert.equal(f.modelCalls(), 1);
        assert.deepEqual(b.usage, { inputTokens: 0, outputTokens: 0 });
        const status = await f.service.status();
        assert.equal(status.configured, true);
        assert(!JSON.stringify(status).includes(key));
        for (const path of [
            f.secrets + '/openai.token',
            f.root + '/ai-settings.json',
            f.root + '/ai-cache/' + (await fs.readdir(f.root + '/ai-cache'))[0],
        ])
            assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(f.root + '/ai-cache')).mode & 0o777, 0o700);
        await f.service.testConnection();
        assert.equal(f.modelCalls(), 1);
        await f.service.save({ key: '', resultCount: 4 });
        assert.equal(await fs.readFile(f.secrets + '/openai.token', 'utf8'), key + '\n');
        await f.service.save({ removeKey: true });
        assert.equal((await f.service.status()).configured, false);
        assert.equal((await f.service.status()).enabled, false);
        await assert.rejects(f.service.start(input, request), /aktivieren/);
    },
);
test('Invalid sources and excessive input are rejected before any paid model call', async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.service.start({ ...input, sourceIds: ['999'] }, request), /nicht mehr installiert/);
    await assert.rejects(f.service.start({ ...input, prompt: 'x'.repeat(2001) }, request), /ungültig/);
    await assert.rejects(f.service.start({ ...input, sourceIds: Array(101).fill('1') }, request), /100/);
    await assert.rejects(f.service.save({ model: 'http://evil.example' }), /Ungültige KI/);
    assert.equal(f.modelCalls(), 0);
});
test('Chapter counts and covers are refreshed independently for each real source match', async (t) => {
    const f = await fixture(t, {
        source: async ({ source }) =>
            json({
                data: {
                    fetchSourceManga: {
                        hasNextPage: false,
                        mangas: [{ id: Number(source) * 10, title: 'Naruto', inLibrary: false }],
                    },
                },
            }),
        details: async (id) =>
            json({
                data: {
                    fetchMangaAndChapters: {
                        manga: { id, thumbnailUrl: `/api/v1/manga/${id}/thumbnail` },
                        chapters: Array.from({ length: id === 10 ? 10 : 8 }, (_, index) => ({
                            id: index + 1,
                            chapterNumber: index + 1,
                        })),
                    },
                },
            }),
    });
    const job = await f.service.start({ ...input, sourceIds: ['1', '2'] }, request);
    const result = await finished(f.service, job.id);
    const matches = result.recommendations[0].matches.sort((a, b) => a.id - b.id);
    assert.deepEqual(
        matches.map((match) => match.chapterCount),
        [10, 8],
    );
    assert(matches.every((match) => match.detailsPhase === 'ready' && match.thumbnailUrl));
    assert.deepEqual(
        chapterMetrics([
            { id: 1, chapterNumber: 1 },
            { id: 2, chapterNumber: 1 },
            { id: 3, chapterNumber: 1.5 },
            { id: 4, chapterNumber: -1 },
        ]),
        { chapterCount: 3, chapterEntryCount: 4 },
    );
    const usage = await f.service.usage();
    assert.equal(usage.totals.searches, 1);
    assert.equal((await f.service.history()).entries[0].prompt, input.prompt);
    assert.equal(usage.balance.estimatedUsd, 2.309565);
});
test('An incomplete model answer is still charged in the history; failed chapter details stay unknown', async (t) => {
    const f = await fixture(t, {
        model: async () =>
            json({
                status: 'incomplete',
                model: 'gpt-5.4-mini',
                usage: { input_tokens: 100, output_tokens: 80 },
                output: [],
            }),
    });
    const job = await f.service.start(input, request);
    const result = await finished(f.service, job.id);
    assert.equal(result.phase, 'failed');
    assert.equal((await f.service.history()).entries[0].costUsd, 0.000435);
    const other = await fixture(t, { details: async () => json({ errors: [{ message: 'unavailable' }] }) });
    const next = await other.service.start(input, request);
    const completed = await finished(other.service, next.id);
    assert(
        completed.recommendations[0].matches.every(
            (match) => match.chapterCount === null && match.detailsPhase === 'failed',
        ),
    );
});
function untilAbort(signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}
test('A request without reliable manga recommendations does not claim to have checked source listings', async (t) => {
    const f = await fixture(t, {
        model: async () =>
            modelResult({
                ...plan,
                recommendations: [],
                notice: 'Keine verlässlichen Manga-Vorschläge für diese Anfrage.',
            }),
    });
    const job = await f.service.start(input, request);
    const result = await finished(f.service, job.id);
    assert.equal(result.phase, 'completed');
    assert.equal(result.checkedQueries, 0);
    assert.equal(result.completedSources, 0);
    assert(result.sources.every((source) => source.phase === 'interrupted'));
    assert(result.notice);
});
test(
    'Simultaneous starts cannot double-charge; job results belong to their authenticated caller and cancellation releases the search',
    { timeout: 4000 },
    async (t) => {
        const f = await fixture(t, { model: async ({ signal }) => untilAbort(signal) });
        const attempts = await Promise.allSettled([f.service.start(input, request), f.service.start(input, request)]);
        assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
        const job = attempts.find((item) => item.status === 'fulfilled').value;
        assert.equal(f.service.active(request).id, job.id);
        assert.equal(f.service.active({ headers: { authorization: 'Basic other' } }), null);
        assert.throws(
            () => f.service.get(job.id, { headers: { authorization: 'Basic other' } }),
            (error) => error.status === 404,
        );
        await assert.rejects(f.service.save({ resultCount: 4 }), /laufende/);
        f.service.cancel(job.id, request);
        const result = await finished(f.service, job.id);
        assert.equal(result.phase, 'cancelled');
        assert.equal(f.service.active(request), null);
        await f.service.save({ enabled: false });
    },
);
test(
    'Source time limits preserve existing verified matches and mark unfinished sources',
    { timeout: 4000 },
    async (t) => {
        // Trigger the search deadline only after the first verified match exists.
        // A real 90 ms wall clock can expire during ledger fsync on a loaded CI runner.
        const deadline = new AbortController();
        const nativeTimeout = AbortSignal.timeout;
        t.mock.method(AbortSignal, 'timeout', (ms) => (ms === 9876 ? deadline.signal : nativeTimeout(ms)));
        const f = await fixture(t, {
            timing: { searchTimeout: 9876, requestTimeout: 1000 },
            source: async ({ source }, { signal }) =>
                source === '1'
                    ? json({
                          data: {
                              fetchSourceManga: {
                                  hasNextPage: false,
                                  mangas: [{ id: 10, title: 'Naruto', inLibrary: false }],
                              },
                          },
                      })
                    : untilAbort(signal),
        });
        const job = await f.service.start(input, request);
        for (
            let attempt = 0;
            attempt < 200 && !f.service.get(job.id, request).recommendations[0]?.matches.length;
            attempt++
        )
            await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(f.service.get(job.id, request).recommendations[0]?.matches[0]?.id, 10);
        deadline.abort(new DOMException('Fixture search deadline', 'TimeoutError'));
        const result = await finished(f.service, job.id);
        assert.equal(result.phase, 'partial');
        assert.deepEqual(
            result.recommendations[0].matches.map((match) => match.id),
            [10],
        );
        assert.equal(result.sources.find((source) => source.id === '2').phase, 'interrupted');
    },
);
test(
    'AI gateway actions require verified Basic Auth and same-origin POST; key management does not depend on updater tokens',
    { timeout: 4000 },
    async (t) => {
        const f = await fixture(t);
        const server = createGateway({
            upstream: 'http://127.0.0.1:18082',
            manifest: { commit: 'a'.repeat(40), version: '0.2.0' },
            aiService: f.service,
            configLoader: async () => ({ origins: ['https://reader.example'] }),
            secretLoader: async () => {
                throw new Error('Updater tokens should not be loaded');
            },
            fetchImpl: async (url, options) =>
                options.headers.Authorization === request.headers.authorization
                    ? json({ data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } } })
                    : new Response(null, { status: 401 }),
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + server.address().port;
        t.after(async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        });
        const missing = await fetch(url + '/private-api/ai/settings');
        assert.equal(missing.status, 401);
        const status = await fetch(url + '/private-api/ai/settings', {
            headers: { Authorization: request.headers.authorization },
        });
        assert.equal(status.status, 200);
        assert(!(await status.text()).includes(key));
        const headers = {
            Authorization: request.headers.authorization,
            'Content-Type': 'application/json',
            'X-Suwayomi-Private': '1',
            Origin: 'https://evil.example',
        };
        const cross = await fetch(url + '/private-api/ai/settings', {
            method: 'POST',
            headers,
            body: JSON.stringify({ removeKey: true }),
        });
        assert.equal(cross.status, 403);
        assert.equal((await f.service.status()).configured, true);
        const valid = await fetch(url + '/private-api/ai/settings', {
            method: 'POST',
            headers: { ...headers, Origin: 'https://reader.example' },
            body: JSON.stringify({ enabled: false }),
        });
        assert.equal(valid.status, 200);
        assert.equal((await valid.json()).enabled, false);
        const absent = await fetch(url + '/private-api/ai/jobs/' + 'a'.repeat(36), { headers });
        assert.equal(absent.status, 404);
    },
);
