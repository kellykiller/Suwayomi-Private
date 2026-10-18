/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createGateway } from '../server/gateway.mjs';
import {
    upgradeTranslator,
    translatorBootstrap,
    translatorSpec,
    validateTranslator,
    TRANSLATOR,
    TRANSLATOR_ROOT,
    RUNTIME_ENV,
} from '../server/translator-update.mjs';

const oldId = 'a'.repeat(64),
    newId = 'b'.repeat(64),
    testId = 'c'.repeat(64),
    helperId = 'd'.repeat(64),
    uiId = 'e'.repeat(64);
const oldImage = 'sha256:' + '1'.repeat(64),
    targetImage = 'sha256:' + '2'.repeat(64);
const commit = 'f'.repeat(40);
const config = { endpointId: 3, daemonId: 'fixture-daemon' };
const manifest = { commit, version: '0.5.2', translatorVersion: '0.1.2' };
const wait = async () => new Promise((resolve) => setTimeout(resolve, 1));
function container() {
    return {
        Id: oldId,
        Name: '/' + TRANSLATOR,
        Image: oldImage,
        State: { Status: 'running', ExitCode: 0 },
        Config: {
            User: '10001:10001',
            Labels: { 'com.docker.compose.project': 'suwayomi-translator', 'com.docker.compose.service': 'translator' },
        },
        HostConfig: {
            ReadonlyRootfs: true,
            Privileged: false,
            NetworkMode: 'suwayomi-translator_default',
            Memory: 3 * 1024 ** 3,
            RestartPolicy: { Name: 'unless-stopped' },
            PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18083' }] },
        },
        Mounts: [
            { Type: 'bind', Source: TRANSLATOR_ROOT + '/data', Destination: '/data', RW: true },
            { Type: 'bind', Source: TRANSLATOR_ROOT + '/secrets', Destination: '/run/secrets', RW: false },
        ],
    };
}
async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(tmpdir() + '/translator-update-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const id = randomUUID(),
        calls = [],
        values = new Map();
    if (!options.missing) values.set(oldId, container());
    values.set(uiId, {
        Id: uiId,
        Name: '/suwayomi-private-ui',
        Image: targetImage,
        State: { Status: 'running' },
        Config: { Labels: { 'com.docker.compose.project': 'suwayomi', 'io.suwayomi.translator.version': '0.1.2' } },
    });
    const find = (name) => values.get(name) || [...values.values()].find((c) => c.Name === '/' + name);
    let tested = false,
        helperTask;
    const fetchImpl = async (url) => {
        assert.equal(String(url), 'http://127.0.0.1:18083/healthz');
        const current = find(TRANSLATOR);
        if (!current || current.State.Status !== 'running' || (current.Image === targetImage && options.badHealth))
            return new Response('', { status: 503 });
        return Response.json({
            status: 'ok',
            service: TRANSLATOR,
            model: 'gpt-6-astra',
            version: current.Image === targetImage || options.current ? '0.1.2' : '0.1.0',
            credentials: { google: true, openai: !(current.Image === targetImage && options.lostKeys) },
            control_token_configured: true,
            queued_jobs: options.busy || (tested && options.busyAfterTest) ? 1 : 0,
            running_jobs: 0,
            api_requests_on_startup: 0,
        });
    };
    const api = async (path, input = {}) => {
        calls.push({ path, ...input });
        const url = new URL(path, 'http://fixture');
        const suffix = url.pathname.replace('/endpoints/3/docker/', '');
        if (suffix === 'info') return { ID: options.wrongDaemon ? 'other' : config.daemonId };
        const json = suffix.match(/^containers\/(.+)\/json$/);
        if (json) return structuredClone(find(decodeURIComponent(json[1])) || null);
        if (suffix === 'containers/create') {
            const name = url.searchParams.get('name');
            const selftest = name.startsWith('suwayomi-translator-selftest-');
            const helper = name.startsWith('suwayomi-translator-update-');
            const identity = selftest ? testId : helper ? helperId : newId;
            if (!selftest && !helper) {
                assert.equal(name, TRANSLATOR);
                assert.equal(find(oldId).State.Status, 'exited');
                assert.equal(find(TRANSLATOR), undefined);
            }
            const c = {
                Id: identity,
                Name: '/' + name,
                Image: input.body.Image,
                Config: { User: input.body.User, Labels: input.body.Labels },
                HostConfig: input.body.HostConfig,
                State: { Status: 'created', ExitCode: 0 },
                Mounts: container().Mounts,
            };
            values.set(identity, c);
            if (!selftest && !helper && options.lostCreateReply) throw new Error('Create response lost');
            return { Id: identity };
        }
        const action = suffix.match(/^containers\/([a-f0-9]{64})(?:\/(start|stop|rename|wait|logs))?$/);
        assert(action, 'Unexpected Docker action: ' + path);
        const c = find(action[1]);
        assert(c, 'Unknown container: ' + path);
        if (input.method === 'DELETE') {
            values.delete(c.Id);
            return null;
        }
        if (action[2] === 'start') {
            c.State.Status = 'running';
            if (c.Id === newId && options.foreignReplacement)
                c.Config.Labels['io.suwayomi.translator-update'] = randomUUID();
            if (c.Id === helperId) {
                helperTask = upgradeTranslator(api, config, {
                    id,
                    image: targetImage,
                    version: '0.1.2',
                    root,
                    fetchImpl,
                    wait,
                }).catch(() => {});
            }
            return null;
        }
        if (action[2] === 'stop') {
            c.State.Status = 'exited';
            return null;
        }
        if (action[2] === 'rename') {
            c.Name = '/' + url.searchParams.get('name');
            return null;
        }
        if (action[2] === 'wait') {
            tested = true;
            return { StatusCode: options.testFailure ? 1 : 0 };
        }
        if (action[2] === 'logs')
            return new Response(
                JSON.stringify({
                    offline_selftest: 'ok',
                    image_formats: 'ok',
                    heic: 'ok',
                    pdf: 'ok',
                    google_requests: 0,
                    openai_requests: 0,
                }) + '\n',
            );
        throw new Error('Unexpected action: ' + path);
    };
    const run = (extra) =>
        upgradeTranslator(api, config, { id, image: targetImage, version: '0.1.2', root, fetchImpl, wait, ...extra });
    const saveJob = async (changes = {}) => {
        await fs.mkdir(root + '/jobs', { recursive: true });
        await fs.writeFile(root + '/latest-job.json', JSON.stringify({ id }));
        await fs.writeFile(
            root + '/jobs/' + id + '.json',
            JSON.stringify({ id, action: 'update', target: commit, phase: 'deploying', ...changes }),
        );
    };
    const bootstrap = () =>
        translatorBootstrap({ root, manifest, connection: async () => ({ config, api }), fetchImpl, wait });
    const record = async () => JSON.parse(await fs.readFile(root + '/translator-updates/' + id + '.json', 'utf8'));
    t.after(async () => {
        await helperTask;
    });
    return { root, id, calls, values, find, api, fetchImpl, run, saveJob, bootstrap, record };
}

test('Offline format test has no network or keys and finishes before the existing translator is stopped', async (t) => {
    const f = await fixture(t);
    const result = await f.run();
    assert.equal(result.status, 'succeeded');
    const tests = f.calls.filter((c) => c.path.includes('containers/create?name=suwayomi-translator-selftest-'));
    assert.equal(tests.length, 1);
    assert.equal(tests[0].body.HostConfig.NetworkMode, 'none');
    assert.equal(tests[0].body.HostConfig.Binds, undefined);
    assert.deepEqual(tests[0].body.Env, RUNTIME_ENV);
    assert(!JSON.stringify(tests[0]).includes('key'));
    assert(f.calls.findIndex((c) => c.path.includes('/wait?')) < f.calls.findIndex((c) => c.path.includes('/stop?')));
    const live = f.calls.find((c) => c.path.endsWith('containers/create?name=' + TRANSLATOR)).body;
    assert.deepEqual(live.HostConfig.Binds, [
        TRANSLATOR_ROOT + '/data:/data',
        TRANSLATOR_ROOT + '/secrets:/run/secrets:ro',
    ]);
    assert.equal(live.User, '10001:10001');
    assert(live.HostConfig.ReadonlyRootfs);
    assert.equal(f.find(TRANSLATOR).Image, targetImage);
    assert.equal(f.find(oldId).State.Status, 'exited');
    assert.equal(result.credentials.control, true);
});
test('Current translator version and absent translator installation make no changes', async (t) => {
    for (const options of [{ current: true }, { missing: true }]) {
        const f = await fixture(t, options);
        assert.equal((await f.run()).noop, true);
        assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
    }
});
test('Wrong container identity, mounts or public port are rejected', () => {
    for (const change of [
        (c) => {
            c.Config.User = '0:0';
        },
        (c) => {
            c.Mounts[0].Source = '/foreign';
        },
        (c) => {
            c.HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0';
        },
        (c) => {
            c.Config.Labels['com.docker.compose.project'] = 'foreign';
        },
    ]) {
        const c = container();
        change(c);
        assert.throws(() => validateTranslator(c));
    }
    assert.throws(() => translatorSpec(container(), 'mutable:tag', randomUUID(), '0.1.2'));
});
test('Busy service cannot be stopped, including a job queued during the offline test', async (t) => {
    for (const options of [{ busy: true }, { busyAfterTest: true }]) {
        const f = await fixture(t, options);
        await assert.rejects(f.run(), /Auftraege|beschaeftigt/);
        assert.equal(f.find(TRANSLATOR).Image, oldImage);
        assert.equal(f.find(oldId).State.Status, 'running');
        assert(!f.calls.some((c) => c.path.includes('/stop?')));
    }
});
test('Failed offline test leaves the running original service untouched', async (t) => {
    const f = await fixture(t, { testFailure: true });
    await assert.rejects(f.run(), /Offline-Selbsttest/);
    assert.equal(f.find(TRANSLATOR).Image, oldImage);
    assert.equal(f.find(oldId).State.Status, 'running');
    assert(!f.calls.some((c) => c.path.includes('/stop?')));
    assert.equal((await f.record()).status, 'failed');
});
test('Failed new health or missing keys restore the old container with the same data mounts', async (t) => {
    for (const options of [{ badHealth: true }, { lostKeys: true }]) {
        const f = await fixture(t, options);
        await assert.rejects(f.run(), /Bisheriger Dienst wiederhergestellt/);
        assert.equal(f.find(TRANSLATOR).Id, oldId);
        assert.equal(f.find(oldId).State.Status, 'running');
        assert.equal(f.find(newId), undefined);
        assert.deepEqual(f.find(oldId).Mounts, container().Mounts);
    }
});
test('Lost create response finds and removes only the owned new container before restoring the original', async (t) => {
    const f = await fixture(t, { lostCreateReply: true });
    await assert.rejects(f.run(), /Bisheriger Dienst wiederhergestellt/);
    assert.equal(f.find(TRANSLATOR).Id, oldId);
    assert.equal(f.find(oldId).State.Status, 'running');
    assert.equal(f.find(newId), undefined);
});
test('Concurrent foreign replacement is never deleted by automatic recovery', async (t) => {
    const f = await fixture(t, { badHealth: true, foreignReplacement: true });
    await assert.rejects(f.run(), /parallel geaendert/);
    assert(f.find(newId));
    assert(f.find(oldId));
    assert(!f.calls.some((c) => c.method === 'DELETE' && c.path.includes(newId)));
});
test('Cancellation during the offline test leaves the running service unchanged', async (t) => {
    const f = await fixture(t);
    let checks = 0;
    await assert.rejects(
        f.run({
            authorize: async () => {
                if (++checks > 1) throw new Error('Update abgebrochen');
            },
        }),
        /abgebrochen/,
    );
    assert.equal(f.find(TRANSLATOR).Id, oldId);
    assert.equal(f.find(oldId).State.Status, 'running');
    assert(!f.calls.some((c) => c.path.includes('/stop?')));
});
test('Interrupted replacement is recovered from its durable checkpoint', async (t) => {
    const f = await fixture(t);
    const old = f.find(oldId);
    old.Name = '/' + TRANSLATOR + '-backup-' + f.id;
    old.State.Status = 'exited';
    f.values.set(newId, {
        ...container(),
        Id: newId,
        Image: targetImage,
        Config: {
            ...container().Config,
            Labels: { ...container().Config.Labels, 'io.suwayomi.translator-update': f.id },
        },
    });
    await fs.mkdir(f.root + '/translator-updates');
    await fs.writeFile(
        f.root + '/translator-updates/' + f.id + '.json',
        JSON.stringify({
            id: f.id,
            targetImage,
            status: 'starting',
            oldId,
            oldImage,
            oldVersion: '0.1.0',
            credentials: { openai: true, google: true, control: true },
        }),
    );
    await assert.rejects(f.run(), /Unterbrochenes Dienst-Update/);
    assert.equal(f.find(TRANSLATOR).Id, oldId);
    assert.equal(f.find(oldId).State.Status, 'running');
});
test('Normal gateway restart or explicit UI rollback never starts a translator upgrade', async (t) => {
    for (const changes of [{ phase: 'succeeded' }, { action: 'rollback' }, { target: '0'.repeat(40) }]) {
        const f = await fixture(t);
        await f.saveJob(changes);
        const b = f.bootstrap();
        await b.start();
        assert.equal(b.status().ready, true);
        assert.equal(b.status().status, 'not_requested');
        assert.equal(f.calls.length, 0);
    }
});
test('A single existing update action bootstraps the translator and does not launch a second helper', async (t) => {
    const f = await fixture(t);
    await f.saveJob();
    const b = f.bootstrap();
    assert.equal(b.status().ready, false);
    await Promise.all([b.start(), b.start()]);
    assert.equal(b.status().ready, true);
    assert.equal(f.find(TRANSLATOR).Image, targetImage);
    assert.equal(
        f.calls.filter((c) => c.path.includes('containers/create?name=suwayomi-translator-update-')).length,
        1,
    );
    const helper = f.calls.find((c) => c.path.includes('containers/create?name=suwayomi-translator-update-')).body;
    assert.equal(helper.Image, targetImage);
    assert.equal(helper.HostConfig.AutoRemove, true);
    assert(!helper.HostConfig.Binds.some((value) => value.startsWith(TRANSLATOR_ROOT)));
});
test('An already created helper is started and reused instead of creating a duplicate', async (t) => {
    const f = await fixture(t);
    await f.saveJob();
    f.values.set(helperId, {
        Id: helperId,
        Name: '/suwayomi-translator-update-' + f.id,
        Image: targetImage,
        State: { Status: 'created' },
        Config: { Labels: { 'io.suwayomi.translator-update': f.id } },
    });
    await fs.mkdir(f.root + '/translator-updates');
    await fs.writeFile(
        f.root + '/translator-updates/' + f.id + '.json',
        JSON.stringify({ id: f.id, targetImage, version: '0.1.2', workerId: helperId }),
    );
    const b = f.bootstrap();
    await b.start();
    assert.equal(b.status().ready, true);
    assert(!f.calls.some((c) => c.path.includes('containers/create?name=suwayomi-translator-update-')));
});
test('Wrong Docker daemon or failed helper prevents the new UI from claiming readiness', async (t) => {
    for (const options of [{ wrongDaemon: true }, { testFailure: true }]) {
        const f = await fixture(t, options);
        await f.saveJob();
        const b = f.bootstrap();
        await b.start();
        assert.equal(b.status().ready, false);
        assert.equal(b.status().status, 'failed');
        assert.equal(f.find(TRANSLATOR).Image, oldImage);
    }
});
test('Gateway health stays unready until the component update finishes', async (t) => {
    let ready = false;
    const gateway = createGateway({
        manifest,
        fetchImpl: async () => new Response('', { status: 200 }),
        aiService: { stop: async () => {} },
        translationService: { stop: async () => {} },
        cloudTranslationService: { stop: async () => {} },
        logService: { write: async () => {} },
        componentUpdate: { status: () => ({ ready, status: ready ? 'succeeded' : 'testing' }) },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const url = `http://127.0.0.1:${gateway.address().port}/healthz`;
    assert.equal((await fetch(url)).status, 503);
    ready = true;
    assert.equal((await fetch(url)).status, 200);
});
