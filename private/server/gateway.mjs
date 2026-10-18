/* SPDX-License-Identifier: MPL-2.0 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
    BASE,
    REPOSITORY,
    UI_CONTAINER,
    UI_SERVICE,
    UPSTREAM,
    assert,
    sha,
    exists,
    readJson,
    writeJson,
    loadConfig,
    secrets,
    portainerClient,
    resolveCommit,
    projectManifest,
    stackState,
    inspect,
} from './common.mjs';
import { activeJob, createJob, jobIdValid } from './worker.mjs';
import { createAiService } from './ai.mjs';
import { createTranslationService } from './translation.mjs';
import { createImageWorker } from './translation-worker.mjs';
import { createTaskService } from './tasks.mjs';
import { createLibraryExportService } from './library-export.mjs';
import { createCloudTranslationService } from './cloud-translations.mjs';
import { createLogStore, LOG_CATEGORIES } from './logs.mjs';

const hop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
function proxyHeaders(headers, upstream) {
    const excluded = new Set([
        ...hop,
        ...String(headers.connection || '')
            .split(',')
            .map((value) => value.trim().toLowerCase()),
    ]);
    return {
        ...Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key))),
        host: upstream.host,
    };
}
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
};
function json(res, status, value) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
}
async function body(req, maximum = 16384) {
    assert((req.headers['content-type'] || '').startsWith('application/json'), 'JSON erforderlich.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        assert(size <= maximum, 'Anfrage ist zu groß.');
        chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Ungültige Anfrage.');
    return value;
}
export function sameOrigin(req, origins) {
    return (
        origins.includes(req.headers.origin) &&
        req.headers['x-suwayomi-private'] === '1' &&
        (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
    );
}
export async function authenticate(req, upstream, fetchImpl = fetch) {
    const headers = {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
    };
    const response = await fetchImpl(new URL('/api/graphql', upstream), {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: 'query { settings { authMode } aboutServer { version } }' }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401)
        return { authorized: false, challenge: response.headers.get('www-authenticate') || 'Basic realm="Suwayomi"' };
    if (!response.ok) throw new Error('Suwayomi-Anmeldung konnte nicht geprüft werden.');
    const value = await response.json();
    if (value.errors || !value.data?.settings?.authMode)
        return { authorized: false, challenge: 'Basic realm="Suwayomi"' };
    const mode = value.data.settings.authMode;
    const match = value.data.aboutServer?.version?.match(/(?:^|v)(\d+)\.(\d+)\.(\d+)/);
    return {
        authorized: true,
        mode,
        serverRevision: match ? Number(match[3]) : null,
        canManage: mode === 'BASIC_AUTH' && /^Basic\s+/i.test(req.headers.authorization || ''),
    };
}
export function createGateway({
    upstream = UPSTREAM,
    webRoot = resolve('build'),
    manifest,
    configLoader = loadConfig,
    fetchImpl = fetch,
    secretLoader = secrets,
    jobReader = activeJob,
    stateExists = exists,
    stateRead = readJson,
    aiService,
    translationService,
    cloudTranslationService,
    logService,
} = {}) {
    const target = new URL(upstream);
    assert(
        target.protocol === 'http:' && !target.username && !target.password && target.pathname === '/',
        'Ungültiges internes Suwayomi-Ziel.',
    );
    const connection = async () => {
        const config = await configLoader();
        const keys = await secretLoader();
        return { config, api: portainerClient(config.portainerUrl, keys.portainer, fetchImpl) };
    };
    const logs = logService || createLogStore({ connection });
    const ai = aiService || createAiService({ upstream: target, fetchImpl, logs });
    const translations =
        translationService ||
        createTranslationService({
            upstream: target,
            fetchImpl,
            logs,
            ledger: ai.ledger,
            aiBusy: () => ai.busy?.() || false,
            updateBusy: jobReader,
            imageWorker: createImageWorker({ connection, logs }),
        });
    const libraryExports = createLibraryExportService({ upstream: target, fetchImpl });
    const cloud =
        cloudTranslationService ||
        createCloudTranslationService({
            upstream: target,
            fetchImpl,
            libraryExports,
            chapterReader: (id, req) => translations.chapter(id, req),
            updateBusy: jobReader,
            otherBusy: () => translations.busy?.() || ai.busy?.(),
        });
    const tasks = createTaskService({ translations, cloud, ai, jobReader, upstream: target, fetchImpl });
    let startingAiAction = false;
    const startAiAction = async (action) => {
        assert(!startingAiAction, 'Eine KI-Aktion wird bereits vorbereitet.');
        startingAiAction = true;
        try {
            return await action();
        } finally {
            startingAiAction = false;
        }
    };
    const server = http.createServer(async (req, res) => {
        try {
            assert(
                req.url?.startsWith('/') && !req.url.startsWith('//') && !req.url.includes('\\'),
                'Ungültige Adresse.',
            );
            const url = new URL(req.url, 'http://private.local');
            if (url.pathname === '/healthz' && req.method === 'GET') {
                let response;
                try {
                    response = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
                } catch {}
                const ready = !!response && [200, 301, 302, 303, 307, 308, 401].includes(response.status);
                return json(res, ready ? 200 : 503, { ready, commit: manifest.commit, version: manifest.version });
            }
            if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
                const outgoing = http.request(
                    new URL(req.url, target),
                    { method: req.method, headers: proxyHeaders(req.headers, target) },
                    (incoming) => {
                        res.writeHead(
                            incoming.statusCode,
                            Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !hop.has(key))),
                        );
                        incoming.pipe(res);
                    },
                );
                outgoing.on('error', () => {
                    if (!res.headersSent) json(res, 502, { error: 'Suwayomi ist nicht erreichbar.' });
                    else res.destroy();
                });
                req.on('aborted', () => outgoing.destroy());
                req.pipe(outgoing);
                return;
            }
            const user = await authenticate(req, target, fetchImpl);
            if (!user.authorized) {
                res.writeHead(401, { 'WWW-Authenticate': user.challenge, 'Cache-Control': 'no-store' });
                res.end('Anmeldung bei Suwayomi erforderlich.');
                return;
            }
            if (url.pathname.startsWith('/private-api/')) {
                if (!user.canManage)
                    return json(res, 403, {
                        error: 'Die privaten Funktionen benötigen die bestehende Suwayomi-Basic-Auth-Anmeldung.',
                    });
                if (req.method === 'POST' && url.pathname === '/private-api/exports/plan') {
                    const config = await configLoader();
                    if (!sameOrigin(req, config.origins))
                        return json(res, 403, { error: 'Export muss von derselben Suwayomi-Seite gestartet werden.' });
                    return json(res, 200, await libraryExports.plan(await body(req, 32768), req));
                }
                if (req.method === 'GET' && url.pathname === '/private-api/exports/archive') {
                    if (req.headers['sec-fetch-site'] === 'cross-site')
                        return json(res, 403, { error: 'Export muss von derselben Suwayomi-Seite gestartet werden.' });
                    const parseIds = (name) => {
                        const value = url.searchParams.get(name);
                        assert(!value || /^\d+(,\d+)*$/.test(value), 'Ungültige Exportauswahl.');
                        return value ? value.split(',').map(Number) : [];
                    };
                    return await libraryExports.archive(
                        { mangaIds: parseIds('mangaIds'), chapterIds: parseIds('chapterIds') },
                        url.searchParams.get('format'),
                        req,
                        res,
                    );
                }
                if (req.method === 'GET' && url.pathname === '/private-api/tasks')
                    return json(res, 200, await tasks.list(req));
                if (
                    req.method === 'POST' &&
                    ['/private-api/tasks/cancel', '/private-api/tasks/pause'].includes(url.pathname)
                ) {
                    const config = await configLoader();
                    if (!sameOrigin(req, config.origins))
                        return json(res, 403, {
                            error: 'Diese Aktion muss von derselben Suwayomi-Seite gestartet werden.',
                        });
                    return json(
                        res,
                        202,
                        await (url.pathname.endsWith('/pause')
                            ? tasks.pause(await body(req), req)
                            : tasks.cancel(await body(req), req)),
                    );
                }
                if (req.method === 'GET' && url.pathname === '/private-api/logs')
                    return json(res, 200, { categories: LOG_CATEGORIES });
                if (req.method === 'GET' && url.pathname === '/private-api/logs/read') {
                    const result = await logs.read(url.searchParams.get('category'));
                    if (url.searchParams.get('download') === '1') {
                        res.writeHead(200, {
                            'Content-Type': 'text/plain; charset=utf-8',
                            'Content-Disposition': `attachment; filename="suwayomi-${result.category}.log"`,
                            'Cache-Control': 'no-store',
                            'X-Content-Type-Options': 'nosniff',
                        });
                        return res.end(result.text);
                    }
                    return json(res, 200, result);
                }
                const config = await configLoader();
                if (url.pathname.startsWith('/private-api/cloud-translations/')) {
                    const suffix = url.pathname.slice('/private-api/cloud-translations/'.length);
                    if (req.method === 'GET' && suffix === 'status') return json(res, 200, await cloud.status());
                    if (req.method === 'GET' && suffix === 'jobs') return json(res, 200, { jobs: await cloud.list() });
                    const batch = suffix.match(/^jobs\/([a-f0-9-]{36})$/)?.[1];
                    if (req.method === 'GET' && batch) return json(res, 200, await cloud.get(batch));
                    const file = suffix.match(/^files\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(result.cbz|page\/(\d+))$/);
                    if (req.method === 'GET' && file) {
                        const image = await cloud.file(
                            file[1],
                            file[2],
                            file[3] === 'result.cbz' ? null : Number(file[4]),
                        );
                        const info = await fs.stat(image.path);
                        res.writeHead(200, {
                            'Content-Type': image.type,
                            'Content-Length': info.size,
                            'Cache-Control': 'private, no-cache',
                            'X-Content-Type-Options': 'nosniff',
                            ...(file[3] === 'result.cbz'
                                ? { 'Content-Disposition': 'attachment; filename="kapitel-de.cbz"' }
                                : {}),
                        });
                        createReadStream(image.path)
                            .on('error', () => res.destroy())
                            .pipe(res);
                        return;
                    }
                    if (req.method !== 'POST') return json(res, 404, { error: 'Unbekannte Cloud-Aktion.' });
                    if (!sameOrigin(req, config.origins))
                        return json(res, 403, {
                            error: 'Cloud-Uebersetzung muss von derselben Suwayomi-Seite gestartet werden.',
                        });
                    const input = await body(req, 32768);
                    if (suffix === 'plan') return json(res, 200, await cloud.plan(input, req));
                    if (suffix === 'start') return json(res, 202, await startAiAction(() => cloud.start(input, req)));
                    if (suffix === 'resume') return json(res, 202, await startAiAction(() => cloud.resume(input, req)));
                    if (suffix === 'cancel') return json(res, 200, await cloud.cancel(input.id));
                    return json(res, 404, { error: 'Unbekannte Cloud-Aktion.' });
                }
                if (url.pathname.startsWith('/private-api/translations/')) {
                    if (req.method === 'GET' && url.pathname === '/private-api/translations/performance')
                        return json(res, 200, await translations.performance());
                    if (req.method === 'GET' && url.pathname === '/private-api/translations/jobs')
                        return json(res, 200, { jobs: await translations.list() });
                    const chapterId = url.pathname.match(/^\/private-api\/translations\/chapter\/(\d+)$/)?.[1];
                    if (req.method === 'GET' && chapterId) {
                        const info = await translations.chapter(Number(chapterId), req);
                        return json(res, 200, {
                            chapter: info,
                            available:
                                (await cloud.available(Number(chapterId), info)) ||
                                (await translations.available(Number(chapterId), info)),
                        });
                    }
                    const id = url.pathname.match(/^\/private-api\/translations\/jobs\/([a-f0-9-]{36})$/)?.[1];
                    if (req.method === 'GET' && id) return json(res, 200, await translations.get(id));
                    const file = url.pathname.match(
                        /^\/private-api\/translations\/files\/([a-f0-9-]{36})\/(original|translated|preview)\/(\d+)$/,
                    );
                    if (req.method === 'GET' && file) {
                        const image = await translations.file(file[1], file[2], Number(file[3]));
                        const info = await fs.stat(image.path);
                        res.writeHead(200, {
                            'Content-Type': image.type,
                            'Content-Length': info.size,
                            'Cache-Control': 'private, no-cache',
                            'X-Content-Type-Options': 'nosniff',
                        });
                        createReadStream(image.path)
                            .on('error', () => res.destroy())
                            .pipe(res);
                        return;
                    }
                    if (req.method !== 'POST') return json(res, 404, { error: 'Unbekannte Übersetzungsaktion.' });
                    if (!sameOrigin(req, config.origins))
                        return json(res, 403, {
                            error: 'Übersetzung muss von derselben Suwayomi-Seite gestartet werden.',
                        });
                    const input = await body(req, 256 * 1024);
                    if (url.pathname === '/private-api/translations/performance')
                        return json(res, 200, await translations.savePerformance(input));
                    if (url.pathname === '/private-api/translations/analyze')
                        return json(
                            res,
                            202,
                            await startAiAction(() => {
                                assert(!cloud.busy(), 'Bitte den Cloud-Auftrag zuerst beenden.');
                                return translations.start(input, req);
                            }),
                        );
                    if (url.pathname === '/private-api/translations/translate')
                        return json(
                            res,
                            202,
                            await startAiAction(() => {
                                assert(!cloud.busy(), 'Bitte den Cloud-Auftrag zuerst beenden.');
                                return translations.resume(input, req);
                            }),
                        );
                    if (url.pathname === '/private-api/translations/edit')
                        return json(res, 202, await translations.edit(input));
                    if (url.pathname === '/private-api/translations/pause')
                        return json(res, 202, await translations.pause(input.id));
                    if (url.pathname === '/private-api/translations/cancel')
                        return json(res, 200, await translations.cancel(input.id));
                    return json(res, 404, { error: 'Unbekannte Übersetzungsaktion.' });
                }
                if (url.pathname.startsWith('/private-api/ai/')) {
                    if (req.method === 'GET' && url.pathname === '/private-api/ai/settings')
                        return json(res, 200, await ai.status());
                    if (req.method === 'GET' && url.pathname === '/private-api/ai/active')
                        return json(res, 200, { job: ai.active(req) });
                    if (req.method === 'GET' && url.pathname === '/private-api/ai/usage')
                        return json(res, 200, await ai.usage());
                    if (req.method === 'GET' && url.pathname === '/private-api/ai/history')
                        return json(
                            res,
                            200,
                            await ai.history(
                                Number(url.searchParams.get('offset') || 0),
                                Number(url.searchParams.get('limit') || 25),
                            ),
                        );
                    const id = url.pathname.match(/^\/private-api\/ai\/jobs\/([a-f0-9-]{36})$/)?.[1];
                    if (req.method === 'GET' && id) return json(res, 200, ai.get(id, req));
                    if (req.method !== 'POST') return json(res, 404, { error: 'Unbekannte KI-Aktion.' });
                    if (!sameOrigin(req, config.origins))
                        return json(res, 403, {
                            error: 'Diese Aktion muss von derselben Suwayomi-Seite gestartet werden.',
                        });
                    const input = await body(req);
                    if (url.pathname === '/private-api/ai/settings') {
                        assert(
                            !translations.busy(),
                            'Bitte die Kapitelverarbeitung vor einer Schlüsseländerung abwarten.',
                        );
                        return json(res, 200, await ai.save(input));
                    }
                    if (url.pathname === '/private-api/ai/test') return json(res, 200, await ai.testConnection());
                    if (url.pathname === '/private-api/ai/search') {
                        assert(
                            !translations.busy(),
                            'Bitte die Kapitelverarbeitung vor einer weiteren KI-Suche abwarten.',
                        );
                        return json(res, 202, await startAiAction(() => ai.start(input, req)));
                    }
                    if (url.pathname === '/private-api/ai/balance') return json(res, 200, await ai.setBalance(input));
                    if (url.pathname === '/private-api/ai/billing') return json(res, 200, await ai.saveBilling(input));
                    if (url.pathname === '/private-api/ai/costs') return json(res, 200, await ai.syncCosts(input.days));
                    if (url.pathname === '/private-api/ai/cancel') {
                        assert(jobIdValid(input.id), 'Ungültige Suchkennung.');
                        return json(res, 200, ai.cancel(input.id, req));
                    }
                    return json(res, 404, { error: 'Unbekannte KI-Aktion.' });
                }
                const keys = await secretLoader();
                const api = portainerClient(config.portainerUrl, keys.portainer, fetchImpl);
                if (req.method === 'GET' && url.pathname === '/private-api/status') {
                    const running = await jobReader();
                    let last = null;
                    if (!running && (await stateExists('/update/latest-job.json'))) {
                        const latest = await stateRead('/update/latest-job.json');
                        if (jobIdValid(latest.id)) last = await stateRead('/update/jobs/' + latest.id + '.json');
                    }
                    const rollback = (await stateExists('/update/last-success.json'))
                        ? await stateRead('/update/last-success.json')
                        : null;
                    return json(res, 200, {
                        manifest,
                        repository: REPOSITORY,
                        serverRevision: user.serverRevision,
                        configured: { github: !!keys.github, portainer: !!keys.portainer },
                        job: running || last,
                        busy: !!running,
                        taskBlockers: (await tasks.privateTasks(req)).tasks.filter(
                            (task) => task.active && ['translation', 'cloud', 'ai'].includes(task.kind),
                        ),
                        canRollback: !!rollback?.previousPrivateVersion,
                    });
                }
                if (req.method !== 'POST') return json(res, 404, { error: 'Unbekannte Aktion.' });
                if (!sameOrigin(req, config.origins))
                    return json(res, 403, {
                        error: 'Diese Aktion muss von derselben Suwayomi-Seite gestartet werden.',
                    });
                const input = await body(req);
                if (url.pathname === '/private-api/check') {
                    const latest = await resolveCommit(keys.github, 'main', fetchImpl);
                    const metadata = await projectManifest(keys.github, latest.sha, fetchImpl);
                    return json(res, 200, {
                        latest,
                        version: metadata.version,
                        minimumServerRevision: metadata.minimumServerRevision,
                        compatible:
                            Number.isInteger(user.serverRevision) &&
                            user.serverRevision >= metadata.minimumServerRevision,
                        hasUpdate: latest.sha !== manifest.commit,
                    });
                }
                if (url.pathname === '/private-api/update' || url.pathname === '/private-api/rollback') {
                    assert(!cloud.busy(), 'Bitte den Cloud-Auftrag zuerst abwarten oder abbrechen.');
                    assert(
                        !translations.busy(),
                        'Bitte die laufende Kapitelübersetzung zuerst abwarten oder abbrechen.',
                    );
                    assert(
                        !ai.busy?.(),
                        'Bitte die laufende KI-Suche unter Laufende Aufgaben zuerst abwarten oder abbrechen.',
                    );
                    const action = url.pathname.endsWith('/rollback') ? 'rollback' : 'update';
                    if (action === 'update') assert(sha(input.commit), 'Vollständige Commit-Kennung erforderlich.');
                    const job = await createJob(config, api, action, input.commit, user.serverRevision);
                    return json(res, 202, { id: job.id });
                }
                if (url.pathname === '/private-api/credentials') {
                    assert(!(await jobReader()), 'API-Schlüssel können während eines Updates nicht geändert werden.');
                    const changes = Object.entries(input).filter(
                        ([name, value]) => ['github', 'portainer'].includes(name) && value !== '',
                    );
                    assert(
                        changes.length && Object.keys(input).every((name) => ['github', 'portainer'].includes(name)),
                        'Keine gültigen API-Schlüssel übergeben.',
                    );
                    for (const [name, value] of changes) {
                        assert(
                            typeof value === 'string' && value.length >= 20 && value.length <= 512 && !/\s/.test(value),
                            'Ungültiger API-Schlüssel.',
                        );
                        if (name === 'github') await resolveCommit(value, 'main', fetchImpl);
                        else await stackState(portainerClient(config.portainerUrl, value, fetchImpl), config);
                    }
                    for (const [name, value] of changes) {
                        const path = '/secrets/' + name + '.token',
                            temporary = path + '.' + randomUUID();
                        await fs.writeFile(temporary, value + '\n', { mode: 0o600, flag: 'wx' });
                        await fs.rename(temporary, path);
                    }
                    return json(res, 200, { saved: true });
                }
                return json(res, 404, { error: 'Unbekannte Aktion.' });
            }
            if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Methode nicht erlaubt.' });
            let pathname;
            try {
                pathname = decodeURIComponent(url.pathname);
            } catch {
                return json(res, 400, { error: 'Ungültige Adresse.' });
            }
            let path = resolve(webRoot, '.' + pathname);
            assert(path === webRoot || path.startsWith(webRoot + sep), 'Ungültiger Dateipfad.');
            let info = await fs.stat(path).catch(() => null);
            if (!info?.isFile()) {
                if (extname(pathname)) return json(res, 404, { error: 'Datei nicht gefunden.' });
                path = resolve(webRoot, 'index.html');
                info = await fs.stat(path);
            }
            res.writeHead(200, {
                'Content-Type': types[extname(path)] || 'application/octet-stream',
                'Content-Length': info.size,
                'Cache-Control':
                    extname(path) === '.html' || ['sw.js', 'registerSW.js'].some((name) => path.endsWith(sep + name))
                        ? 'no-store'
                        : 'private, max-age=3600',
                'X-Content-Type-Options': 'nosniff',
            });
            if (req.method === 'HEAD') res.end();
            else
                createReadStream(path)
                    .on('error', () => res.destroy())
                    .pipe(res);
        } catch (error) {
            await logs.write(
                'system',
                'ERROR',
                req.method + ' ' + String(req.url).split('?')[0].slice(0, 200) + ': ' + error.message,
            );
            if (!res.headersSent) json(res, error.status === 404 ? 404 : 400, { error: error.message });
            else res.destroy();
        }
    });
    server.on('listening', () => {
        void logs.write('system', 'INFO', 'Private WebUI bereit: ' + manifest.version + ' · ' + manifest.commit);
    });
    let closing;
    server.shutdownPrivate = () => {
        closing ||= cloud
            .stop()
            .finally(() => translations.stop())
            .finally(() => ai.stop());
        return closing;
    };
    server.on('close', () => {
        void server.shutdownPrivate();
    });
    server.on('upgrade', (req, socket, head) => {
        if (!req.url.startsWith('/api/')) {
            socket.destroy();
            return;
        }
        const outgoing = http.request(new URL(req.url, target), { headers: { ...req.headers, host: target.host } });
        outgoing.on('upgrade', (incoming, backend, buffer) => {
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                    Object.entries(incoming.headers)
                        .map(([key, value]) => key + ': ' + value)
                        .join('\r\n') +
                    '\r\n\r\n',
            );
            if (head.length) backend.write(head);
            if (buffer.length) socket.write(buffer);
            backend.on('error', () => socket.destroy());
            socket.on('error', () => backend.destroy());
            socket.on('close', () => backend.destroy());
            backend.on('close', () => socket.destroy());
            socket.pipe(backend).pipe(socket);
        });
        outgoing.on('response', (response) => {
            socket.write(
                'HTTP/1.1 ' + response.statusCode + ' ' + response.statusMessage + '\r\nConnection: close\r\n\r\n',
            );
            socket.destroy();
        });
        outgoing.on('error', () => socket.destroy());
        outgoing.end();
    });
    return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifest = await readJson('private/manifest.json');
    const gateway = createGateway({ upstream: process.env.SUWAYOMI_UPSTREAM || UPSTREAM, manifest });
    gateway.listen(18081, '192.168.175.60', () => console.log('Suwayomi-Private ' + manifest.version + ' bereit.'));
    for (const signal of ['SIGTERM', 'SIGINT'])
        process.on(signal, () => {
            gateway.close();
            void gateway.shutdownPrivate().finally(() => process.exit(0));
            setTimeout(() => process.exit(0), 15000).unref();
        });
}
