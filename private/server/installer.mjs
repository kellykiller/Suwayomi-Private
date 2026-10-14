/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
    BASE,
    REPOSITORY,
    UI_CONTAINER,
    UI_SERVICE,
    assert,
    sha,
    imageId,
    digest,
    readJson,
    writeJson,
    portainerClient,
    secrets,
    resolveCommit,
    downloadArchive,
    dockerContext,
    addPrivateService,
    stackState,
    putStack,
    inspect,
    healthy,
} from './common.mjs';

const [command, commit, daemon] = process.argv.slice(2);
const work = '/work';
async function prepare() {
    assert(sha(commit) && daemon, 'Commit und Docker-Kennung sind erforderlich.');
    const connection = await readJson('/update/connection.json');
    assert(
        connection.stackName === 'suwayomi' &&
            connection.containerName === 'suwayomi' &&
            connection.dataPath === BASE + '/data',
        'Gespeicherte Suwayomi-Verbindung passt nicht zur abgeschlossenen Migration.',
    );
    const keys = await secrets();
    const api = portainerClient(connection.portainerUrl, keys.portainer);
    const config = {
        repository: REPOSITORY,
        stackName: 'suwayomi',
        stackId: connection.stackId,
        endpointId: connection.endpointId,
        daemonId: daemon,
        serviceName: UI_SERVICE,
        containerName: UI_CONTAINER,
        hostRoot: BASE,
        portainerUrl: connection.portainerUrl,
        origins: ['https://hlp2-nas01-p.chickenfight.de', 'http://192.168.175.60:18081'],
    };
    const before = await stackState(api, config);
    assert(
        !(await inspect(api, config, UI_CONTAINER)),
        'Private WebUI ist bereits eingerichtet. Weitere Updates über Einstellungen → Private Updates ausführen.',
    );
    const backend = await inspect(api, config, 'suwayomi');
    assert(
        backend &&
            backend.State.Status === 'running' &&
            backend.Config.User === '1026:100' &&
            backend.Config.Labels['com.docker.compose.project'] === 'suwayomi' &&
            imageId(backend.Image),
        'Bestehender Suwayomi-Container passt nicht zur Einrichtung.',
    );
    assert(
        backend.Mounts.length === 1 &&
            backend.Mounts[0].Source === BASE + '/data' &&
            backend.Mounts[0].Destination === '/home/suwayomi/.local/share/Tachidesk',
        'Suwayomi-Datenpfad stimmt nicht überein.',
    );
    assert(
        digest(backend.HostConfig.PortBindings) ===
            digest({ '4567/tcp': [{ HostIp: '192.168.175.60', HostPort: '18081' }] }),
        'Bestehende Portzuordnung ist nicht die bestätigte Konfiguration.',
    );
    const containers = await api('/endpoints/' + config.endpointId + '/docker/containers/json?all=1');
    assert(
        !containers.some(
            (item) =>
                item.Id !== backend.Id &&
                item.Ports?.some(
                    (port) => port.PublicPort === 18082 && ['0.0.0.0', '192.168.175.60', '::'].includes(port.IP),
                ),
        ),
        'Fallback-Port 18082 ist bereits belegt.',
    );
    const resolved = await resolveCommit(keys.github, commit);
    assert(resolved.sha === commit, 'GitHub-Projektstand stimmt nicht überein.');
    const after = { file: addPrivateService(before.file, config, commit), env: before.env };
    const id = randomUUID();
    const state = { config, before, after, backend, commit, id };
    await fs.mkdir('/update/private-update.lock', { mode: 0o700 }).catch((error) => {
        if (error.code === 'EEXIST') throw new Error('Ein Installations- oder Updateauftrag ist bereits gesperrt.');
        throw error;
    });
    await writeJson('/update/private-update.lock/owner.json', { id });
    await writeJson(work + '/state.json', state);
    await fs.mkdir('/update/jobs', { recursive: true, mode: 0o700 });
    await writeJson('/update/jobs/' + id + '.json', {
        id,
        action: 'install',
        target: commit,
        phase: 'downloading',
        started: new Date().toISOString(),
        finished: null,
        logs: [],
        message: '',
    });
    await writeJson('/update/latest-job.json', { id });
    await writeJson(work + '/state.json', state);
    await fs.mkdir('/update/backups', { recursive: true, mode: 0o700 });
    await writeJson('/update/backups/install-' + id + '.json', state);
    const archive = await downloadArchive(keys.github, commit);
    dockerContext(archive);
    await fs.writeFile(work + '/source.tar.gz', archive, { mode: 0o600 });
    await writeJson('/update/private-config.json', config);
    const job = await readJson('/update/jobs/' + id + '.json');
    job.phase = 'building';
    await writeJson('/update/jobs/' + id + '.json', job);
    console.log('Vorprüfung erfolgreich. Der vollständige WebUI-Quellcode wurde geladen.');
}
export function verifyBackend(actual, before, port = '18082') {
    assert(
        actual &&
            actual.State?.Status === 'running' &&
            actual.Image === before.Image &&
            actual.Config.User === before.Config.User &&
            digest([...(actual.Config.Env || [])].sort()) === digest([...(before.Config.Env || [])].sort()) &&
            digest(actual.Mounts) === digest(before.Mounts),
        'Suwayomi-Image, Zugang oder Datenmount haben sich unerwartet geändert.',
    );
    assert(
        digest(actual.HostConfig.PortBindings) ===
            digest({ '4567/tcp': [{ HostIp: '192.168.175.60', HostPort: port }] }),
        'Neue Suwayomi-Fallback-Portzuordnung stimmt nicht.',
    );
}
async function deploy() {
    const state = await readJson(work + '/state.json');
    const keys = await secrets();
    const api = portainerClient(state.config.portainerUrl, keys.portainer);
    const targetImage = (await fs.readFile(work + '/new-image.id', 'utf8')).trim();
    assert(imageId(targetImage), 'Neues privates Image fehlt.');
    assert(
        digest(await stackState(api, state.config)) === digest(state.before),
        'Stack wurde während des Builds geändert; keine Bereitstellung vorgenommen.',
    );
    const job = await readJson('/update/jobs/' + state.id + '.json');
    job.phase = 'deploying';
    await writeJson('/update/jobs/' + state.id + '.json', job);
    let stopped = false;
    try {
        stopped = true;
        await api('/endpoints/' + state.config.endpointId + '/docker/containers/' + state.backend.Id + '/stop?t=90', {
            method: 'POST',
        });
        const closed = await inspect(api, state.config, 'suwayomi');
        assert(
            closed?.State.Status === 'exited' && closed.State.ExitCode !== 137,
            'Suwayomi wurde nicht sauber beendet.',
        );
        await putStack(api, state.config, state.after);
        await healthy(api, state.config, targetImage);
        verifyBackend(await inspect(api, state.config, 'suwayomi'), state.backend);
        state.completed = true;
        await writeJson(work + '/state.json', state);
        await writeJson('/update/backups/install-' + state.id + '.json', state);
        job.phase = 'succeeded';
        job.finished = new Date().toISOString();
        job.message = 'Private WebUI installiert; Suwayomi-Daten und Anmeldung sind erhalten.';
        await writeJson('/update/jobs/' + state.id + '.json', job);
        await fs.rm('/update/private-update.lock', { recursive: true });
        console.log('Suwayomi-Private ist healthy. HTTPS-Adresse und Anmeldung bleiben gleich.');
        console.log('Private Oberfläche: Port 18081\nOriginaloberfläche als Rückfall: Port 18082');
    } catch (error) {
        if (state.completed) throw error;
        try {
            const current = await stackState(api, state.config);
            if (digest(current) === digest(state.after)) {
                // Remove only our freshly installed service when restoring the original stack.
                await api('/stacks/' + state.config.stackId + '?endpointId=' + state.config.endpointId, {
                    method: 'PUT',
                    body: { StackFileContent: state.before.file, Env: state.before.env, PullImage: false, Prune: true },
                });
            } else assert(digest(current) === digest(state.before), 'Stack wurde zwischenzeitlich verändert.');
            const original = await inspect(api, state.config, 'suwayomi');
            if (stopped && original?.State.Status !== 'running')
                await api('/endpoints/' + state.config.endpointId + '/docker/containers/' + original.Id + '/start', {
                    method: 'POST',
                });
            verifyBackend(await inspect(api, state.config, 'suwayomi'), state.backend, '18081');
            throw new Error(
                'Installation fehlgeschlagen: ' +
                    error.message +
                    ' Die ursprüngliche Stack-Konfiguration wurde wiederhergestellt.',
            );
        } catch (restoreError) {
            throw restoreError;
        }
    }
}
async function fail() {
    let state;
    try {
        state = await readJson(work + '/state.json');
    } catch {
        return;
    }
    if (state.completed) return;
    const path = '/update/jobs/' + state.id + '.json';
    const job = await readJson(path).catch(() => ({ id: state.id, action: 'install', logs: [] }));
    job.phase = 'failed';
    job.finished = new Date().toISOString();
    job.message = 'NAS-Installation abgebrochen. Die vollständige SSH-Ausgabe prüfen.';
    await writeJson(path, job);
    if ((await readJson('/update/private-update.lock/owner.json').catch(() => ({}))).id === state.id)
        await fs.rm('/update/private-update.lock', { recursive: true });
}
if (['prepare', 'deploy', 'fail'].includes(command)) {
    (command === 'prepare' ? prepare() : command === 'deploy' ? deploy() : fail()).catch((error) => {
        console.error('Suwayomi-Private: ' + error.message);
        process.exitCode = 1;
    });
}
