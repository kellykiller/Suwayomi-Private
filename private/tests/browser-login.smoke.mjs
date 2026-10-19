/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createGateway } from '../server/gateway.mjs';
import { createSessionStore, SESSION_COOKIE } from '../server/browser-auth.mjs';

const { chromium } = await import(
    pathToFileURL(process.env.LOGIN_PLAYWRIGHT + '/node_modules/playwright/index.mjs').href
);
const root = await fs.mkdtemp(tmpdir() + '/suwayomi-login-browser-');
const screenshots = process.env.LOGIN_SCREENSHOTS || '/tmp/suwayomi-login-previews';
await fs.mkdir(screenshots, { recursive: true });
await fs.writeFile(
    root + '/index.html',
    '<!doctype html><html><head><title>Library</title></head><body><h1>Bibliothek bereit</h1></body></html>',
);
const authorization = 'Basic ' + Buffer.from('fixture:browser-test-password').toString('base64');
const sockets = new Set();
const backend = http.createServer(async (req, res) => {
    for await (const _ of req) {
        /* drain the request */
    }
    if (req.headers.authorization !== authorization) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
        res.end();
        return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } } }));
});
const listen = async (server) => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
};
const upstream = await listen(backend),
    config = { origins: [] };
const gateway = createGateway({
    upstream,
    webRoot: root,
    manifest: { version: '0.5.3' },
    configLoader: async () => config,
    sessionStore: createSessionStore({ root: root + '/sessions' }),
    logService: { write: async () => {} },
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
config.origins = [url];
const browser = await chromium.launch({
    executablePath: process.env.LOGIN_CHROME || '/usr/bin/google-chrome',
    headless: true,
});
try {
    for (const [name, viewport, colorScheme] of [
        ['ipad-light', { width: 768, height: 1024 }, 'light'],
        ['mobile-light', { width: 390, height: 844 }, 'light'],
        ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
    ]) {
        const context = await browser.newContext({ viewport, colorScheme, hasTouch: viewport.width < 1000 });
        const page = await context.newPage(),
            errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(url + '/library');
        assert(new URL(page.url()).pathname === '/auth/login');
        assert.equal(await page.getByLabel('Benutzername', { exact: true }).getAttribute('autocomplete'), 'username');
        assert.equal(
            await page.getByLabel('Passwort', { exact: true }).getAttribute('autocomplete'),
            'current-password',
        );
        const layout = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            main: document.querySelector('main').getBoundingClientRect().toJSON(),
        }));
        assert(layout.scrollWidth <= layout.width && layout.main.x >= 0 && layout.main.y >= 0, JSON.stringify(layout));
        await page.screenshot({ path: screenshots + '/' + name + '.png', fullPage: true });
        await page.getByRole('button', { name: 'Anzeigen', exact: true }).click();
        assert.equal(await page.getByLabel('Passwort', { exact: true }).getAttribute('type'), 'text');
        await page.getByRole('button', { name: 'Verbergen', exact: true }).click();
        await page.getByLabel('Benutzername', { exact: true }).fill('fixture');
        await page.getByLabel('Passwort', { exact: true }).fill('browser-test-password');
        await page.getByLabel('Angemeldet bleiben (30 Tage)').check();
        await Promise.all([
            page.waitForURL(url + '/library'),
            page.getByLabel('Passwort', { exact: true }).press('Enter'),
        ]);
        assert.equal(await page.locator('h1').textContent(), 'Bibliothek bereit');
        const cookie = (await context.cookies()).find((value) => value.name === SESSION_COOKIE);
        assert(cookie?.httpOnly && cookie.expires * 1000 > Date.now() + 29 * 86400000);
        assert(!(await page.evaluate(() => document.cookie)).includes(SESSION_COOKIE));
        assert.equal(await page.evaluate(async () => (await fetch('/api/graphql')).status), 200);
        await page.reload();
        assert.equal(await page.locator('h1').textContent(), 'Bibliothek bereit');
        await page.goto(url + '/auth/account');
        await Promise.all([
            page.waitForURL(url + '/auth/login'),
            page.getByRole('button', { name: 'Abmelden', exact: true }).click(),
        ]);
        await page.goto(url + '/library');
        assert(new URL(page.url()).pathname === '/auth/login');
        assert.deepEqual(errors, []);
        console.log(name + ': native form submit, cookie, reload, API, logout and layout passed');
        await context.close();
    }
} finally {
    await browser.close();
    for (const socket of sockets) socket.destroy();
    gateway.closeAllConnections();
    backend.closeAllConnections();
    await Promise.all([
        new Promise((resolve) => gateway.close(resolve)),
        new Promise((resolve) => backend.close(resolve)),
    ]);
    await fs.rm(root, { recursive: true, force: true });
}
