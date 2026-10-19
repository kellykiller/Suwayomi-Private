/* SPDX-License-Identifier: MPL-2.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import {
    dockerContext,
    downloadArchive,
    replaceUiImage,
    addPrivateService,
    portainerClient,
    healthy,
} from '../server/common.mjs';
import { createJob, releaseLock, buildImage, deployTransaction } from '../server/worker.mjs';
import { createGateway, authenticate, sameOrigin } from '../server/gateway.mjs';
import { verifyBackend } from '../server/installer.mjs';

const commit = 'a'.repeat(40),
    nextCommit = 'b'.repeat(40);
const oldImage = 'sha256:' + 'c'.repeat(64),
    newImage = 'sha256:' + 'd'.repeat(64);
const config = {
    repository: 'kellykiller/Suwayomi-Private',
    stackName: 'suwayomi',
    stackId: 1,
    endpointId: 2,
    daemonId: 'daemon',
    serviceName: 'private-ui',
    containerName: 'suwayomi-private-ui',
    hostRoot: '/volume3/docker/suwayomi',
    origins: ['https://reader.example'],
    portainerUrl: 'http://127.0.0.1:9000',
};
const backendCompose = `services:
  suwayomi:
    image: suwayomi:retained-123456789abc
    container_name: suwayomi
    user: "1026:100"
    environment:
      - SERVER_BASIC_AUTH_PASSWORD=unchanged-secret
    volumes:
      - /volume3/docker/suwayomi/data:/home/suwayomi/.local/share/Tachidesk
    ports:
      - "192.168.175.60:18081:4567"
    networks:
      - suwayomi
networks:
  suwayomi:
    driver: bridge
`;
const privateCompose = addPrivateService(backendCompose, config, commit);
function tar(entries) {
    const chunks = [];
    for (const entry of entries) {
        const data = Buffer.from(entry.content || '');
        const h = Buffer.alloc(512);
        h.write(entry.path, 0);
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
        h[156] = (entry.type || '0').charCodeAt(0);
        h.write('ustar\0', 257);
        h.fill(32, 148, 156);
        let sum = 0;
        for (const byte of h) sum += byte;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        chunks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    chunks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(chunks));
}
const required = ['Dockerfile', 'package.json', 'private/server/worker.mjs'].map((path) => ({
    path: 'archive-root/' + path,
    content: 'fixture',
}));
test('Docker context strips the GitHub prefix and rejects traversal, links, mixed roots and missing application files', () => {
    const context = dockerContext(tar(required));
    assert.equal(context.subarray(0, 100).toString().replace(/\0.*$/s, ''), 'Dockerfile');
    for (const extra of [
        { path: 'archive-root/../../secrets', content: 'bad' },
        { path: '/absolute/file', content: 'bad' },
        { path: 'other-root/file', content: 'bad' },
        { path: 'archive-root/link', type: '2', content: '' },
    ])
        assert.throws(() => dockerContext(tar([...required, extra])));
    assert.throws(() => dockerContext(tar(required.slice(1))), /fehlt/);
});
test('Archive downloads do not forward the private GitHub token to the signed codeload URL', async () => {
    const calls = [];
    const archive = await downloadArchive('private-github-token', commit, async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
            ? new Response(null, {
                  status: 302,
                  headers: { location: 'https://codeload.github.com/repository/archive?signature=fixture' },
              })
            : new Response(tar(required), { status: 200 });
    });
    assert(archive.length);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer private-github-token');
    assert.equal(calls[1].options.headers, undefined);
    await assert.rejects(
        downloadArchive(
            'token',
            commit,
            async () => new Response(null, { status: 302, headers: { location: 'http://evil.example/archive' } }),
        ),
        /Unerwartetes/,
    );
});
test('Initial installation changes only the published backend port and adds the private UI without exposing keys', () => {
    assert.match(privateCompose, /192\.168\.175\.60:18082:4567/);
    assert.match(privateCompose, /SERVER_BASIC_AUTH_PASSWORD=unchanged-secret/);
    assert.match(privateCompose, /suwayomi:retained-123456789abc/);
    assert.match(privateCompose, /\/volume3\/docker\/suwayomi\/data:/);
    assert.match(privateCompose, /network_mode: host/);
    assert.match(privateCompose, /SUWAYOMI_UPSTREAM=http:\/\/192\.168\.175\.60:18082/);
    assert.doesNotMatch(privateCompose, /GITHUB_TOKEN|PORTAINER_TOKEN/);
    assert.throws(() => addPrivateService(privateCompose, config, commit), /bereits/);
    assert.throws(
        () =>
            addPrivateService(
                backendCompose.replace('services:', 'services:\n  unrelated:\n    image: busybox'),
                config,
                commit,
            ),
        /zusätzliche/,
    );
});
test('Updates replace exactly the private service image and preserve backend, credentials, ports and mounts', () => {
    const updated = replaceUiImage(privateCompose, 'suwayomi-private:git-' + nextCommit);
    assert.equal(updated.replace(nextCommit, commit), privateCompose);
    assert.throws(() => replaceUiImage(backendCompose, 'suwayomi-private:git-' + nextCommit), /nicht eindeutig/);
    assert.throws(() => replaceUiImage(privateCompose, 'evil:latest'), /Ungültiger/);
});
test('Portainer credentials cannot be redirected or sent to a remote control plane', async () => {
    assert.throws(() => portainerClient('https://example.com', 'token'), /Loopback/);
    let options;
    const api = portainerClient(config.portainerUrl, 'private-portainer-token', async (_, opts) => {
        options = opts;
        return new Response('secret error body', { status: 403 });
    });
    await assert.rejects(
        api('/stacks/1'),
        (error) => error.message.includes('403') && !error.message.includes('secret'),
    );
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-API-Key'], 'private-portainer-token');
});
test('Same-origin writes require a custom header and reject cross-site requests', () => {
    const request = {
        headers: { origin: 'https://reader.example', 'x-suwayomi-private': '1', 'sec-fetch-site': 'same-origin' },
    };
    assert(sameOrigin(request, config.origins));
    assert(!sameOrigin({ headers: { ...request.headers, origin: 'https://evil.example' } }, config.origins));
    assert(!sameOrigin({ headers: { ...request.headers, 'x-suwayomi-private': '' } }, config.origins));
    assert(!sameOrigin({ headers: { ...request.headers, 'sec-fetch-site': 'cross-site' } }, config.origins));
});
test('Administrative access requires verified Suwayomi Basic Auth and extracts the actual server revision', async () => {
    const response = () =>
        new Response(
            JSON.stringify({ data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } } }),
            { status: 200 },
        );
    const result = await authenticate(
        { headers: { authorization: 'Basic fixture' } },
        new URL('http://localhost:4567'),
        async () => response(),
    );
    assert.equal(result.canManage, true);
    assert.equal(result.serverRevision, 2366);
    const missing = await authenticate({ headers: {} }, new URL('http://localhost:4567'), async () => response());
    assert.equal(missing.canManage, false);
    const invalid = await authenticate(
        { headers: {} },
        new URL('http://localhost:4567'),
        async () => new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="fixture"' } }),
    );
    assert.equal(invalid.authorized, false);
});
function deployMock(before) {
    let current = structuredClone(before);
    const puts = [];
    const api = async (path, options = {}) => {
        if (path === '/stacks/1') {
            if (options.method === 'PUT') {
                current = { file: options.body.StackFileContent, env: options.body.Env };
                puts.push(options.body);
                return {};
            }
            return { Id: 1, Name: 'suwayomi', Type: 2, EndpointId: 2, Env: current.env };
        }
        if (path === '/stacks/1?endpointId=2') {
            current = { file: options.body.StackFileContent, env: options.body.Env };
            puts.push(options.body);
            return {};
        }
        if (path === '/stacks/1/file') return { StackFileContent: current.file };
        if (path === '/endpoints/2/docker/info') return { ID: 'daemon' };
        throw new Error('Unexpected route: ' + path);
    };
    return {
        api,
        puts,
        get: () => current,
        change: (value) => {
            current = value;
        },
    };
}
test('A failed start restores and verifies the previous private image without pulling or pruning services', async () => {
    const before = { file: privateCompose, env: [{ name: 'KEY', value: 'unchanged' }] };
    const after = { ...before, file: replaceUiImage(privateCompose, 'suwayomi-private:git-' + nextCommit) };
    const fixture = deployMock(before);
    const checks = [];
    await assert.rejects(
        deployTransaction(fixture.api, config, before, after, oldImage, newImage, async (_, __, image) => {
            checks.push(image);
            if (image === newImage) throw new Error('bad health');
        }),
        /bisherige Version wiederhergestellt/,
    );
    assert.deepEqual(fixture.get(), before);
    assert.deepEqual(checks, [newImage, oldImage]);
    assert.equal(fixture.puts.length, 2);
    assert(fixture.puts.every((value) => !value.PullImage && !value.Prune));
});
test('Concurrent stack edits prevent deployment and prevent an unsafe rollback overwrite', async () => {
    const before = { file: privateCompose, env: [] },
        after = { ...before, file: replaceUiImage(privateCompose, 'suwayomi-private:git-' + nextCommit) },
        changed = { ...before, file: privateCompose + '# manual change\n' };
    const fixture = deployMock(changed);
    await assert.rejects(
        deployTransaction(fixture.api, config, before, after, oldImage, newImage, async () => {}),
        /während des Builds geändert/,
    );
    assert.equal(fixture.puts.length, 0);
    const second = deployMock(before);
    await assert.rejects(
        deployTransaction(second.api, config, before, after, oldImage, newImage, async () => {
            second.change(changed);
            throw new Error('health');
        }),
        /Rückfall wurde ausgesetzt/,
    );
    assert.deepEqual(second.get(), changed);
});
test('Docker build streams detect an HTTP-200 build failure and do not accept a stale image', async () => {
    let imageLookups = 0;
    const logs = [];
    await assert.rejects(
        buildImage(
            async (path) => {
                if (path.includes('/build?'))
                    return new Response('{"stream":"build started"}\n{"error":"compilation failed"}\n');
                imageLookups++;
                return { Id: newImage };
            },
            config,
            Buffer.from('context'),
            commit,
            async (line) => logs.push(line),
        ),
        /Docker-Build fehlgeschlagen/,
    );
    assert.equal(imageLookups, 0);
    assert(logs.includes('compilation failed'));
});
test('A background update uses the current image, host networking and read-only secrets, and prevents duplicate jobs', async (t) => {
    const root = await fs.mkdtemp(tmpdir() + '/suwayomi-update-test-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let payload;
    const api = async (path, options = {}) => {
        if (path.includes('/suwayomi-private-ui/json'))
            return {
                Image: oldImage,
                Config: {
                    Labels: { 'com.docker.compose.project': 'suwayomi', 'com.docker.compose.service': 'private-ui' },
                },
            };
        if (path.includes('/containers/create?')) {
            payload = options.body;
            return { Id: 'e'.repeat(64) };
        }
        if (path.endsWith('/start')) return null;
        throw new Error('Unexpected route');
    };
    const job = await createJob(config, api, 'update', nextCommit, 2366, { root });
    assert.equal(payload.Image, oldImage);
    assert.equal(payload.HostConfig.NetworkMode, 'host');
    assert.equal(payload.HostConfig.ReadonlyRootfs, true);
    assert(payload.HostConfig.Binds.includes('/volume3/docker/suwayomi/secrets:/secrets:ro'));
    assert.equal(payload.HostConfig.AutoRemove, true);
    assert.equal((await fs.stat(root + '/jobs/' + job.id + '.json')).mode & 0o777, 0o600);
    await assert.rejects(createJob(config, api, 'update', nextCommit, 2366, { root }), /läuft bereits/);
    await releaseLock('wrong-id', root);
    assert(await fs.stat(root + '/private-update.lock'));
    await releaseLock(job.id, root);
    await assert.rejects(fs.stat(root + '/private-update.lock'), { code: 'ENOENT' });
});
test('Backend verification rejects changed authentication or data while preserving the server image', () => {
    const before = {
        Image: oldImage,
        Config: { User: '1026:100', Env: ['AUTH=kept'] },
        Mounts: [{ Source: '/volume3/docker/suwayomi/data' }],
    };
    const after = {
        ...structuredClone(before),
        State: { Status: 'running' },
        HostConfig: { PortBindings: { '4567/tcp': [{ HostIp: '192.168.175.60', HostPort: '18082' }] } },
    };
    verifyBackend(after, before);
    after.Config.Env = ['AUTH=changed'];
    assert.throws(() => verifyBackend(after, before), /Zugang/);
});

async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
}
async function fixture(t) {
    const webRoot = await fs.mkdtemp(tmpdir() + '/suwayomi-gateway-test-');
    t.after(() => fs.rm(webRoot, { recursive: true, force: true }));
    await fs.writeFile(webRoot + '/index.html', 'PRIVATE-UI');
    const auth = 'Basic ' + Buffer.from('fixture:password').toString('base64');
    const backend = http.createServer(async (req, res) => {
        for await (const _ of req) {
        }
        if (req.headers.authorization !== auth) {
            res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' });
            res.end();
            return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
                authorizationSeen: req.headers.authorization,
            }),
        );
    });
    backend.on('upgrade', (req, socket) => {
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n',
        );
        socket.on('data', (data) => socket.write(data));
    });
    const upstream = await listen(backend);
    const gateway = createGateway({
        upstream,
        webRoot,
        manifest: { commit, version: '0.1.0' },
        configLoader: async () => config,
        secretLoader: async () => ({ github: 'never-return-github', portainer: 'never-return-portainer' }),
        jobReader: async () => null,
        stateExists: async () => false,
    });
    const sockets = new Set();
    for (const server of [gateway, backend])
        server.on('connection', (socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
    const url = await listen(gateway);
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        gateway.closeAllConnections();
        backend.closeAllConnections();
        await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => backend.close(r))]);
    });
    return { url, auth };
}
test('The private UI offers the login form, preserves verified native credentials and never returns saved keys', async (t) => {
    const f = await fixture(t);
    const missing = await fetch(f.url + '/settings/private-updates');
    assert.equal(missing.status, 200);
    assert.equal(missing.headers.get('www-authenticate'), null);
    assert.match(await missing.text(), /autocomplete="current-password"/);
    assert.equal(
        await (await fetch(f.url + '/settings/private-updates', { headers: { Authorization: f.auth } })).text(),
        'PRIVATE-UI',
    );
    const status = await fetch(f.url + '/private-api/status', { headers: { Authorization: f.auth } });
    assert.equal(status.status, 200);
    const text = await status.text();
    assert(!text.includes('never-return'));
    assert.equal(JSON.parse(text).configured.github, true);
});
test('Cross-origin update requests are rejected before any Docker action', async (t) => {
    const f = await fixture(t);
    const result = await fetch(f.url + '/private-api/update', {
        method: 'POST',
        headers: {
            Authorization: f.auth,
            Origin: 'https://evil.example',
            'Content-Type': 'application/json',
            'X-Suwayomi-Private': '1',
        },
        body: JSON.stringify({ commit: nextCommit }),
    });
    assert.equal(result.status, 403);
});
test('Absolute-form proxy requests cannot forward credentials to an arbitrary destination', async (t) => {
    const f = await fixture(t);
    const status = await new Promise((resolve, reject) => {
        const request = http.request(
            f.url,
            { path: 'http://evil.example/api/graphql', headers: { Authorization: f.auth } },
            (response) => {
                response.resume();
                resolve(response.statusCode);
            },
        );
        request.on('error', reject);
        request.end();
    });
    assert.equal(status, 400);
});
test('Native API calls and WebSocket subscriptions are passed through the gateway', { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.url + '/api/graphql', {
        method: 'POST',
        headers: { Authorization: f.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'fixture' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).authorizationSeen, f.auth);
    await new Promise((resolve, reject) => {
        const req = http.request(f.url + '/api/graphql', {
            headers: {
                Authorization: f.auth,
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Protocol': 'graphql-transport-ws',
            },
        });
        req.on('upgrade', (res, socket) => {
            assert.equal(res.headers['sec-websocket-protocol'], 'graphql-transport-ws');
            socket.on('data', (data) => {
                assert.equal(data.toString(), 'fixture-message');
                socket.destroy();
                resolve();
            });
            socket.on('error', reject);
            socket.write('fixture-message');
        });
        req.on('error', reject);
        req.end();
    });
});
