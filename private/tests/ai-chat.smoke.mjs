/* SPDX-License-Identifier: MPL-2.0 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createGateway } from '../server/gateway.mjs';
import { createAiService } from '../server/ai.mjs';
import { createSessionStore, SESSION_COOKIE } from '../server/browser-auth.mjs';
import { createLogStore } from '../server/logs.mjs';
const { chromium } = await import(
    pathToFileURL(process.env.LOGIN_PLAYWRIGHT + '/node_modules/playwright/index.mjs').href
);
const root = await fs.mkdtemp(tmpdir() + '/suwayomi-chat-browser-');
await fs.mkdir(root + '/secrets');
const authorization = 'Basic ' + Buffer.from('fixture:browser-password').toString('base64');
let modelCalls = 0;
const bodies = [];
const json = (value) => Response.json(value);
const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (String(url) === 'https://api.openai.com/v1/responses') {
        modelCalls++;
        bodies.push(body);
        const titles = modelCalls === 1 ? ['Naruto', 'One Piece'] : modelCalls === 2 ? ['Bleach'] : [];
        const answer =
            modelCalls === 3
                ? 'Die Abenteuerhandlung und die Hauptgruppe passen zu deinem Wunsch.'
                : 'Hier sind passende Vorschläge.';
        return json({
            status: 'completed',
            usage: { input_tokens: 100, output_tokens: 80 },
            output: [
                {
                    type: 'message',
                    content: [
                        {
                            type: 'output_text',
                            text: JSON.stringify({
                                summary: answer,
                                criteria: ['Abenteuer'],
                                notice: '',
                                recommendations: titles.map((title) => ({
                                    title,
                                    aliases: [],
                                    reason: 'Passt zu deiner Suche.',
                                    caveat: '',
                                })),
                            }),
                        },
                    ],
                },
            ],
        });
    }
    assert(String(url).startsWith('http://127.0.0.1:18082/'));
    assert.equal(options.headers.Authorization || options.headers.authorization, authorization);
    if (body.query.includes('query AiSources'))
        return json({ data: { sources: { nodes: [{ id: '1', displayName: 'Testquelle', lang: 'en' }] } } });
    if (body.query.includes('mutation AiSourceSearch')) {
        const title = body.variables.input.query;
        return json({
            data: {
                fetchSourceManga: {
                    hasNextPage: false,
                    mangas: [
                        {
                            id: title === 'Naruto' ? 10 : title === 'One Piece' ? 20 : 30,
                            title,
                            inLibrary: false,
                        },
                    ],
                },
            },
        });
    }
    if (body.query.includes('mutation AiMatchDetails')) {
        return json({
            data: {
                fetchMangaAndChapters: {
                    manga: { id: body.variables.id },
                    chapters: body.variables.id === 20 ? [] : [{ id: 1, chapterNumber: 1 }],
                },
            },
        });
    }
    return json({ data: { settings: { authMode: 'BASIC_AUTH' }, aboutServer: { version: 'v2.4.2366' } } });
};
const ai = createAiService({
    upstream: 'http://127.0.0.1:18082',
    stateRoot: root,
    secretRoot: root + '/secrets',
    fetchImpl,
    requestDelay: 0,
    cooldown: 0,
});
await ai.save({ key: 'sk-proj-' + 'testOnly'.repeat(6), enabled: true });
const sessions = createSessionStore({ root: root + '/sessions' });
const token = await sessions.issue(authorization, true),
    config = { origins: [] };
const logs = createLogStore({ stateRoot: root, secretRoot: root + '/secrets' });
await logs.write('system', 'INFO', 'NAS migration browser fixture');
const gateway = createGateway({
    upstream: 'http://127.0.0.1:18082',
    webRoot: '/tmp/suwayomi-ai-chat-build',
    manifest: { version: '0.5.5' },
    fetchImpl,
    sessionStore: sessions,
    aiService: ai,
    configLoader: async () => config,
    logService: logs,
    translationService: { stop: async () => {}, busy: () => false },
    cloudTranslationService: { stop: async () => {}, busy: () => false },
});
const sockets = new Set();
gateway.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + gateway.address().port;
config.origins = [url];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true });
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url + '/sources/ai-search');
    const message = page.getByLabel('Was möchtest du lesen?', { exact: true });
    await message.fill('Abenteuer mit einer festen Hauptgruppe');
    const count = page.getByLabel('Maximale Vorschläge pro Antwort', { exact: true });
    for (const value of ['0', '101', '2.5', '']) {
        await count.fill(value);
        assert.equal(await page.getByRole('button', { name: 'Nachricht senden', exact: true }).isDisabled(), true);
    }
    await count.fill('13');
    await message.press('Shift+Enter');
    assert.equal(modelCalls, 0);
    await message.press('Enter');
    await page.getByRole('button', { name: 'Mehr wie dieser Titel', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Nachricht senden', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('textarea:not([aria-hidden])')?.disabled === false);
    assert.equal(await page.getByRole('heading', { name: '2. One Piece', exact: true }).count(), 0);
    assert.equal(bodies[0].text.format.schema.properties.recommendations.maxItems, 13);
    await page.getByRole('button', { name: 'Mehr wie dieser Titel', exact: true }).first().click();
    assert.equal(modelCalls, 1);
    const followUp = page.getByLabel('Nachricht an die KI', { exact: true });
    assert.match(await followUp.inputValue(), /Naruto/);
    await count.fill('3');
    await followUp.press('Enter');
    await page.getByRole('heading', { name: '1. Bleach', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea:not([aria-hidden])')?.disabled === false);
    assert.equal(bodies[1].input[1].role, 'assistant');
    assert.match(bodies[1].input[1].content, /Naruto/);
    assert.equal(bodies[1].text.format.schema.properties.recommendations.maxItems, 3);
    await page.reload();
    await page.getByRole('heading', { name: '1. Bleach', exact: true }).waitFor();
    assert.equal(modelCalls, 2);
    await page.getByLabel('Nachricht an die KI', { exact: true }).fill('Warum passen diese Vorschläge?');
    await page.getByRole('button', { name: 'Nachricht senden', exact: true }).click();
    await page
        .getByText('Die Abenteuerhandlung und die Hauptgruppe passen zu deinem Wunsch.', { exact: true })
        .waitFor();
    assert.equal(modelCalls, 3);
    const layout = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    assert(layout.content <= layout.width, JSON.stringify(layout));
    const screenshot = await page.screenshot({ fullPage: true });
    console.log('AI_CHAT_PREVIEW_BASE64:' + screenshot.toString('base64'));
    await page.getByRole('button', { name: 'Neues Gespräch', exact: true }).click();
    assert.equal(await page.getByLabel('Was möchtest du lesen?', { exact: true }).inputValue(), '');
    const saved = page.getByRole('combobox', { name: 'Gespeichertes Gespräch öffnen', exact: true });
    await saved.click();
    await page.getByRole('option', { name: /Abenteuer mit einer festen Hauptgruppe/ }).click();
    await page
        .getByText('Die Abenteuerhandlung und die Hauptgruppe passen zu deinem Wunsch.', { exact: true })
        .waitFor();
    assert.equal(modelCalls, 3);
    assert.deepEqual(errors, []);
    let allowFailed = false;
    const chapterCalls = [];
    await page.route('**/api/graphql', async (route) => {
        const { variables } = route.request().postDataJSON();
        chapterCalls.push(variables.id);
        if (variables.id === 102 && !allowFailed) {
            await route.fulfill({ status: 503, body: '' });
            return;
        }
        await route.fulfill({
            json: {
                data: {
                    fetchMangaAndChapters: {
                        chapters: variables.id === 100 ? [] : [{ id: variables.id }],
                    },
                },
            },
        });
    });
    await page.goto(url + '/availability-test');
    await page.getByText('Prüfung abgeschlossen', { exact: true }).waitFor();
    assert.deepEqual(
        await page.getByRole('list', { name: 'Verfügbare Manga' }).getByRole('listitem').allTextContents(),
        ['Lesbar'],
    );
    await page.getByText(/Bei 1 Titeln konnten die Kapitel/).waitFor();
    allowFailed = true;
    await page.getByRole('button', { name: 'Erneut prüfen', exact: true }).click();
    await page.getByText('Fehler', { exact: true }).waitFor();
    assert.equal(chapterCalls.filter((id) => id === 100).length, 1);
    assert.equal(chapterCalls.filter((id) => id === 101).length, 1);
    assert.equal(chapterCalls.filter((id) => id === 102).length, 2);
    await page.getByRole('button', { name: 'Suche wechseln', exact: true }).click();
    await page.getByText('Andere Suche', { exact: true }).waitFor();
    assert.deepEqual(
        await page.getByRole('list', { name: 'Verfügbare Manga' }).getByRole('listitem').allTextContents(),
        ['Andere Suche'],
    );
    assert.deepEqual(errors, []);
    console.log(
        'Chapter filter: real hook, verified-only results, empty/failed distinction, retry, cache and search change passed',
    );
    console.log(
        'AI chat: real components, numeric limit, Enter/Shift+Enter, follow-up context, ordinary answer, reload and saved conversation passed; 0 live provider calls',
    );
    await page.addInitScript(() => localStorage.setItem('suwayomi-translation-reader', 'de'));
    let translationMode = 'none';
    await page.route('**/private-api/translations/chapter/34', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (translationMode === 'error') {
            await route.fulfill({ status: 503, json: { error: 'Stored lookup failed' } });
            return;
        }
        await route.fulfill({
            json: {
                available:
                    translationMode === 'full'
                        ? { id: 'fixture', revision: 1, pageCount: 1, translatedPages: 1, pages: ['/local.png'] }
                        : null,
            },
        });
    });
    await page.goto(url + '/reader-regression');
    await page.getByText('Original-Aufrufe: 1', { exact: true }).waitFor();
    await page.getByText('Original gewählt', { exact: true }).waitFor();
    translationMode = 'full';
    await page.reload();
    await page.getByText('Übersetzte Seiten', { exact: true }).waitFor();
    assert.equal(await page.getByText('Original-Aufrufe: 0', { exact: true }).count(), 1);
    translationMode = 'error';
    await page.reload();
    await page.getByText('Original-Aufrufe: 1', { exact: true }).waitFor();
    await page.route('**/private-api/translations/statuses?mangaId=7', (route) =>
        route.fulfill({
            json: {
                mangaId: 7,
                statuses: [
                    { chapterId: 34, state: 'translated', translatedPages: 20, pageCount: 20 },
                    { chapterId: 36, state: 'partial', translatedPages: 1, pageCount: 20 },
                    { chapterId: 38, state: 'retained', translatedPages: 20, pageCount: 20 },
                ],
            },
        }),
    );
    await page.goto(url + '/chapter-badges');
    await page.getByText('Bereits übersetzt · Deutsch', { exact: true }).waitFor();
    assert.equal(
        await page
            .getByRole('region', { name: 'Kapitel 35', exact: true })
            .getByText(/übersetzt/i)
            .count(),
        0,
    );
    await page.getByText('Teilübersetzt · 1/20 Seiten', { exact: true }).waitFor();
    await page.getByText('Übersetzt · mit offenen Stellen', { exact: true }).waitFor();
    await page.goto(url + '/logs-test');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Alle Logs als ZIP herunterladen', exact: true }).click();
    const downloaded = await downloadPromise;
    assert.match(downloaded.suggestedFilename(), /^suwayomi-logs-.*\.zip$/);
    assert.equal((await fs.readFile(await downloaded.path())).readUInt32LE(0), 0x04034b50);
    assert.deepEqual(errors, []);
    console.log(
        'NAS features: original fallback after missing/failed translation, translated mode, exact chapter badges and real ZIP download passed',
    );
} finally {
    await browser.close();
    for (const socket of sockets) socket.destroy();
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    await gateway.shutdownPrivate();
    await fs.rm(root, { recursive: true, force: true });
}
