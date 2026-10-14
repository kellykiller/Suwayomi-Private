/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTranslationService, validateTranslation, translationResponse } from '../server/translation.mjs';
import { createAiLedger } from '../server/ai-ledger.mjs';
import { createImageWorker } from '../server/translation-worker.mjs';
import { writeJson, readJson } from '../server/common.mjs';
import { createGateway } from '../server/gateway.mjs';

const request = { headers: { authorization: 'Basic Zml4dHVyZTpwYXNzd29yZA==' } };
const json = (value, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const chapter = {
    id: 9,
    mangaId: 2,
    sourceOrder: 3,
    name: 'Chapter 3',
    isDownloaded: true,
    pageCount: 2,
    manga: { id: 2, title: 'Fixture Comic', source: { lang: 'en' } },
};
const modelResponse = (value, status = 'completed') =>
    json({
        status,
        model: 'gpt-5.4-mini-2026-03-17',
        service_tier: 'default',
        id: 'resp_fixture',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        usage: {
            input_tokens: 100,
            output_tokens: 80,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 10 },
        },
    });
const specimen = () => ({
    engine: 'fixture',
    warnings: [],
    pages: [0, 1].map((index) => ({
        index,
        width: 100,
        height: 200,
        warnings: [],
        blocks: [
            {
                id: `p${index}b0`,
                box: [10, 20, 80, 70],
                text: index ? 'Who are you?' : 'Hello friend!',
                translated: '',
                note: '',
                confidence: 0.9,
                rendered: false,
            },
        ],
    })),
});
async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(tmpdir() + '/translation-test-');
    await fs.mkdir(root + '/secrets');
    await fs.writeFile(root + '/secrets/openai.token', 'sk-proj-' + 'fixtureOnly'.repeat(5));
    const ledger = createAiLedger({ stateRoot: root });
    const modelCalls = [];
    const backendCalls = [];
    const workerCalls = [];
    const fetchImpl = async (url, input) => {
        const name = String(url);
        if (name === 'https://api.openai.com/v1/responses') {
            const body = JSON.parse(input.body);
            modelCalls.push(body);
            if (options.model) return options.model(body, input);
            const prompt = JSON.parse(body.input[0].content[0].text);
            return modelResponse(
                prompt.blocks
                    ? { blocks: prompt.blocks.map((block) => ({ id: block.id, translated: 'Hallo Welt!', note: '' })) }
                    : { summary: 'Zwei Personen begrüßen sich und fragen nach der Identität.', glossary: [] },
            );
        }
        backendCalls.push(name);
        if (name.includes('/api/graphql')) return json({ data: { chapter: options.chapter || chapter } });
        assert.equal(name, 'http://127.0.0.1:18082/api/v1/chapter/9/download?markAsRead=false');
        return new Response('local archive fixture', { status: options.archiveStatus || 200 });
    };
    const imageWorker = async (job, operation, signal) => {
        workerCalls.push(operation);
        const folder = root + '/translations/' + job.id;
        if (options.worker) return options.worker(job, operation, signal, folder);
        if (operation === 'analyze') {
            await writeJson(folder + '/content.json', specimen());
            for (const kind of ['original', 'preview']) {
                await fs.mkdir(folder + '/' + kind, { recursive: true });
                for (const index of [0, 1])
                    await fs.writeFile(
                        `${folder}/${kind}/${String(index).padStart(4, '0')}.${kind === 'preview' ? 'jpg' : 'png'}`,
                        'image fixture',
                    );
            }
        } else {
            const data = await readJson(folder + '/content.json');
            for (const page of data.pages) for (const block of page.blocks) block.rendered = true;
            await writeJson(folder + '/content.json', data);
        }
    };
    const service = createTranslationService({
        upstream: 'http://127.0.0.1:18082',
        stateRoot: root,
        secretRoot: root + '/secrets',
        ledger,
        fetchImpl,
        imageWorker,
        ...options.service,
    });
    t.after(async () => {
        await service.stop();
        ledger.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    return { service, root, ledger, fetchImpl, imageWorker, modelCalls, backendCalls, workerCalls };
}
async function settled(service, id) {
    for (let i = 0; i < 300; i++) {
        if (!service.busy()) return service.get(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Translation fixture did not settle');
}
const start = (service) => service.start({ requestId: randomUUID(), chapterId: 9, sourceLanguage: 'en' }, request);
const resume = (service, id, extra = {}) =>
    service.resume(
        { id, consent: true, model: 'gpt-5.4-mini', reasoning: 'medium', budgetUsd: 0.5, ...extra },
        request,
    );

test('Local analysis exports downloaded files only, calls no AI, and is idempotent', async (t) => {
    const f = await fixture(t);
    const job = await start(f.service);
    const ready = await settled(f.service, job.id);
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.blockCount, 2);
    assert.equal(f.modelCalls.length, 0);
    assert.equal(f.backendCalls.length, 2);
    assert.equal(f.workerCalls[0], 'analyze');
    const duplicate = await f.service.start({ requestId: job.id, chapterId: 9, sourceLanguage: 'en' }, request);
    assert.equal(duplicate.id, job.id);
    assert.equal(f.backendCalls.length, 2);
    assert.equal((await f.ledger.history()).total, 0);
});
test('Whole-chapter context precedes page translations; current and adjacent images are included and every call is billed', async (t) => {
    const f = await fixture(t);
    const job = await start(f.service);
    await settled(f.service, job.id);
    const original = await fs.readFile(f.root + '/translations/' + job.id + '/original/0000.png');
    await resume(f.service, job.id);
    const done = await settled(f.service, job.id);
    assert.equal(done.phase, 'completed');
    assert.equal(done.completedPages, 2);
    assert.equal(f.modelCalls.length, 3);
    const context = JSON.parse(f.modelCalls[0].input[0].content[0].text);
    assert.equal(context.pages[0].blocks[0].text, 'Hello friend!');
    assert.equal(context.pages[1].blocks[0].text, 'Who are you?');
    const page = JSON.parse(f.modelCalls[1].input[0].content[0].text);
    assert.equal(page.chapterContext.glossary.length, 0);
    assert.equal(f.modelCalls[1].input[0].content.filter((item) => item.type === 'input_image').length, 2);
    assert.equal(done.costUsd, 0.001305);
    assert.equal((await f.ledger.summary()).balance.estimatedUsd, 2.308695);
    const history = await f.ledger.history();
    assert.equal(history.total, 3);
    assert.equal(history.entries[0].kind, 'translation');
    assert.equal(history.entries[0].chapter.id, 9);
    assert.match(history.entries[0].prompt, /Who are you/);
    assert.deepEqual(await fs.readFile(f.root + '/translations/' + job.id + '/original/0000.png'), original);
    assert.equal((await f.service.available(9)).pages.length, 2);
    assert.match((await f.service.available(9)).pages[0], /private-api\/translations\/files/);
    for (const body of f.modelCalls) {
        assert.equal(body.store, false);
        assert.equal(body.service_tier, 'default');
        assert.equal(body.text.format.strict, true);
        assert.match(body.instructions, /untrusted book content/);
        assert(!JSON.stringify(body).includes('fixtureOnly'));
    }
});
test('Consent, source language, downloaded status, and budgets are checked before paid calls', async (t) => {
    const f = await fixture(t);
    await assert.rejects(
        f.service.start({ requestId: randomUUID(), chapterId: 9, sourceLanguage: 'ko' }, request),
        /Quellsprache/,
    );
    const job = await start(f.service);
    await settled(f.service, job.id);
    await assert.rejects(resume(f.service, job.id, { consent: false }), /zustimmen/);
    await assert.rejects(resume(f.service, job.id, { budgetUsd: NaN }), /Kostenlimit/);
    await resume(f.service, job.id, { budgetUsd: 0.01 });
    const paused = await settled(f.service, job.id);
    assert.equal(paused.phase, 'paused');
    assert.match(paused.error, /Kostenlimit/);
    assert.equal(f.modelCalls.length, 0);
    const other = await fixture(t, { chapter: { ...chapter, isDownloaded: false } });
    await assert.rejects(start(other.service), /herunterladen/);
    assert.equal(other.backendCalls.length, 1);
    assert.equal(other.workerCalls.length, 0);
});
test('Missing local CBZ export fails without ever falling back to source pages', async (t) => {
    const f = await fixture(t, { archiveStatus: 404 });
    const job = await start(f.service);
    const paused = await settled(f.service, job.id);
    assert.match(paused.error, /Originalquelle/);
    assert.equal(f.backendCalls.length, 2);
    assert.equal(f.modelCalls.length, 0);
    assert.equal(f.workerCalls.length, 0);
});
test('Manual translated-text correction re-renders without another AI request; OCR changes after paid calls are blocked', async (t) => {
    const f = await fixture(t);
    const job = await start(f.service);
    await settled(f.service, job.id);
    await f.service.edit({ id: job.id, page: 0, blocks: [{ id: 'p0b0', text: 'Corrected OCR' }] });
    await resume(f.service, job.id);
    await settled(f.service, job.id);
    await assert.rejects(
        f.service.edit({ id: job.id, page: 0, blocks: [{ id: 'p0b0', text: 'Changed after payment' }] }),
        /ersten KI-Aufruf/,
    );
    await f.service.edit({ id: job.id, page: 0, blocks: [{ id: 'p0b0', translated: 'Meine Korrektur' }] });
    const done = await settled(f.service, job.id);
    assert.equal(done.pages[0].blocks[0].translated, 'Meine Korrektur');
    assert.equal(f.modelCalls.length, 3);
    assert.equal(done.revision, 2);
    assert.deepEqual(f.workerCalls, ['analyze', 'render', 'render']);
});
test('Ambiguous interrupted API calls remain unknown and are never automatically retried', async (t) => {
    const f = await fixture(t, {
        model: () => {
            throw new Error('Connection lost');
        },
    });
    const job = await start(f.service);
    await settled(f.service, job.id);
    await resume(f.service, job.id);
    const paused = await settled(f.service, job.id);
    assert.equal(paused.phase, 'paused');
    assert.equal(paused.unknownCalls, 1);
    assert.equal(f.modelCalls.length, 1);
    await assert.rejects(resume(f.service, job.id), /unbekannte Kosten/);
    assert.equal((await f.ledger.history()).entries[0].costUnknown, true);
});
test('A process restart recovers stored OCR and finished-page cache without another paid request', async (t) => {
    const f = await fixture(t);
    const job = await start(f.service);
    await settled(f.service, job.id);
    await resume(f.service, job.id);
    await settled(f.service, job.id);
    await f.service.stop();
    const jobPath = f.root + '/translations/' + job.id + '/job.json';
    const stored = await readJson(jobPath);
    stored.phase = 'translating';
    await writeJson(jobPath, stored);
    const next = createTranslationService({
        upstream: 'http://127.0.0.1:18082',
        stateRoot: f.root,
        secretRoot: f.root + '/secrets',
        ledger: f.ledger,
        fetchImpl: f.fetchImpl,
        imageWorker: f.imageWorker,
    });
    t.after(() => next.stop());
    const recovered = await next.get(job.id);
    assert.equal(recovered.phase, 'paused');
    assert.match(recovered.error, /Dienstneustart/);
    await resume(next, job.id);
    const done = await settled(next, job.id);
    assert.equal(done.phase, 'completed');
    assert.equal(f.modelCalls.length, 3);
});
test('Incomplete translation responses retain usage and reject duplicate or foreign block IDs', async () => {
    let received;
    await assert.rejects(
        translationResponse({
            key: 'fixture',
            model: 'gpt-5.4-mini',
            reasoning: 'low',
            prompt: '{}',
            schema: {},
            observer: {
                started: async () => {},
                rejected: async () => {},
                usage: async (value) => {
                    received = value;
                },
            },
            fetchImpl: async () => modelResponse({}, 'incomplete'),
        }),
        /unvollständig/,
    );
    assert.equal(received.usage.outputTokens, 80);
    assert.throws(
        () => validateTranslation({ blocks: [{ id: 'wrong', translated: 'Text', note: '' }] }, [{ id: 'right' }]),
        /unbekannter/,
    );
    assert.throws(() => validateTranslation({ blocks: [] }, [{ id: 'right' }]), /nicht alle/);
});
test('Only one local job can run and cancelling another job cannot abort it', async (t) => {
    const f = await fixture(t, {
        worker: async (_job, _operation, signal) => {
            if (signal.aborted) return;
            return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        },
    });
    const job = await start(f.service);
    await assert.rejects(start(f.service), /läuft bereits/);
    await f.service.cancel(job.id);
    await settled(f.service, job.id);
    assert.equal(f.modelCalls.length, 0);
});
test('Image helper uses a restricted offline container with only one staging bind and no API secrets', async (t) => {
    const root = await fs.mkdtemp(tmpdir() + '/translation-worker-test-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const id = randomUUID();
    await fs.mkdir(root + '/translations/' + id, { recursive: true });
    const workerId = 'b'.repeat(64);
    let body;
    let ended = false;
    const api = async (path, input) => {
        if (path.endsWith('/docker/info')) return { MemTotal: 8 * 1024 ** 3, NCPU: 4 };
        if (path.includes('suwayomi-private-ui'))
            return {
                Image: 'sha256:' + 'a'.repeat(64),
                Config: {
                    Labels: { 'com.docker.compose.project': 'suwayomi', 'com.docker.compose.service': 'private-ui' },
                },
            };
        if (path.includes('/containers/suwayomi-ocr-')) return null;
        if (path.includes('/containers/create')) {
            body = input.body;
            return { Id: workerId };
        }
        if (path.endsWith('/start')) {
            await writeJson(root + '/translations/' + id + '/worker-result.json', { ok: true });
            return null;
        }
        if (path.endsWith('/json'))
            return {
                Id: workerId,
                Config: { Labels: { 'io.suwayomi.private-translation': id } },
                State: { Status: 'exited', ExitCode: 0 },
            };
        if (input?.method === 'DELETE') {
            ended = true;
            return null;
        }
        throw new Error(path);
    };
    const run = createImageWorker({ stateRoot: root, connection: async () => ({ api, config: { endpointId: 1 } }) });
    await run({ id, sourceLanguage: 'ja' }, 'analyze', new AbortController().signal);
    assert.equal(body.HostConfig.NetworkMode, 'none');
    assert.equal(body.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(body.HostConfig.CapDrop, ['ALL']);
    assert.equal(body.HostConfig.Binds.length, 1);
    assert.match(body.HostConfig.Binds[0], /updater\/translations/);
    assert(!JSON.stringify(body).includes('/secrets'));
    assert(!JSON.stringify(body).includes('docker.sock'));
    assert.equal(ended, true);
});
test('Translation routes require native authentication and enforce same-origin POST before executing actions', async (t) => {
    let starts = 0;
    const gateway = createGateway({
        upstream: 'http://127.0.0.1:18082',
        manifest: {},
        configLoader: async () => ({ origins: ['https://reader.example'] }),
        fetchImpl: async (_url, input) =>
            input.headers.Authorization
                ? json({ data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } } })
                : new Response('', { status: 401 }),
        aiService: { stop: async () => {} },
        translationService: {
            start: async () => {
                starts++;
                return { id: 'fixture' };
            },
            busy: () => false,
            stop: async () => {},
        },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const url = `http://127.0.0.1:${gateway.address().port}/private-api/translations/analyze`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = {
        Authorization: request.headers.authorization,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Suwayomi-Private': '1',
    };
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 403);
    headers.Origin = 'https://reader.example';
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 202);
    assert.equal(starts, 1);
});
