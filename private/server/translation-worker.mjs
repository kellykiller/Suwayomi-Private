/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { assert, BASE, UI_CONTAINER, UI_SERVICE, imageId, inspect, writeJson, sleep } from './common.mjs';

// Use the already-built application image, so even the 0.3 updater can install this version.
// The CPU worker gets one staging directory, no network, keys, Docker socket or original mount.
export function createImageWorker({ connection, stateRoot = '/update', poll = sleep } = {}) {
    const recover = async (job) => {
        const { api, config } = await connection();
        const worker = await inspect(api, config, `suwayomi-ocr-${job.id}`);
        if (!worker) return;
        assert(
            worker.Config.Labels?.['io.suwayomi.private-translation'] === job.id,
            'Gleichnamiger Container gehört nicht zur Kapitelverarbeitung.',
        );
        const path = `/endpoints/${config.endpointId}/docker/containers/${worker.Id}`;
        if (worker.State.Running) await api(path + '/stop?t=10', { method: 'POST' });
        await api(path, { method: 'DELETE' });
    };
    const run = async (job, operation, signal) => {
        signal.throwIfAborted();
        await recover(job);
        const { api, config } = await connection();
        const current = await inspect(api, config, UI_CONTAINER);
        const host = await api(`/endpoints/${config.endpointId}/docker/info`);
        assert(
            host.MemTotal >= 4 * 1024 ** 3,
            'Für den lokalen OCR-Worker werden mindestens 4 GiB NAS-Arbeitsspeicher benötigt.',
        );
        assert(
            current &&
                imageId(current.Image) &&
                current.Config.Labels?.['com.docker.compose.project'] === 'suwayomi' &&
                current.Config.Labels?.['com.docker.compose.service'] === UI_SERVICE,
            'Private WebUI für den Bildverarbeitungs-Worker fehlt.',
        );
        const root = `${stateRoot}/translations/${job.id}`;
        await fs.rm(root + '/worker-result.json', { force: true });
        await fs.rm(root + '/progress.json', { force: true });
        await writeJson(root + '/request.json', { operation, sourceLanguage: job.sourceLanguage });
        const created = await api(
            `/endpoints/${config.endpointId}/docker/containers/create?name=suwayomi-ocr-${job.id}`,
            {
                method: 'POST',
                body: {
                    Image: current.Image,
                    User: '0:0',
                    Entrypoint: ['/opt/ocr/bin/python'],
                    Cmd: ['/app/private/translation/worker.py', '/job'],
                    Env: [
                        'HF_HUB_OFFLINE=1',
                        'TRANSFORMERS_OFFLINE=1',
                        'HF_HOME=/tmp/hf',
                        'EASYOCR_MODULE_PATH=/tmp/easyocr',
                        'OMP_NUM_THREADS=2',
                        'MKL_NUM_THREADS=2',
                        'PYTHONDONTWRITEBYTECODE=1',
                        'PYTHONUNBUFFERED=1',
                    ],
                    Labels: { 'io.suwayomi.private-translation': job.id },
                    HostConfig: {
                        NetworkMode: 'none',
                        ReadonlyRootfs: true,
                        CapDrop: ['ALL'],
                        SecurityOpt: ['no-new-privileges:true'],
                        Memory: 3 * 1024 ** 3,
                        NanoCpus: Math.min(2, host.NCPU || 2) * 1e9,
                        PidsLimit: 128,
                        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m' },
                        Binds: [`${BASE}/updater/translations/${job.id}:/job`],
                    },
                },
            },
        );
        assert(/^[a-f0-9]{64}$/.test(created?.Id), 'OCR-Container konnte nicht erstellt werden.');
        const path = `/endpoints/${config.endpointId}/docker/containers/${created.Id}`;
        try {
            await api(path + '/start', { method: 'POST' });
            const deadline = Date.now() + 60 * 60 * 1000;
            while (!signal.aborted && Date.now() < deadline) {
                const worker = await inspect(api, config, created.Id);
                assert(
                    worker?.Config.Labels?.['io.suwayomi.private-translation'] === job.id,
                    'OCR-Worker gehört nicht zu diesem Auftrag.',
                );
                if (worker.State.Status === 'exited') {
                    const result = await fs
                        .readFile(root + '/worker-result.json', 'utf8')
                        .then(JSON.parse)
                        .catch(() => null);
                    assert(
                        worker.State.ExitCode === 0 && result?.ok,
                        result?.error ||
                            (worker.State.OOMKilled
                                ? 'OCR-Arbeitsspeicherlimit erreicht.'
                                : 'Bildverarbeitung fehlgeschlagen.'),
                    );
                    return;
                }
                assert(worker.State.Status === 'running', 'Bildverarbeitung wurde nicht gestartet.');
                await poll(1500);
            }
            throw new Error(
                signal.aborted ? 'Bildverarbeitung abgebrochen.' : 'Bildverarbeitung hat das Zeitlimit erreicht.',
            );
        } finally {
            // Only remove our exact, labelled helper, never any existing Suwayomi container.
            const worker = await inspect(api, config, created.Id).catch(() => null);
            if (worker?.Config.Labels?.['io.suwayomi.private-translation'] === job.id) {
                if (worker.State.Running) await api(path + '/stop?t=10', { method: 'POST' });
                await api(path, { method: 'DELETE' });
            }
        }
    };
    run.recover = recover;
    return run;
}
