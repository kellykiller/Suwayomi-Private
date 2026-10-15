/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { assert, inspect, UI_CONTAINER } from './common.mjs';

export const LOG_CATEGORIES = {
    translation: 'Kapitelübersetzung',
    ocr: 'Texterkennung und Bildverarbeitung',
    ai: 'KI-Suche',
    updates: 'Private Updates',
    system: 'Private WebUI',
    suwayomi: 'Suwayomi-Server',
};
import { redactLog, boundedText, dockerLogText } from './log-utils.mjs';
const LIMIT = 1024 * 1024;
export function createLogStore({ stateRoot = '/update', secretRoot = '/secrets', connection } = {}) {
    const root = stateRoot + '/logs';
    let queue = Promise.resolve();
    const valid = (category) => assert(Object.hasOwn(LOG_CATEGORIES, category), 'Unbekannte Logkategorie.');
    const keys = async () =>
        Promise.all(
            ['github', 'portainer', 'openai', 'openai-admin'].map((name) =>
                fs
                    .readFile(`${secretRoot}/${name}.token`, 'utf8')
                    .then((x) => x.trim())
                    .catch(() => ''),
            ),
        );
    const clean = async (value) => redactLog(value, await keys());
    const write = (category, level, message, jobId = '') => {
        valid(category);
        const next = queue.then(async () => {
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            const path = `${root}/${category}.log`;
            if ((await fs.stat(path).catch(() => null))?.size > 2 * LIMIT) {
                await fs.rm(path + '.3', { force: true });
                for (let i = 2; i >= 0; i--)
                    await fs.rename(path + (i ? '.' + i : ''), path + '.' + (i + 1)).catch((error) => {
                        if (error.code !== 'ENOENT') throw error;
                    });
            }
            const text = await clean(String(message).slice(0, 24000));
            const header = `${new Date().toISOString()} [${level}]${jobId ? ' [' + jobId + ']' : ''} `;
            await fs.appendFile(path, header + text.replaceAll('\n', '\n    ') + '\n', { mode: 0o600 });
        });
        // Logging failures must not break an otherwise successful translation or hide its original error.
        queue = next.catch(() => {});
        return queue;
    };
    const tail = async (path) => {
        let handle;
        try {
            handle = await fs.open(path, 'r');
            const { size } = await handle.stat();
            const length = Math.min(size, LIMIT);
            const data = Buffer.alloc(length);
            await handle.read(data, 0, length, size - length);
            return (size > length ? '[Ältere Einträge gekürzt]\n' : '') + data.toString('utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return '';
            throw error;
        } finally {
            await handle?.close();
        }
    };
    const snapshot = async (category) => {
        if (!['translation', 'updates'].includes(category)) return '';
        const dir = stateRoot + (category === 'translation' ? '/translations' : '/jobs');
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        const files = entries.filter((entry) =>
            category === 'translation'
                ? entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)
                : entry.isFile() && /^[a-f0-9-]{36}\.json$/.test(entry.name),
        );
        const jobs = await Promise.all(
            files.slice(0, 300).map(async (entry) => {
                const path = `${dir}/${entry.name}` + (category === 'translation' ? '/job.json' : '');
                try {
                    return JSON.parse(await tail(path));
                } catch {
                    return null;
                }
            }),
        );
        return jobs
            .filter(Boolean)
            .sort((a, b) => String(b.updated || b.started).localeCompare(String(a.updated || a.started)))
            .slice(0, 50)
            .map((job) =>
                [
                    `${job.updated || job.started || ''} [${job.id}] ${job.phase}`,
                    category === 'translation'
                        ? `${job.title} · ${job.chapterName} · ${job.completedPages}/${job.pageCount} Seiten`
                        : job.message,
                    job.error,
                    ...(category === 'updates' ? job.logs || [] : []),
                ]
                    .filter(Boolean)
                    .join('\n'),
            )
            .join('\n\n');
    };
    const read = async (category) => {
        valid(category);
        await queue;
        const sections = [];
        const previous = await snapshot(category);
        if (previous) sections.push('Gespeicherte Aufträge (einschließlich älterer Versionen):\n' + previous);
        const journal = (
            await Promise.all([3, 2, 1, 0].map((n) => tail(`${root}/${category}.log${n ? '.' + n : ''}`)))
        ).join('');
        if (journal) sections.push('Ereignisprotokoll:\n' + journal);
        if (connection && ['system', 'suwayomi'].includes(category)) {
            try {
                const { api, config } = await connection();
                const name = category === 'system' ? UI_CONTAINER : 'suwayomi';
                const container = await inspect(api, config, name);
                assert(
                    container?.Config.Labels?.['com.docker.compose.project'] === 'suwayomi',
                    'Suwayomi-Container nicht gefunden.',
                );
                const response = await api(
                    `/endpoints/${config.endpointId}/docker/containers/${container.Id}/logs?stdout=true&stderr=true&timestamps=true&tail=500`,
                    { binary: true, timeout: 15000 },
                );
                sections.push(
                    'Aktuelle Container-Ausgabe (letzte 500 Zeilen):\n' + dockerLogText(await boundedText(response)),
                );
            } catch (error) {
                sections.push('Container-Ausgabe nicht verfügbar: ' + error.message);
            }
        }
        const text = await clean(sections.join('\n\n').slice(-2 * LIMIT) || 'Noch keine Einträge in dieser Kategorie.');
        return { category, title: LOG_CATEGORIES[category], generated: new Date().toISOString(), text };
    };
    return { write, read, clean };
}
