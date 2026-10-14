/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const BASE = '/volume3/docker/suwayomi';
export const REPOSITORY = 'kellykiller/Suwayomi-Private';
export const UI_CONTAINER = 'suwayomi-private-ui';
export const UI_SERVICE = 'private-ui';
export const UPSTREAM = 'http://192.168.175.60:18082';
export const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
export const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const imageId = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const exists = async (path) =>
    !!(await fs.stat(path).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
    }));
export const readJson = async (path) => JSON.parse(await fs.readFile(path, 'utf8'));
export async function writeJson(path, value) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, path);
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
    }
}
export async function loadConfig() {
    const config = await readJson('/update/private-config.json');
    assert(
        config.repository === REPOSITORY &&
            config.stackName === 'suwayomi' &&
            config.containerName === UI_CONTAINER &&
            config.serviceName === UI_SERVICE &&
            config.hostRoot === BASE,
        'Updater-Konfiguration ist ungültig.',
    );
    assert(
        Number.isInteger(config.endpointId) &&
            Number.isInteger(config.stackId) &&
            typeof config.daemonId === 'string' &&
            config.daemonId.length > 0,
        'Docker-/Stack-Kennungen fehlen.',
    );
    assert(
        Array.isArray(config.origins) &&
            config.origins.length > 0 &&
            config.origins.every((value) => {
                try {
                    return new URL(value).origin === value && ['https:', 'http:'].includes(new URL(value).protocol);
                } catch {
                    return false;
                }
            }),
        'Erlaubte Browser-Adressen fehlen.',
    );
    return config;
}
export async function secrets() {
    const [github, portainer] = await Promise.all(
        ['github', 'portainer'].map((name) => fs.readFile('/secrets/' + name + '.token', 'utf8')),
    );
    assert(
        github.trim() && portainer.trim() && !/[\r\n]/.test(github.trim() + portainer.trim()),
        'Gespeicherter API-Schlüssel fehlt oder ist ungültig.',
    );
    return { github: github.trim(), portainer: portainer.trim() };
}
export function portainerClient(origin, token, fetchImpl = fetch) {
    const url = new URL(origin);
    assert(
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
            ['http:', 'https:'].includes(url.protocol) &&
            url.pathname === '/' &&
            !url.search &&
            !url.hash &&
            !url.username &&
            !url.password,
        'Portainer muss lokal über Loopback angesprochen werden.',
    );
    return async (path, { method = 'GET', body, binary = false, timeout = 180000, allow404 = false } = {}) => {
        assert(path.startsWith('/') && !path.startsWith('//'), 'Ungültiger API-Pfad.');
        let response;
        try {
            response = await fetchImpl(url.origin + '/api' + path, {
                method,
                headers: { 'X-API-Key': token, 'Content-Type': binary ? 'application/x-tar' : 'application/json' },
                ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
                redirect: 'error',
                signal: AbortSignal.timeout(timeout),
            });
        } catch {
            throw new Error('Portainer-Anfrage nicht erreichbar oder zeitlich überschritten.');
        }
        if (allow404 && response.status === 404) return null;
        assert(response.ok, 'Portainer-Anfrage fehlgeschlagen (HTTP ' + response.status + ').');
        if (binary) return response;
        const text = await response.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            throw new Error('Portainer lieferte kein gültiges JSON.');
        }
    };
}
export const githubHeaders = (token) => ({
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
});
export async function resolveCommit(token, ref = 'main', fetchImpl = fetch) {
    assert(typeof ref === 'string' && /^[A-Za-z0-9_./-]{1,200}$/.test(ref), 'Ungültiger Projektstand.');
    let response;
    try {
        response = await fetchImpl(
            'https://api.github.com/repos/' + REPOSITORY + '/commits/' + encodeURIComponent(ref),
            { headers: githubHeaders(token), redirect: 'error', signal: AbortSignal.timeout(30000) },
        );
    } catch {
        throw new Error('GitHub ist nicht erreichbar. HTTPS-Proxy und Internetzugang prüfen.');
    }
    assert(
        response.ok,
        'GitHub-Zugriff fehlgeschlagen (HTTP ' +
            response.status +
            '). Der Token benötigt Contents: Read für Suwayomi-Private.',
    );
    const value = await response.json();
    assert(sha(value.sha), 'GitHub lieferte keine gültige Commit-Kennung.');
    return {
        sha: value.sha,
        message: value.commit?.message?.split('\n')[0] || '',
        date: value.commit?.committer?.date || '',
        url: 'https://github.com/' + REPOSITORY + '/commit/' + value.sha,
    };
}
export async function projectManifest(token, commit, fetchImpl = fetch) {
    assert(sha(commit), 'Ungültiger Projektstand.');
    const response = await fetchImpl(
        'https://api.github.com/repos/' + REPOSITORY + '/contents/private/manifest.json?ref=' + commit,
        {
            headers: { ...githubHeaders(token), Accept: 'application/vnd.github.raw+json' },
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
        },
    );
    assert(response.ok, 'Der Projektstand enthält keine private Versionsbeschreibung.');
    const value = await response.json();
    assert(
        Number.isInteger(value.minimumServerRevision) &&
            value.minimumServerRevision > 0 &&
            typeof value.version === 'string',
        'Private Versionsbeschreibung ist ungültig.',
    );
    return value;
}
export async function downloadArchive(token, commit, fetchImpl = fetch) {
    assert(sha(commit), 'Vollständige Commit-Kennung erforderlich.');
    const redirect = await fetchImpl('https://api.github.com/repos/' + REPOSITORY + '/tarball/' + commit, {
        headers: githubHeaders(token),
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
    });
    assert(redirect.status === 302, 'GitHub-Quellarchiv ist nicht verfügbar (HTTP ' + redirect.status + ').');
    const location = new URL(redirect.headers.get('location'));
    assert(
        location.protocol === 'https:' &&
            location.hostname === 'codeload.github.com' &&
            !location.username &&
            !location.password,
        'Unerwartetes GitHub-Archivziel.',
    );
    // The signed redirect is fetched without forwarding the repository credential.
    const archive = await fetchImpl(location.href, { redirect: 'error', signal: AbortSignal.timeout(180000) });
    assert(archive.ok && archive.body, 'GitHub-Quellarchiv konnte nicht geladen werden.');
    const chunks = [];
    let size = 0;
    for await (const chunk of archive.body) {
        size += chunk.length;
        assert(size <= 32 * 1024 * 1024, 'Quellarchiv überschreitet 32 MiB.');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

// GitHub tarballs have one directory prefix. Produce a validated Docker build context.
export function dockerContext(archive) {
    const source = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
    const output = [];
    const paths = new Set();
    let offset = 0,
        root,
        nextPath;
    const field = (header, start, length) =>
        header
            .subarray(start, start + length)
            .toString()
            .replace(/\0.*$/s, '');
    while (offset + 512 <= source.length) {
        const header = Buffer.from(source.subarray(offset, offset + 512));
        offset += 512;
        if (header.every((byte) => byte === 0)) break;
        const rawSize = field(header, 124, 12).trim();
        assert(/^[0-7]+$/.test(rawSize), 'Ungültige Archivgröße.');
        const size = parseInt(rawSize, 8);
        const length = Math.ceil(size / 512) * 512;
        assert(offset + length <= source.length, 'Quellarchiv ist unvollständig.');
        const data = source.subarray(offset, offset + length);
        offset += length;
        const type = String.fromCharCode(header[156] || 48);
        if (type === 'g') continue;
        if (type === 'x') {
            const text = data.subarray(0, size).toString();
            for (const line of text.split('\n')) {
                const match = line.match(/^\d+ path=(.*)$/);
                if (match) nextPath = match[1];
            }
            continue;
        }
        if (type === 'L') {
            nextPath = data.subarray(0, size).toString().replace(/\0.*$/s, '');
            continue;
        }
        assert(['0', '5'].includes(type), 'Links oder spezielle Dateien im Quellarchiv werden nicht unterstützt.');
        const prefix = field(header, 345, 155);
        const full = nextPath || (prefix ? prefix + '/' : '') + field(header, 0, 100);
        nextPath = undefined;
        const parts = full.replace(/\/$/, '').split('/');
        assert(
            !full.startsWith('/') && parts.every((part) => part && part !== '.' && part !== '..'),
            'Unsicherer Archivpfad.',
        );
        root ||= parts[0];
        assert(parts[0] === root, 'Quellarchiv enthält mehrere Wurzelordner.');
        if (parts.length === 1) {
            assert(type === '5', 'Wurzelverzeichnis im Quellarchiv fehlt.');
            continue;
        }
        const path = parts.slice(1).join('/');
        assert(!paths.has(path), 'Doppelter Archivpfad.');
        paths.add(path);
        let name = path,
            parent = '';
        if (Buffer.byteLength(name) > 100) {
            const split = path.lastIndexOf('/');
            assert(split > 0, 'Archivpfad ist zu lang.');
            parent = path.slice(0, split);
            name = path.slice(split + 1);
        }
        assert(Buffer.byteLength(name) <= 100 && Buffer.byteLength(parent) <= 155, 'Archivpfad ist zu lang.');
        header.fill(0, 0, 100);
        header.write(name, 0);
        header.fill(0, 345, 500);
        header.write(parent, 345);
        header.fill(32, 148, 156);
        let checksum = 0;
        for (const byte of header) checksum += byte;
        header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
        output.push(header, data);
    }
    assert(
        paths.has('Dockerfile') && paths.has('package.json') && paths.has('private/server/worker.mjs'),
        'Dockerfile oder private Anwendung fehlt im Projektstand.',
    );
    output.push(Buffer.alloc(1024));
    return Buffer.concat(output);
}

export function replaceUiImage(content, image) {
    assert(
        /^suwayomi-private:git-[a-f0-9]{40}$/.test(image) && !content.includes('\t'),
        'Ungültiger Image-Stand oder Compose-Format.',
    );
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => /^  private-ui:\s*(?:#.*)?$/.test(line));
    assert(
        start >= 0 && lines.filter((line) => /^  private-ui:/.test(line)).length === 1,
        'Private WebUI ist im Stack nicht eindeutig definiert.',
    );
    let end = start + 1;
    while (
        end < lines.length &&
        (!lines[end].trim() || lines[end].trimStart().startsWith('#') || /^ {3}/.test(lines[end]))
    )
        end++;
    const indices = [];
    for (let i = start + 1; i < end; i++) if (/^ {4}image:/.test(lines[i])) indices.push(i);
    assert(
        indices.length === 1 &&
            lines.slice(start, end).some((line) => /^ {4}container_name:\s*suwayomi-private-ui\s*$/.test(line)),
        'Private WebUI-Container passt nicht zum Stack.',
    );
    lines[indices[0]] = '    image: ' + image;
    return lines.join(content.includes('\r\n') ? '\r\n' : '\n');
}
export function privateService(config, image) {
    assert(/^suwayomi-private:git-[a-f0-9]{40}$/.test(image), 'Ungültiges privates Image.');
    return `  private-ui:\n    image: ${image}\n    container_name: ${UI_CONTAINER}\n    user: "0:0"\n    restart: unless-stopped\n    read_only: true\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    mem_limit: 256m\n    environment:\n      - NODE_OPTIONS=--dns-result-order=ipv4first\n      - SUWAYOMI_UPSTREAM=${UPSTREAM}\n    volumes:\n      - "${BASE}/secrets:/secrets"\n      - "${BASE}/updater:/update"\n    network_mode: host\n`;
}
export function addPrivateService(content, config, commit) {
    assert(
        !content.includes('\t') && !/^  private-ui:/m.test(content),
        'Private WebUI ist bereits eingerichtet oder Compose-Struktur ist ungewöhnlich.',
    );
    assert(
        content
            .split(/\r?\n/)
            .filter((line) => /^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(line) && !/^  suwayomi:/.test(line)).length === 0,
        'Stack enthält zusätzliche Dienste oder Netzwerke.',
    );
    const lines = content.split(/\r?\n/);
    const services = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line));
    const backend = lines.findIndex((line) => /^  suwayomi:\s*(?:#.*)?$/.test(line));
    const network = lines.findIndex((line) => /^networks:\s*(?:#.*)?$/.test(line));
    assert(services >= 0 && backend > services && network > backend, 'Bestätigte Suwayomi-Stack-Struktur fehlt.');
    const matches = [];
    for (let i = backend + 1; i < network; i++)
        if (/^ {6}-\s*["']?192\.168\.175\.60:18081:4567["']?\s*$/.test(lines[i])) matches.push(i);
    assert(matches.length === 1, 'Bestätigte Suwayomi-Portzuordnung fehlt; keine Änderung vorgenommen.');
    lines[matches[0]] = '      - "192.168.175.60:18082:4567"';
    lines.splice(network, 0, privateService(config, 'suwayomi-private:git-' + commit));
    return lines.join('\n');
}
export async function stackState(api, config) {
    const stack = await api('/stacks/' + config.stackId);
    const file = await api('/stacks/' + config.stackId + '/file');
    assert(
        stack.Type === 2 &&
            stack.Name === 'suwayomi' &&
            stack.EndpointId === config.endpointId &&
            !stack.GitConfig &&
            !stack.AdditionalFiles?.length,
        'Portainer-Stack entspricht nicht der gespeicherten Einrichtung.',
    );
    assert(
        (await api('/endpoints/' + config.endpointId + '/docker/info')).ID === config.daemonId,
        'Portainer verweist auf einen anderen Docker-Dienst.',
    );
    return { file: file.StackFileContent, env: stack.Env || [] };
}
export const putStack = (api, config, state) =>
    api('/stacks/' + config.stackId + '?endpointId=' + config.endpointId, {
        method: 'PUT',
        body: { StackFileContent: state.file, Env: state.env, PullImage: false, Prune: false },
    });
export const inspect = (api, config, name) =>
    api('/endpoints/' + config.endpointId + '/docker/containers/' + encodeURIComponent(name) + '/json', {
        allow404: true,
    });
export async function healthy(api, config, expectedImage, attempts = 80, wait = sleep) {
    for (let i = 0; i < attempts; i++) {
        const container = await inspect(api, config, UI_CONTAINER);
        if (container?.Image === expectedImage) {
            assert(
                container.Config.Labels?.['com.docker.compose.project'] === 'suwayomi' &&
                    container.Config.Labels?.['com.docker.compose.service'] === UI_SERVICE,
                'Private WebUI gehört zu einem anderen Stack.',
            );
            if (container.State.Status === 'running' && container.State.Health?.Status === 'healthy') return;
            assert(
                !['dead', 'exited'].includes(container.State.Status) && container.State.Health?.Status !== 'unhealthy',
                'Private WebUI ist nicht betriebsbereit.',
            );
        }
        await wait(3000);
    }
    throw new Error('Zeitüberschreitung bei der Startprüfung der privaten WebUI.');
}
