/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLogStore } from '../server/logs.mjs';
import { dockerLogText, boundedText } from '../server/log-utils.mjs';
import { portainerClient, writeJson } from '../server/common.mjs';
import { createImageWorker } from '../server/translation-worker.mjs';
import { createGateway } from '../server/gateway.mjs';

async function temp(t) {
    const root = await fs.mkdtemp(tmpdir() + '/suwayomi-logs-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(root + '/secrets');
    return root;
}
const frame = (text) => {
    const bytes = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = 2;
    header.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([header, bytes]);
};
test('Log categories persist across restart, redact saved credentials and keep old failed translation jobs visible', async (t) => {
    const root = await temp(t);
    await fs.writeFile(root + '/secrets/portainer.token', 'custom-saved-secret');
    const logs = createLogStore({ stateRoot: root, secretRoot: root + '/secrets' });
    await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
            logs.write('ocr', 'INFO', `${i} custom-saved-secret sk-proj-abc123 Authorization: Bearer hidden`),
        ),
    );
    const restarted = createLogStore({ stateRoot: root, secretRoot: root + '/secrets' });
    const text = (await restarted.read('ocr')).text;
    assert(!text.includes('custom-saved-secret'));
    assert(!text.includes('sk-proj-abc123'));
    assert(!text.includes('Bearer hidden'));
    assert.equal(text.split('[INFO]').length - 1, 15);
    const id = randomUUID();
    await fs.mkdir(root + '/translations/' + id, { recursive: true });
    await writeJson(root + '/translations/' + id + '/job.json', {
        id,
        title: 'Manga',
        phase: 'paused',
        error: 'Portainer HTTP 400',
        pageCount: 47,
        completedPages: 0,
    });
    assert.match((await restarted.read('translation')).text, /Portainer HTTP 400/);
    await assert.rejects(logs.read('../secrets'), /Unbekannte Logkategorie/);
});
test('Logs rotate at the size limit without deleting other categories', async (t) => {
    const root = await temp(t);
    await fs.mkdir(root + '/logs');
    await fs.writeFile(root + '/logs/ocr.log', 'x'.repeat(2 * 1024 * 1024 + 1));
    await fs.writeFile(root + '/logs/system.log', 'must stay');
    const logs = createLogStore({ stateRoot: root, secretRoot: root + '/secrets' });
    await logs.write('ocr', 'INFO', 'new event');
    assert.equal((await fs.stat(root + '/logs/ocr.log.1')).size, 2 * 1024 * 1024 + 1);
    assert.match(await fs.readFile(root + '/logs/ocr.log', 'utf8'), /new event/);
    assert.equal(await fs.readFile(root + '/logs/system.log', 'utf8'), 'must stay');
});
test('Docker stdout/stderr frames decode as text and oversized responses are rejected', async () => {
    assert.equal(dockerLogText(Buffer.concat([frame('first\n'), frame('second\n')])), 'first\nsecond\n');
    assert.equal(dockerLogText(Buffer.from('plain tty log')), 'plain tty log');
    await assert.rejects(boundedText(new Response('123456'), 5), /Größenlimit/);
});
test('Portainer preserves a bounded Docker error explanation and removes credentials from it', async () => {
    const api = portainerClient(
        'http://127.0.0.1:9000',
        'saved-portainer-key',
        async () =>
            new Response(JSON.stringify({ message: 'NanoCPUs can not be set; saved-portainer-key' }), { status: 400 }),
    );
    await assert.rejects(
        api('/endpoints/1/docker/containers/create'),
        (error) =>
            error.status === 400 &&
            error.message.includes('NanoCPUs can not be set') &&
            !error.message.includes('saved-portainer-key'),
    );
});
test('OCR supports DSM without CFS or PIDs limits and retains failed worker output before deletion', async (t) => {
    for (const mode of ['dsm', 'quota', 'minimal']) {
        const root = await temp(t);
        const id = randomUUID();
        const workerId = 'c'.repeat(64);
        await fs.mkdir(root + '/translations/' + id, { recursive: true });
        let body,
            outputCaptured = false,
            deleted = false;
        const host = {
            MemTotal: 8 * 1024 ** 3,
            NCPU: 8,
            CpuCfsQuota: mode === 'quota',
            CpuCfsPeriod: mode === 'quota',
            CPUSet: mode === 'dsm',
            PidsLimit: mode === 'quota',
        };
        const api = async (path, input) => {
            if (path.endsWith('/docker/info')) return host;
            if (path.includes('/containers/suwayomi-ocr-')) return null;
            if (path.includes('/containers/suwayomi-private-ui'))
                return {
                    Image: 'sha256:' + 'a'.repeat(64),
                    HostConfig: { CpusetCpus: '2-5' },
                    Config: {
                        Labels: {
                            'com.docker.compose.project': 'suwayomi',
                            'com.docker.compose.service': 'private-ui',
                        },
                    },
                };
            if (path.includes('/containers/create')) {
                body = input.body;
                return { Id: workerId };
            }
            if (path.endsWith('/start')) return null;
            if (path.includes('/logs?')) {
                outputCaptured = true;
                return new Response(frame('Traceback: specific OCR failure\n'));
            }
            if (input?.method === 'DELETE') {
                assert(outputCaptured);
                deleted = true;
                return null;
            }
            if (path.endsWith('/json'))
                return {
                    Id: workerId,
                    Config: { Labels: { 'io.suwayomi.private-translation': id } },
                    State: { Status: 'exited', ExitCode: 1 },
                };
            throw new Error(path);
        };
        const logs = createLogStore({ stateRoot: root, secretRoot: root + '/secrets' });
        const worker = createImageWorker({
            connection: async () => ({ api, config: { endpointId: 1 } }),
            stateRoot: root,
            logs,
        });
        await assert.rejects(
            worker({ id, sourceLanguage: 'en' }, 'analyze', new AbortController().signal),
            /Bildverarbeitung fehlgeschlagen/,
        );
        if (mode === 'quota') {
            assert.equal(body.HostConfig.NanoCpus, 2e9);
            assert.equal(body.HostConfig.PidsLimit, 128);
        } else {
            assert(!Object.hasOwn(body.HostConfig, 'NanoCpus'));
            assert(!Object.hasOwn(body.HostConfig, 'PidsLimit'));
        }
        if (mode === 'dsm') assert.equal(body.HostConfig.CpusetCpus, '2,3');
        assert.equal(body.HostConfig.Memory, 3 * 1024 ** 3);
        assert.equal(body.HostConfig.NetworkMode, 'none');
        assert(deleted);
        assert.match((await logs.read('ocr')).text, /specific OCR failure/);
    }
});
test('Logs require verified native Basic Auth, reject traversal and download the selected category as text', async (t) => {
    const root = await temp(t);
    const logs = createLogStore({ stateRoot: root, secretRoot: root + '/secrets' });
    await logs.write('ocr', 'ERROR', 'diagnostic detail');
    const gateway = createGateway({
        upstream: 'http://127.0.0.1:18082',
        manifest: {},
        logService: logs,
        aiService: { stop: async () => {} },
        translationService: { stop: async () => {} },
        fetchImpl: async (_url, input) =>
            input.headers.Authorization
                ? Response.json({
                      data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
                  })
                : new Response('', { status: 401 }),
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    const url = `http://127.0.0.1:${gateway.address().port}/private-api/logs/read?category=`;
    assert.equal((await fetch(url + 'ocr')).status, 401);
    const headers = { Authorization: 'Basic ' + Buffer.from('user:pass').toString('base64') };
    const response = await fetch(url + 'ocr&download=1', { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /suwayomi-ocr.log/);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.match(await response.text(), /diagnostic detail/);
    assert.equal((await fetch(url + '../secrets', { headers })).status, 400);
});
