/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { timestampBuildLog } from './log-time.mjs';
import {
    BASE,
    UI_CONTAINER,
    UI_SERVICE,
    assert,
    sha,
    imageId,
    digest,
    readJson,
    writeJson,
    exists,
    loadConfig,
    secrets,
    portainerClient,
    resolveCommit,
    projectManifest,
    downloadArchive,
    dockerContext,
    replaceUiImage,
    stackState,
    putStack,
    inspect,
    healthy,
} from './common.mjs';

const lockPath = '/update/private-update.lock';
const jobPath = (id, root = '/update') => root + '/jobs/' + id + '.json';
export const jobIdValid = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
export async function activeJob() {
    if (!(await exists(lockPath + '/owner.json'))) return null;
    const owner = await readJson(lockPath + '/owner.json');
    assert(jobIdValid(owner.id), 'Update-Sperre ist ungültig.');
    return readJson(jobPath(owner.id));
}
export async function releaseLock(id, root = '/update') {
    const path = root + '/private-update.lock';
    if (!(await exists(path + '/owner.json'))) return;
    if ((await readJson(path + '/owner.json')).id === id) await fs.rm(path, { recursive: true });
}
export async function createJob(config, api, action, target, serverRevision, { root = '/update' } = {}) {
    const lockPath = root + '/private-update.lock';
    assert(
        ['update', 'rollback'].includes(action) && (action !== 'update' || sha(target)),
        'Ungültiger Updateauftrag.',
    );
    assert(Number.isInteger(serverRevision) && serverRevision > 0, 'Serverversion konnte nicht bestimmt werden.');
    const current = await inspect(api, config, UI_CONTAINER);
    assert(
        current &&
            imageId(current.Image) &&
            current.Config.Labels?.['com.docker.compose.project'] === 'suwayomi' &&
            current.Config.Labels?.['com.docker.compose.service'] === UI_SERVICE,
        'Laufende private WebUI wurde nicht eindeutig gefunden.',
    );
    const id = randomUUID();
    let workerId;
    try {
        await fs.mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Ein Update läuft bereits.');
        throw error;
    }
    try {
        await writeJson(lockPath + '/owner.json', { id });
        await fs.mkdir(root + '/jobs', { recursive: true, mode: 0o700 });
        const job = {
            id,
            action,
            target: target || null,
            serverRevision,
            phase: 'queued',
            started: new Date().toISOString(),
            finished: null,
            logs: [],
            message: '',
        };
        await writeJson(jobPath(id, root), job);
        await writeJson(root + '/latest-job.json', { id });
        const worker = await api(
            '/endpoints/' + config.endpointId + '/docker/containers/create?name=suwayomi-private-update-' + id,
            {
                method: 'POST',
                body: {
                    Image: current.Image,
                    User: '0:0',
                    Entrypoint: ['node', '--dns-result-order=ipv4first'],
                    Cmd: ['private/server/worker.mjs', id],
                    WorkingDir: '/app',
                    Labels: { 'io.suwayomi.private-update': id },
                    HostConfig: {
                        NetworkMode: 'host',
                        ReadonlyRootfs: true,
                        AutoRemove: true,
                        CapDrop: ['ALL'],
                        SecurityOpt: ['no-new-privileges:true'],
                        Memory: 512 * 1024 * 1024,
                        Binds: [BASE + '/updater:/update', BASE + '/secrets:/secrets:ro'],
                    },
                },
            },
        );
        assert(worker?.Id && /^[a-f0-9]{64}$/.test(worker.Id), 'Update-Hilfscontainer konnte nicht erstellt werden.');
        workerId = worker.Id;
        job.workerId = worker.Id;
        await writeJson(jobPath(id, root), job);
        await api('/endpoints/' + config.endpointId + '/docker/containers/' + worker.Id + '/start', { method: 'POST' });
        return job;
    } catch (error) {
        if (workerId) {
            const worker = await inspect(api, config, workerId).catch(() => undefined);
            if (worker === undefined)
                throw new Error(
                    'Start des Updateauftrags ist unklar. Die Sperre bleibt zum Schutz vor Doppelstarts bestehen.',
                );
            if (worker?.State.Status === 'running') return await readJson(jobPath(id, root));
            if (worker)
                await api('/endpoints/' + config.endpointId + '/docker/containers/' + workerId, { method: 'DELETE' });
        }
        if (await exists(jobPath(id, root))) {
            const job = await readJson(jobPath(id, root));
            job.phase = 'failed';
            job.message = error.message;
            job.finished = new Date().toISOString();
            await writeJson(jobPath(id, root), job);
        }
        await releaseLock(id, root);
        throw error;
    }
}
export async function buildImage(api, config, context, commit, log) {
    const tag = 'suwayomi-private:git-' + commit;
    const path =
        '/endpoints/' +
        config.endpointId +
        '/docker/build?t=' +
        encodeURIComponent(tag) +
        '&dockerfile=Dockerfile&pull=false&rm=true&buildargs=' +
        encodeURIComponent(JSON.stringify({ PRIVATE_COMMIT: commit }));
    const response = await api(path, { method: 'POST', body: context, binary: true, timeout: 45 * 60 * 1000 });
    let pending = '';
    const line = async (text) => {
        if (!text.trim()) return;
        let value;
        try {
            value = JSON.parse(text);
        } catch {
            throw new Error('Docker lieferte eine ungültige Build-Antwort.');
        }
        if (value.error || value.errorDetail) {
            await log(String(value.error || value.errorDetail.message || 'Docker build error').slice(0, 2000));
            throw new Error('Docker-Build fehlgeschlagen. Build-Protokoll prüfen.');
        }
        if (value.stream) await log(value.stream.trim().slice(0, 2000));
    };
    for await (const chunk of response.body) {
        pending += Buffer.from(chunk).toString('utf8');
        assert(pending.length <= 1024 * 1024, 'Docker-Build-Antwort ist zu groß.');
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
            await line(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
        }
    }
    await line(pending);
    const image = await api('/endpoints/' + config.endpointId + '/docker/images/' + encodeURIComponent(tag) + '/json');
    assert(imageId(image?.Id), 'Neues Image wurde nicht erfolgreich gebaut.');
    return { tag, image: image.Id };
}
export async function deployTransaction(api, config, before, after, oldImage, targetImage, health = healthy) {
    assert(
        digest(await stackState(api, config)) === digest(before),
        'Stack wurde während des Builds geändert; Bereitstellung abgebrochen.',
    );
    try {
        await putStack(api, config, after);
        await health(api, config, targetImage);
    } catch (error) {
        const current = await stackState(api, config);
        if (digest(current) === digest(after)) await putStack(api, config, before);
        else
            assert(
                digest(current) === digest(before),
                'Stack wurde zwischenzeitlich geändert; automatischer Rückfall wurde ausgesetzt.',
            );
        await health(api, config, oldImage);
        throw new Error('Bereitstellung fehlgeschlagen; bisherige Version wiederhergestellt und geprüft.');
    }
}
export async function runJob(id) {
    assert(jobIdValid(id), 'Ungültige Auftragskennung.');
    const config = await loadConfig();
    const keys = await secrets();
    const api = portainerClient(config.portainerUrl, keys.portainer);
    const job = await readJson(jobPath(id));
    assert(
        (await readJson(lockPath + '/owner.json')).id === id && job.phase === 'queued',
        'Updateauftrag ist nicht mehr freigegeben.',
    );
    const phase = async (value, message = '') => {
        job.phase = value;
        job.message = message;
        await writeJson(jobPath(id), job);
    };
    let lastLog = 0;
    const log = async (value) => {
        if (!value) return;
        job.logs.push(
            timestampBuildLog(value.replaceAll(keys.github, '[hidden]').replaceAll(keys.portainer, '[hidden]')),
        );
        job.logs = job.logs.slice(-80);
        if (Date.now() - lastLog > 1000) {
            await writeJson(jobPath(id), job);
            lastLog = Date.now();
        }
    };
    try {
        await phase('checking');
        const before = await stackState(api, config);
        const current = await inspect(api, config, UI_CONTAINER);
        assert(current && imageId(current.Image), 'Bisherige Version fehlt.');
        let after, targetImage, snapshot;
        if (job.action === 'rollback') {
            snapshot = await readJson('/update/last-success.json');
            assert(
                snapshot.previousPrivateVersion && imageId(snapshot.oldImage),
                'Keine vorherige private Version verfügbar.',
            );
            assert(
                digest(before) === digest(snapshot.after),
                'Stack wurde seit dem letzten Update geändert; Rückfall abgebrochen.',
            );
            after = snapshot.before;
            targetImage = snapshot.oldImage;
        } else {
            const target = await resolveCommit(keys.github, job.target);
            assert(target.sha === job.target, 'Projektstand hat sich unerwartet geändert.');
            const metadata = await projectManifest(keys.github, target.sha);
            assert(
                job.serverRevision >= metadata.minimumServerRevision,
                'Dieser Projektstand benötigt einen neueren Suwayomi-Server.',
            );
            const tag = 'suwayomi-private:git-' + target.sha;
            after = { file: replaceUiImage(before.file, tag), env: before.env };
            if (after.file === before.file) {
                await phase('succeeded', 'Diese Version ist bereits installiert.');
                return;
            }
            await phase('downloading');
            const archive = await downloadArchive(keys.github, target.sha);
            const context = dockerContext(archive);
            await phase('building');
            const built = await buildImage(api, config, context, target.sha, log);
            targetImage = built.image;
        }
        await fs.mkdir('/update/backups', { recursive: true, mode: 0o700 });
        const backup = {
            before,
            after,
            oldImage: current.Image,
            targetImage,
            previousPrivateVersion: /^ {4}image:\s*suwayomi-private:git-[a-f0-9]{40}\s*$/m.test(before.file),
            job: id,
        };
        await writeJson('/update/backups/' + id + '.json', backup);
        await phase('deploying');
        await deployTransaction(api, config, before, after, current.Image, targetImage);
        if (job.action === 'update') await writeJson('/update/last-success.json', backup);
        else await fs.rm('/update/last-success.json', { force: true });
        await phase('succeeded', 'Bereitstellung und Startprüfung erfolgreich.');
    } catch (error) {
        await phase('failed', error.message);
    } finally {
        job.finished = new Date().toISOString();
        await writeJson(jobPath(id), job);
        await releaseLock(id);
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    runJob(process.argv[2]).catch((error) => {
        console.error('Suwayomi-Update: ' + error.message);
        process.exitCode = 1;
    });
