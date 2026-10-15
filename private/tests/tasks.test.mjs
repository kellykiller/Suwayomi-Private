/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTaskService } from '../server/tasks.mjs';
import { createGateway } from '../server/gateway.mjs';
const id = randomUUID();
const request = { headers: { authorization: 'Basic ' + Buffer.from('fixture:password').toString('base64') } };
function services(options = {}) {
    const cancelled = [];
    const jobs = [
        { id, chapterId: 47, title: 'Comic', chapterName: 'Chapter', phase: 'ocr', completedPages: 0, pageCount: 47 },
    ];
    const translations = {
        list: async () => jobs,
        active: async () => ({ ...jobs[0], progress: { stage: 'ocr', completed: 16, total: 47, blockCount: 150 } }),
        cancel: async (value) => {
            assert.equal(value, id);
            cancelled.push('translation');
        },
    };
    const ai = {
        active: () => ({ id, phase: 'searching', completedSources: 1, sources: [{}, {}], checkedQueries: 4 }),
        cancel: (value, req) => {
            assert.equal(value, id);
            assert.equal(req, request);
            cancelled.push('ai');
        },
    };
    const taskService = createTaskService({
        translations,
        ai,
        jobReader: async () => ({ id, action: 'update', phase: 'building' }),
        upstream: 'http://127.0.0.1:18082',
        fetchImpl: async (url, input) => {
            assert.equal(String(url), 'http://127.0.0.1:18082/api/graphql');
            assert.equal(input.headers.Authorization, request.headers.authorization);
            assert(!JSON.parse(input.body).query.includes('mutation'));
            return Response.json({
                data: {
                    downloadStatus: { state: 'STARTED', queue: [{ state: 'DOWNLOADING' }, { state: 'QUEUED' }] },
                    libraryUpdateStatus: { jobsInfo: { isRunning: true, finishedJobs: 2, totalJobs: 9 } },
                },
            });
        },
        ...options,
    });
    return { taskService, cancelled, jobs, translations, ai };
}
test('Central task list exposes active OCR independently of the originating UI and includes native background tasks', async () => {
    const { taskService } = services();
    const value = await taskService.list(request);
    assert.deepEqual(
        value.tasks.map((task) => task.kind),
        ['translation', 'ai', 'update', 'downloads', 'library'],
    );
    assert.equal(value.warnings.length, 0);
    const task = value.tasks[0];
    assert.equal(task.progress.blockCount, 150);
    assert.equal(task.progress.completed, 16);
    assert.equal(task.href, `/settings/translations?chapter=47&job=${id}`);
    assert(task.cancellable);
    assert.equal(value.tasks.find((item) => item.kind === 'update').cancellable, false);
});
test('Unreachable native or updater status does not hide or disable the running translation', async () => {
    const { taskService } = services({
        jobReader: async () => {
            throw new Error('fixture');
        },
        fetchImpl: async () => {
            throw new Error('fixture');
        },
    });
    const value = await taskService.list(request);
    assert(value.warnings.length >= 2);
    assert(value.tasks.some((task) => task.kind === 'translation' && task.cancellable));
});
test('Central cancellation targets only the selected translation or owned AI task and cannot stop updates or arbitrary containers', async () => {
    const { taskService, cancelled } = services();
    await taskService.cancel({ kind: 'translation', id }, request);
    await taskService.cancel({ kind: 'ai', id }, request);
    assert.deepEqual(cancelled, ['translation', 'ai']);
    await assert.rejects(taskService.cancel({ kind: 'update', id }, request), /nicht abgebrochen/);
    await assert.rejects(
        taskService.cancel({ kind: 'translation', id: '../other-container' }, request),
        /nicht abgebrochen/,
    );
    assert.equal(cancelled.length, 2);
});
test('Ready and paused tasks remain reopenable while completed tasks do not clutter active tasks', async () => {
    const f = services();
    f.jobs[0].phase = 'paused';
    f.translations.active = async () => null;
    f.jobs.push({ ...f.jobs[0], id: randomUUID(), phase: 'completed' });
    const value = await f.taskService.list(request);
    assert.equal(value.tasks.filter((task) => task.kind === 'translation').length, 1);
    assert.equal(value.tasks.find((task) => task.kind === 'translation').cancellable, false);
    assert.equal(value.tasks[0].kind, 'ai');
    assert.equal(value.tasks.at(-1).kind, 'translation');
});
test('Task cancellation requires native Basic Auth and same-origin headers before reaching a job controller', async (t) => {
    let cancels = 0;
    const gateway = createGateway({
        upstream: 'http://127.0.0.1:18082',
        manifest: {},
        configLoader: async () => ({ origins: ['https://reader.example'] }),
        fetchImpl: async (_url, input) =>
            input.headers.Authorization
                ? Response.json({
                      data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
                  })
                : new Response('', { status: 401 }),
        aiService: { stop: async () => {}, active: () => null },
        translationService: {
            cancel: async () => {
                cancels++;
            },
            list: async () => [],
            stop: async () => {},
        },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const url = `http://127.0.0.1:${gateway.address().port}/private-api/tasks/cancel`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = {
        Authorization: request.headers.authorization,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Suwayomi-Private': '1',
    };
    const body = JSON.stringify({ kind: 'translation', id });
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 403);
    assert.equal(cancels, 0);
    headers.Origin = 'https://reader.example';
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 202);
    assert.equal(cancels, 1);
});
test('Pause routes target chapter processing only and expose the pending request in task status', async () => {
    const f = services();
    let paused = false;
    f.translations.pause = async (value) => {
        assert.equal(value, id);
        paused = true;
    };
    await f.taskService.pause({ kind: 'translation', id });
    assert(paused);
    await assert.rejects(f.taskService.pause({ kind: 'ai', id }), /Nur Kapitel/);
    assert.equal((await f.taskService.list(request)).tasks[0].pausable, true);
});
test('Central pause requests require Basic Auth and same-origin just like cancellation', async (t) => {
    let pauses = 0;
    const gateway = createGateway({
        upstream: 'http://127.0.0.1:18082',
        manifest: {},
        configLoader: async () => ({ origins: ['https://reader.example'] }),
        fetchImpl: async (_url, input) =>
            input.headers.Authorization
                ? Response.json({
                      data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
                  })
                : new Response('', { status: 401 }),
        aiService: { stop: async () => {} },
        translationService: {
            pause: async (value) => {
                assert.equal(value, id);
                pauses++;
            },
            stop: async () => {},
        },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const url = `http://127.0.0.1:${gateway.address().port}/private-api/tasks/pause`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = {
        Authorization: request.headers.authorization,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Suwayomi-Private': '1',
    };
    const body = JSON.stringify({ kind: 'translation', id });
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 403);
    assert.equal(pauses, 0);
    headers.Origin = 'https://reader.example';
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 202);
    assert.equal(pauses, 1);
});

test('Completed page samples stay reopenable without appearing as active update blockers', async () => {
    const f = services();
    f.jobs[0].phase = 'partial';
    f.jobs[0].completedPages = 3;
    f.translations.active = async () => null;
    const value = await f.taskService.privateTasks(request);
    const sample = value.tasks.find((task) => task.kind === 'translation');
    assert.equal(sample.phase, 'partial');
    assert.equal(sample.active, false);
    assert.equal(sample.cancellable, false);
    assert.match(sample.detail, /3\/47/);
    assert.match(sample.href, /settings\/translations/);
});
