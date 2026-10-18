/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BASE,
    UI_CONTAINER,
    assert,
    imageId,
    readJson,
    writeJson,
    exists,
    inspect,
    sleep,
    loadConfig,
    secrets,
    portainerClient,
} from './common.mjs';
import { boundedText, dockerLogText } from './log-utils.mjs';

export const TRANSLATOR = 'suwayomi-cloud-translator';
export const TRANSLATOR_ROOT = '/volume3/docker/suwayomi-translator';
export const PYTHON = '/opt/translator-runtime/bin/python3.12';
export const RUNTIME_ENV = [
    'PYTHONHOME=/opt/translator-runtime',
    'LD_LIBRARY_PATH=/opt/translator-runtime/lib',
    'PATH=/opt/translator-runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'PYTHONDONTWRITEBYTECODE=1',
    'PYTHONUNBUFFERED=1',
    'HOME=/tmp',
    'OMP_NUM_THREADS=1',
    'OPENBLAS_NUM_THREADS=1',
    'MKL_NUM_THREADS=1',
];
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const recordPath = (root, id) => root + '/translator-updates/' + id + '.json';
const path = (config, suffix) => '/endpoints/' + config.endpointId + '/docker/' + suffix;
const marker = 'io.suwayomi.translator-update';

export async function translatorHealth(fetchImpl = fetch) {
    try {
        const response = await fetchImpl('http://127.0.0.1:18083/healthz', {
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
        });
        const value = response.ok ? await response.json() : null;
        assert(
            value?.status === 'ok' && value.service === TRANSLATOR && value.model === 'gpt-6-astra',
            'Unerwarteter Uebersetzungsdienst.',
        );
        return value;
    } catch {
        return null;
    }
}

export function validateTranslator(container) {
    assert(
        container &&
            /^[a-f0-9]{64}$/.test(container.Id || '') &&
            imageId(container.Image) &&
            container.Config.User === '10001:10001' &&
            container.Config.Labels?.['com.docker.compose.project'] === 'suwayomi-translator' &&
            container.Config.Labels?.['com.docker.compose.service'] === 'translator',
        'Der vorhandene Uebersetzungsdienst wurde nicht eindeutig erkannt.',
    );
    assert(
        container.Mounts?.length === 2 &&
            container.Mounts.some(
                (m) => m.Type === 'bind' && m.Source === TRANSLATOR_ROOT + '/data' && m.Destination === '/data' && m.RW,
            ) &&
            container.Mounts.some(
                (m) =>
                    m.Type === 'bind' &&
                    m.Source === TRANSLATOR_ROOT + '/secrets' &&
                    m.Destination === '/run/secrets' &&
                    !m.RW,
            ),
        'Daten-/Schluesselmounts des Uebersetzungsdienstes stimmen nicht ueberein.',
    );
    assert(
        JSON.stringify(container.HostConfig.PortBindings) ===
            JSON.stringify({ '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18083' }] }) &&
            !container.HostConfig.Privileged &&
            container.HostConfig.ReadonlyRootfs,
        'Port oder Schutzkonfiguration des Uebersetzungsdienstes ist unerwartet.',
    );
    assert(
        /^[A-Za-z0-9_.-]+$/.test(container.HostConfig.NetworkMode || '') &&
            !['host', 'none'].includes(container.HostConfig.NetworkMode),
        'Netzwerk des Uebersetzungsdienstes ist unerwartet.',
    );
}

export function translatorSpec(container, targetImage, id, version) {
    validateTranslator(container);
    assert(imageId(targetImage) && validId(id), 'Ungueltiges Dienst-Updateziel.');
    return {
        Image: targetImage,
        User: '10001:10001',
        Env: RUNTIME_ENV,
        Entrypoint: [PYTHON],
        Cmd: ['-u', '/opt/translator/server/http_service.py'],
        WorkingDir: '/opt/translator',
        StopTimeout: 35,
        Labels: { ...container.Config.Labels, [marker]: id, 'io.suwayomi.translator.version': version },
        ExposedPorts: { '8080/tcp': {} },
        Healthcheck: {
            Test: [
                'CMD',
                PYTHON,
                '-c',
                'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/healthz",timeout=5)',
            ],
            Interval: 30e9,
            Timeout: 6e9,
            StartPeriod: 10e9,
            Retries: 3,
        },
        HostConfig: {
            Binds: [TRANSLATOR_ROOT + '/data:/data', TRANSLATOR_ROOT + '/secrets:/run/secrets:ro'],
            PortBindings: container.HostConfig.PortBindings,
            NetworkMode: container.HostConfig.NetworkMode,
            RestartPolicy: container.HostConfig.RestartPolicy || { Name: 'unless-stopped' },
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            Memory: container.HostConfig.Memory || 3 * 1024 ** 3,
            Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777' },
            ...(container.HostConfig.CpusetCpus ? { CpusetCpus: container.HostConfig.CpusetCpus } : {}),
            ...(container.HostConfig.LogConfig ? { LogConfig: container.HostConfig.LogConfig } : {}),
        },
    };
}

export async function offlineTest(api, config, image, id) {
    const created = await api(path(config, 'containers/create?name=suwayomi-translator-selftest-' + id), {
        method: 'POST',
        body: {
            Image: image,
            User: '10001:10001',
            Env: RUNTIME_ENV,
            Entrypoint: [PYTHON],
            Cmd: ['/opt/translator/server/selftest.py'],
            WorkingDir: '/opt/translator',
            Labels: { [marker]: id },
            HostConfig: {
                NetworkMode: 'none',
                ReadonlyRootfs: true,
                Memory: 1024 ** 3,
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges:true'],
                Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777' },
            },
        },
    });
    assert(/^[a-f0-9]{64}$/.test(created?.Id || ''), 'Offline-Testcontainer fehlt.');
    try {
        await api(path(config, 'containers/' + created.Id + '/start'), { method: 'POST' });
        const result = await api(path(config, 'containers/' + created.Id + '/wait?condition=not-running'), {
            method: 'POST',
            timeout: 90000,
        });
        assert(result?.StatusCode === 0, 'Offline-Selbsttest des Uebersetzers ist fehlgeschlagen.');
        const logs = await api(path(config, 'containers/' + created.Id + '/logs?stdout=true&stderr=true&tail=10'), {
            binary: true,
        });
        const text = dockerLogText(await boundedText(logs, 16384));
        const last = text.trim().split('\n').at(-1);
        let status;
        try {
            status = JSON.parse(last);
        } catch {}
        assert(
            status?.offline_selftest === 'ok' &&
                status?.image_formats === 'ok' &&
                status.heic === 'ok' &&
                status.pdf === 'ok' &&
                status.google_requests === 0 &&
                status.openai_requests === 0,
            'Offline-Selbsttest hat Formate oder Nullverbrauch nicht bestaetigt.',
        );
    } finally {
        await api(path(config, 'containers/' + created.Id + '?force=1&v=0'), { method: 'DELETE' }).catch(() => {});
    }
}

async function serviceReady(api, config, image, version, credentials, fetchImpl, wait) {
    for (let attempt = 0; attempt < 30; attempt++) {
        const container = await inspect(api, config, TRANSLATOR);
        const health = await translatorHealth(fetchImpl);
        if (
            container?.Image === image &&
            container.State.Status === 'running' &&
            health?.version === version &&
            health.api_requests_on_startup === 0 &&
            ['openai', 'google'].every((key) => health.credentials?.[key] === credentials[key]) &&
            health.control_token_configured === credentials.control
        )
            return;
        await wait(500);
    }
    throw new Error('Startpruefung des Uebersetzungsdienstes fehlgeschlagen.');
}

async function restore(api, config, record, fetchImpl, wait) {
    const current = await inspect(api, config, TRANSLATOR);
    if (current && current.Id !== record.oldId) {
        assert(
            current.Image === record.targetImage && current.Config.Labels?.[marker] === record.id,
            'Dienst wurde parallel geaendert; kein fremder Container wird entfernt.',
        );
        await api(path(config, 'containers/' + current.Id + '?force=1&v=0'), { method: 'DELETE' });
    }
    const old = await inspect(api, config, record.oldId);
    assert(old?.Image === record.oldImage, 'Bisheriger Dienstcontainer fehlt; Daten und Schluessel bleiben erhalten.');
    if (old.Name !== '/' + TRANSLATOR)
        await api(path(config, 'containers/' + old.Id + '/rename?name=' + TRANSLATOR), { method: 'POST' });
    if (old.State.Status !== 'running') await api(path(config, 'containers/' + old.Id + '/start'), { method: 'POST' });
    await serviceReady(api, config, record.oldImage, record.oldVersion, record.credentials, fetchImpl, wait);
}

export async function upgradeTranslator(
    api,
    config,
    { id, image, version, root = '/update', fetchImpl = fetch, wait = sleep, authorize = async () => {} } = {},
) {
    assert(validId(id) && imageId(image) && /^\d+\.\d+\.\d+$/.test(version), 'Ungueltiger Dienstauftrag.');
    await fs.mkdir(root + '/translator-updates', { recursive: true, mode: 0o700 });
    const file = recordPath(root, id);
    let record = (await exists(file)) ? await readJson(file) : {};
    assert(!record.targetImage || record.targetImage === image, 'Dienstauftrag gehoert zu einem anderen Image.');
    record = { ...record, id, targetImage: image, version };
    const save = async (status, message) => {
        Object.assign(record, { status, message, updated: new Date().toISOString() });
        await writeJson(file, record);
    };
    if (record.status === 'succeeded') return record;
    if (record.status === 'failed') throw new Error(record.message);
    let changed = ['stopping', 'replacing', 'starting'].includes(record.status);
    try {
        await authorize();
        if (changed) {
            // An interrupted helper restores the known old container instead
            // of silently treating a partially deployed service as installed.
            await restore(api, config, record, fetchImpl, wait);
            changed = false;
            throw new Error('Unterbrochenes Dienst-Update wurde auf den bisherigen Dienst zurueckgesetzt.');
        }
        const old = await inspect(api, config, TRANSLATOR);
        if (!old) {
            record.noop = true;
            await save('succeeded', 'Kein separater Uebersetzungsdienst eingerichtet; WebUI aktualisiert.');
            return record;
        }
        validateTranslator(old);
        const before = await translatorHealth(fetchImpl);
        assert(before && old.State.Status === 'running', 'Bisheriger Uebersetzungsdienst ist nicht erreichbar.');
        assert(
            before.queued_jobs === 0 && before.running_jobs === 0,
            'Uebersetzungsdienst verarbeitet noch Auftraege.',
        );
        if (before.version === version) {
            record.installedImage = old.Image;
            record.noop = true;
            await save('succeeded', 'Uebersetzungsdienst ' + version + ' ist bereits aktuell.');
            return record;
        }
        await save('testing', 'Uebersetzungsdienst offline auf Bildformate und PDF pruefen.');
        await offlineTest(api, config, image, id);
        await authorize();
        const latest = await inspect(api, config, TRANSLATOR);
        const health = await translatorHealth(fetchImpl);
        assert(
            latest?.Id === old.Id &&
                latest.Image === old.Image &&
                health &&
                health.queued_jobs === 0 &&
                health.running_jobs === 0,
            'Uebersetzungsdienst wurde waehrend der Pruefung geaendert oder ist beschaeftigt.',
        );
        Object.assign(record, {
            oldId: old.Id,
            oldImage: old.Image,
            oldVersion: before.version,
            credentials: { ...before.credentials, control: before.control_token_configured },
            backupName: TRANSLATOR + '-backup-' + id,
        });
        await save('stopping', 'Geprueften Uebersetzungsdienst austauschen; Daten und Schluessel behalten.');
        changed = true;
        await api(path(config, 'containers/' + old.Id + '/stop?t=35'), { method: 'POST' });
        const stopped = await inspect(api, config, old.Id);
        assert(
            stopped?.State.Status === 'exited' && stopped.State.ExitCode !== 137,
            'Dienst wurde nicht sauber beendet.',
        );
        await api(path(config, 'containers/' + old.Id + '/rename?name=' + record.backupName), { method: 'POST' });
        await save('replacing', 'Neue Dienstversion erstellen.');
        const created = await api(path(config, 'containers/create?name=' + TRANSLATOR), {
            method: 'POST',
            body: translatorSpec(old, image, id, version),
        });
        assert(/^[a-f0-9]{64}$/.test(created?.Id || ''), 'Neuer Dienstcontainer fehlt.');
        record.newId = created.Id;
        await save('starting', 'Neue Dienstversion und gespeicherte Schluessel pruefen.');
        await api(path(config, 'containers/' + created.Id + '/start'), { method: 'POST' });
        await serviceReady(api, config, image, version, record.credentials, fetchImpl, wait);
        await authorize();
        record.installedImage = image;
        await save('succeeded', 'Uebersetzungsdienst ' + version + ' aktualisiert und geprueft; 0 Cloud-Anfragen.');
        return record;
    } catch (error) {
        if (changed) {
            try {
                await restore(api, config, record, fetchImpl, wait);
            } catch (rollbackError) {
                await save('failed', error.message + ' Rueckfall: ' + rollbackError.message);
                throw new Error(record.message);
            }
        }
        await save('failed', error.message + (changed ? ' Bisheriger Dienst wiederhergestellt.' : ''));
        throw new Error(record.message);
    }
}

export function translatorBootstrap({ manifest, root = '/update', connection, fetchImpl = fetch, wait = sleep } = {}) {
    let state = { ready: false, status: 'checking', message: 'Uebersetzungsdienst pruefen.' },
        started;
    const status = () => ({ ...state });
    const start = () =>
        (started ||= (async () => {
            try {
                if (!manifest.translatorVersion || !(await exists(root + '/latest-job.json'))) {
                    state = { ready: true, status: 'not_requested' };
                    return;
                }
                const latest = await readJson(root + '/latest-job.json');
                assert(validId(latest.id), 'Ungueltiger gespeicherter Updateauftrag.');
                const job = await readJson(root + '/jobs/' + latest.id + '.json');
                // A normal restart or explicit UI rollback never upgrades a service.
                if (job.action !== 'update' || job.target !== manifest.commit || job.phase !== 'deploying') {
                    state = { ready: true, status: 'not_requested' };
                    return;
                }
                const { api, config } = await connection();
                assert((await api(path(config, 'info'))).ID === config.daemonId, 'Docker-Dienst wurde geaendert.');
                const ui = await inspect(api, config, UI_CONTAINER);
                assert(
                    imageId(ui?.Image) &&
                        ui.Config.Labels?.['com.docker.compose.project'] === 'suwayomi' &&
                        ui.Config.Labels?.['io.suwayomi.translator.version'] === manifest.translatorVersion,
                    'Gebundelter Uebersetzungsdienst fehlt im neuen Image.',
                );
                await fs.mkdir(root + '/translator-updates', { recursive: true, mode: 0o700 });
                const file = recordPath(root, job.id);
                let record = (await exists(file)) ? await readJson(file) : null;
                assert(
                    !record?.targetImage || record.targetImage === ui.Image,
                    'Dienstauftrag gehoert zu einem anderen Image.',
                );
                if (record?.status === 'failed') throw new Error(record.message);
                if (record?.status !== 'succeeded') {
                    let worker = await inspect(api, config, record?.workerId || 'suwayomi-translator-update-' + job.id);
                    if (worker)
                        assert(
                            worker.Image === ui.Image && worker.Config.Labels?.[marker] === job.id,
                            'Vorhandener Dienst-Updatehelfer gehoert zu einem anderen Auftrag.',
                        );
                    let launch = worker?.State.Status !== 'running';
                    if (worker?.State.Status === 'created') {
                        record = {
                            ...record,
                            id: job.id,
                            targetImage: ui.Image,
                            version: manifest.translatorVersion,
                            workerId: worker.Id,
                        };
                        await writeJson(file, record);
                        await api(path(config, 'containers/' + worker.Id + '/start'), { method: 'POST' });
                        launch = false;
                    }
                    // A fast helper may finish and auto-remove between the first
                    // receipt read and Docker inspect. Never overwrite its result.
                    record = (await exists(file)) ? await readJson(file) : null;
                    if (record?.status === 'failed') throw new Error(record.message);
                    if (launch && record?.status !== 'succeeded') {
                        if (worker)
                            await api(path(config, 'containers/' + worker.Id + '?force=1&v=0'), { method: 'DELETE' });
                        const request = {
                            ...record,
                            id: job.id,
                            targetImage: ui.Image,
                            version: manifest.translatorVersion,
                        };
                        await writeJson(file, request);
                        const helper = await api(
                            path(config, 'containers/create?name=suwayomi-translator-update-' + job.id),
                            {
                                method: 'POST',
                                body: {
                                    Image: ui.Image,
                                    User: '0:0',
                                    WorkingDir: '/app',
                                    Entrypoint: ['node', '--dns-result-order=ipv4first'],
                                    Cmd: ['private/server/translator-update.mjs', job.id],
                                    Labels: { [marker]: job.id },
                                    HostConfig: {
                                        NetworkMode: 'host',
                                        ReadonlyRootfs: true,
                                        AutoRemove: true,
                                        CapDrop: ['ALL'],
                                        SecurityOpt: ['no-new-privileges:true'],
                                        Memory: 512 * 1024 ** 2,
                                        Binds: [BASE + '/updater:/update', BASE + '/secrets:/secrets:ro'],
                                    },
                                },
                            },
                        );
                        assert(
                            /^[a-f0-9]{64}$/.test(helper?.Id || ''),
                            'Dienst-Updatehelfer konnte nicht erstellt werden.',
                        );
                        request.workerId = helper.Id;
                        await writeJson(file, request);
                        await api(path(config, 'containers/' + helper.Id + '/start'), { method: 'POST' });
                    }
                }
                for (let attempt = 0; attempt < 180; attempt++) {
                    record = await readJson(file);
                    state = {
                        ready: false,
                        status: record.status || 'checking',
                        message: record.message || 'Uebersetzungsdienst aktualisieren.',
                    };
                    if (record.status === 'failed') throw new Error(record.message);
                    if (record.status === 'succeeded') {
                        state.ready = true;
                        return;
                    }
                    await wait(1000);
                }
                throw new Error('Zeitlimit beim integrierten Dienst-Update.');
            } catch (error) {
                state = { ready: false, status: 'failed', message: error.message };
            }
        })());
    return { start, status };
}

async function main(id) {
    assert(validId(id), 'Ungueltiger Dienst-Updateauftrag.');
    const manifest = await readJson('private/manifest.json');
    const config = await loadConfig();
    const keys = await secrets();
    const api = portainerClient(config.portainerUrl, keys.portainer);
    assert((await api(path(config, 'info'))).ID === config.daemonId, 'Docker-Dienst wurde geaendert.');
    const request = await readJson(recordPath('/update', id));
    const authorize = async () => {
        const job = await readJson('/update/jobs/' + id + '.json');
        assert(
            job.action === 'update' && job.target === manifest.commit && ['deploying', 'succeeded'].includes(job.phase),
            'Dienst-Update gehoert nicht mehr zum gestarteten Suwayomi-Update.',
        );
    };
    await upgradeTranslator(api, config, {
        id,
        image: request.targetImage,
        version: manifest.translatorVersion,
        authorize,
    });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main(process.argv[2]).catch(async (error) => {
        try {
            const file = recordPath('/update', process.argv[2]);
            if (validId(process.argv[2]) && (await exists(file))) {
                const record = await readJson(file);
                if (record.status !== 'failed')
                    await writeJson(file, { ...record, status: 'failed', message: error.message });
            }
        } catch {}
        process.exitCode = 1;
    });
