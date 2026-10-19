/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createGateway } from '../server/gateway.mjs';
import { createSessionStore, SESSION_COOKIE, sessionCookie, returnPath, loginPage } from '../server/browser-auth.mjs';

const authorization = 'Basic ' + Buffer.from('fixture:private-password').toString('base64');
async function temp(t) {
    const root = await fs.mkdtemp(tmpdir() + '/suwayomi-login-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
const listen = async (server) => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
};
const cookieHeader = (response) => response.headers.get('set-cookie').split(';')[0];

test('Sessions survive a gateway restart with encrypted credentials and can be revoked independently', async (t) => {
    const root = await temp(t),
        store = createSessionStore({ root });
    const token = await store.issue(authorization, true),
        other = await store.issue(authorization, false);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    for (const name of await fs.readdir(root)) {
        const bytes = await fs.readFile(root + '/' + name);
        assert(!bytes.toString().includes('private-password'));
        assert(!bytes.toString().includes(authorization));
        assert(!bytes.toString().includes(token));
        assert.equal((await fs.stat(root + '/' + name)).mode & 0o777, 0o600);
    }
    const restarted = createSessionStore({ root });
    assert.equal((await restarted.read(token)).authorization, authorization);
    await restarted.revoke(token);
    assert.equal(await store.read(token), null);
    assert.equal((await store.read(other)).authorization, authorization);
});
test('Expired and tampered sessions fail closed, including duplicate cookies and unsafe return URLs', async (t) => {
    const root = await temp(t);
    let now = 100000;
    const store = createSessionStore({ root, now: () => now });
    const token = await store.issue(authorization, false);
    now += 12 * 3600000;
    assert.equal(await store.read(token), null);
    await store.issue(authorization, true);
    const file = (await fs.readdir(root)).find((name) => name.endsWith('.json'));
    const record = JSON.parse(await fs.readFile(root + '/' + file, 'utf8'));
    record.data = record.data.slice(0, -4) + 'AAAA';
    await fs.writeFile(root + '/' + file, JSON.stringify(record));
    const remembered = await store.issue(authorization, true);
    assert.equal(await store.read('../key'), null);
    assert.equal(
        sessionCookie({ headers: { cookie: `${SESSION_COOKIE}=${remembered}; ${SESSION_COOKIE}=other` } }),
        'invalid',
    );
    for (const value of [
        'https://evil.example',
        '//evil.example',
        '/\\evil.example',
        '/%2f%2fevil.example',
        '/%5cevil.example',
        '/auth/logout',
        '/%0d%0aLocation:bad',
    ])
        assert.equal(returnPath(value), '/');
    assert.equal(returnPath('/manga/7?chapter=8#page=3'), '/manga/7?chapter=8#page=3');
    const tampered = createSessionStore({ root });
    // A stolen ciphertext cannot be moved to a different session record (AAD binds the token).
    const files = (await fs.readdir(root)).filter((name) => name.endsWith('.json'));
    const otherFile = files.find((name) => name !== file);
    await fs.copyFile(root + '/' + file, root + '/' + otherFile);
    assert.equal(await tampered.read(remembered), null);
});
async function fixture(t) {
    const root = await temp(t);
    await fs.writeFile(
        root + '/index.html',
        '<!doctype html><html><head><title>Library</title></head><body>PRIVATE-UI</body></html>',
    );
    const calls = [],
        sockets = new Set();
    let backendAuth = authorization;
    const backend = http.createServer(async (req, res) => {
        for await (const _ of req) {
            /* drain the test request */
        }
        calls.push({ path: req.url, headers: req.headers });
        assert(!String(req.headers.cookie).includes(SESSION_COOKIE));
        if (req.headers.authorization !== backendAuth) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="backend"' });
            res.end();
            return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
            JSON.stringify({
                data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } },
                ok: true,
            }),
        );
    });
    backend.on('upgrade', (req, socket) => {
        calls.push({ path: req.url, headers: req.headers, websocket: true });
        if (req.headers.authorization !== backendAuth) {
            socket.end(
                'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="backend"\r\nConnection: close\r\n\r\n',
            );
            return;
        }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', (data) => socket.write(data));
    });
    const upstream = await listen(backend),
        config = { origins: [], portainerUrl: 'http://127.0.0.1:9000' };
    const sessionRoot = root + '/sessions';
    const gateway = createGateway({
        upstream,
        webRoot: root,
        manifest: { version: '0.5.3' },
        sessionStore: createSessionStore({ root: sessionRoot }),
        configLoader: async () => config,
        secretLoader: async () => ({ github: 'hidden-github', portainer: 'hidden-portainer' }),
        jobReader: async () => null,
        stateExists: async () => false,
        logService: {
            write: async (...args) => {
                assert(!JSON.stringify(args).includes('private-password'));
            },
        },
        aiService: { stop: async () => {} },
        translationService: { stop: async () => {} },
        cloudTranslationService: { stop: async () => {} },
    });
    for (const server of [gateway, backend])
        server.on('connection', (socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
    const url = await listen(gateway);
    config.origins = [url, 'https://reader.example'];
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        gateway.closeAllConnections();
        backend.closeAllConnections();
        await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => backend.close(r))]);
    });
    const post = (path, fields = {}, headers = {}) =>
        fetch(url + path, {
            method: 'POST',
            redirect: 'manual',
            headers: { Origin: url, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
            body: new URLSearchParams(fields),
        });
    const login = (fields, headers) =>
        post(
            '/auth/login',
            { username: 'fixture', password: 'private-password', next: '/library', ...fields },
            headers,
        );
    return {
        url,
        calls,
        login,
        post,
        sessionRoot,
        changePassword: () => {
            backendAuth = 'Basic changed';
        },
    };
}
test('Native login form supports password managers and touch layouts without a Basic challenge', async (t) => {
    const f = await fixture(t);
    const missing = await fetch(f.url + '/manga/17?chapter=2', {
        redirect: 'manual',
        headers: { Accept: 'text/html', Authorization: authorization },
    });
    assert.equal(missing.status, 303);
    assert.equal(missing.headers.get('www-authenticate'), null);
    assert.equal(missing.headers.get('location'), '/auth/login?next=%2Fmanga%2F17%3Fchapter%3D2');
    const page = await fetch(f.url + missing.headers.get('location'));
    const content = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
    assert.match(page.headers.get('cache-control'), /no-store/);
    for (const pattern of [
        /method="post" action="\/auth\/login"/,
        /name="username" type="text" autocomplete="username"/,
        /name="password" type="password" autocomplete="current-password"/,
        /name="remember"/,
        /name="next" value="\/manga\/17\?chapter=2"/,
        /type="submit">Anmelden/,
    ])
        assert.match(content, pattern);
    assert(!content.includes('localStorage'));
    assert(!loginPage({ username: '<script>alert(1)</script>', error: '<img src=x>' }).html.includes('<script>alert'));
});
test('Successful form login uses an opaque HttpOnly cookie for UI, private APIs and native page requests', async (t) => {
    const f = await fixture(t),
        result = await f.login({ remember: '1', next: '/manga/17?chapter=2' });
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), '/manga/17?chapter=2');
    const setCookie = result.headers.get('set-cookie'),
        cookie = cookieHeader(result);
    assert.match(setCookie, /HttpOnly; SameSite=Lax; Max-Age=2592000/);
    assert(!setCookie.includes('Secure'));
    assert(!setCookie.includes('private-password'));
    assert(!setCookie.includes(authorization));
    const headers = { Cookie: cookie };
    const page = await fetch(f.url + '/library', { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script src="\/auth\/client.js"><\/script>/);
    for (const path of ['/api/graphql', '/api/v1/chapter/17/page/0', '/private-api/status']) {
        const response = await fetch(f.url + path, { headers });
        assert.equal(response.status, 200, path);
        assert(!(await response.text()).includes('hidden-github'));
    }
    assert(f.calls.filter((c) => c.headers.authorization === authorization).length >= 4);
    assert.equal((await fetch(f.url + '/auth/account', { headers })).status, 200);
    const client = await (await fetch(f.url + '/auth/client.js')).text();
    assert.match(client, /response.status===401/);
});
test('HTTPS login sets Secure and session-only login has no persistent Max-Age', async (t) => {
    const f = await fixture(t),
        result = await f.login({}, { Origin: 'https://reader.example' });
    assert.equal(result.status, 303);
    assert.match(result.headers.get('set-cookie'), /; Secure/);
    assert(!result.headers.get('set-cookie').includes('Max-Age'));
});
test('Wrong credentials, duplicate fields, oversized forms, cross-site login/logout and open redirects are rejected', async (t) => {
    const f = await fixture(t);
    const wrong = await f.login({ password: 'incorrect-secret' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('www-authenticate'), null);
    assert.equal(wrong.headers.get('set-cookie'), null);
    assert(!(await wrong.text()).includes('incorrect-secret'));
    const before = f.calls.length;
    for (const path of ['/auth/login', '/auth/logout']) {
        assert.equal((await f.post(path, {}, { Origin: 'https://evil.example' })).status, 403);
        assert.equal((await f.post(path, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    }
    assert.equal(f.calls.length, before);
    assert.equal((await f.login({ password: 'x'.repeat(9000) })).status, 413);
    const duplicate = await fetch(f.url + '/auth/login', {
        method: 'POST',
        headers: { Origin: f.url, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=fixture&username=evil&password=private-password',
    });
    assert.equal(duplicate.status, 400);
    assert.equal((await f.login({ next: '//evil.example' })).headers.get('location'), '/');
});
test('Logout revokes the actual server session, suppresses cached browser Basic credentials and preserves another device', async (t) => {
    const f = await fixture(t),
        first = cookieHeader(await f.login()),
        second = cookieHeader(await f.login());
    const result = await f.post('/auth/logout', {}, { Cookie: first });
    assert.equal(result.status, 303);
    assert.match(result.headers.get('set-cookie'), /=logged-out/);
    for (const cookie of [first, cookieHeader(result)]) {
        const response = await fetch(f.url + '/api/graphql', {
            headers: { Cookie: cookie, Authorization: authorization },
        });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('www-authenticate'), null);
    }
    assert.equal((await fetch(f.url + '/api/graphql', { headers: { Cookie: second } })).status, 200);
});
test('Backend password changes invalidate the session without triggering a browser popup', async (t) => {
    const f = await fixture(t),
        cookie = cookieHeader(await f.login());
    f.changePassword();
    const response = await fetch(f.url + '/api/graphql', { headers: { Cookie: cookie } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.match(response.headers.get('set-cookie'), /=logged-out/);
    assert.equal(await createSessionStore({ root: f.sessionRoot }).read(cookie.split('=')[1]), null);
});
test('Repeated failed logins are throttled before another backend check', async (t) => {
    const f = await fixture(t);
    for (let n = 0; n < 20; n++) assert.equal((await f.login({ password: 'incorrect' })).status, 401);
    const before = f.calls.length,
        response = await f.login();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '300');
    assert.equal(f.calls.length, before);
});
test(
    'Cookie-authenticated WebSocket connections forward native auth, reject foreign origins and close on logout',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t),
            cookie = cookieHeader(await f.login());
        const ws = (origin) =>
            new Promise((resolve, reject) => {
                const req = http.request(f.url + '/api/graphql', {
                    headers: { Origin: origin, Cookie: cookie, Connection: 'Upgrade', Upgrade: 'websocket' },
                });
                req.on('upgrade', (_, socket) => resolve({ socket, status: 101 }));
                req.on('response', (res) => {
                    res.resume();
                    resolve({ status: res.statusCode });
                });
                req.on('error', reject);
                req.end();
            });
        assert.equal((await ws('https://evil.example')).status, 403);
        const { socket, status } = await ws(f.url);
        assert.equal(status, 101);
        const echoed = new Promise((resolve) => socket.once('data', (data) => resolve(data.toString())));
        socket.write('message');
        assert.equal(await echoed, 'message');
        assert.equal(f.calls.find((c) => c.websocket).headers.authorization, authorization);
        const closed = new Promise((resolve) => socket.once('close', resolve));
        await f.post('/auth/logout', {}, { Cookie: cookie });
        await closed;
    },
);
