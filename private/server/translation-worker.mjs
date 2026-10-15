/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { createLogStore } from './logs.mjs';
import { readOcrPerformance } from './translation-performance.mjs';
import { boundedText, dockerLogText } from './log-utils.mjs';
import { assert, BASE, UI_CONTAINER, UI_SERVICE, imageId, inspect, writeJson, sleep } from './common.mjs';

// Use the already-built application image, so even the 0.3 updater can install this version.
// The CPU worker gets one staging directory, no network, keys, Docker socket or original mount.
export function createImageWorker({
    connection,
    stateRoot = '/update',
    poll = sleep,
    logs = createLogStore({ stateRoot }),
} = {}) {
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
        const supportsQuota = host.CpuCfsQuota === true && host.CpuCfsPeriod === true;
        const performance = await readOcrPerformance(stateRoot);
        const cpuCount = Math.max(1, Math.min(performance.maxCpus, host.NCPU || 2));
        // DSM kernels can lack CPU CFS quotas; pin the configured number of allowed CPUs instead where available.
        const allowedCpus =
            current.HostConfig?.CpusetCpus || Array.from({ length: host.NCPU || 2 }, (_, i) => i).join(',');
        const cpus = [];
        for (const part of allowedCpus.split(',')) {
            const [first, last = first] = part.split('-').map(Number);
            for (let i = first; Number.isInteger(i) && i <= last && cpus.length < cpuCount; i++) cpus.push(i);
            if (cpus.length >= cpuCount) break;
        }
        const limits = {
            ...(supportsQuota
                ? { NanoCpus: cpuCount * 1e9 }
                : host.CPUSet === true && cpus.length
                  ? { CpusetCpus: cpus.join(',') }
                  : host.CPUShares === true
                    ? { CpuShares: 512 }
                    : {}),
            ...(host.PidsLimit === true ? { PidsLimit: 128 } : {}),
        };
        await logs.write(
            'ocr',
            'INFO',
            `${operation}: Docker ${host.ServerVersion || '?'}; CPU-Quota=${host.CpuCfsQuota}; CPU-Period=${host.CpuCfsPeriod}; CPUSet=${host.CPUSet}; PidsLimit=${host.PidsLimit}; Limits=${JSON.stringify(limits)}`,
            job.id,
        );
        const root = `${stateRoot}/translations/${job.id}`;
        await fs.rm(root + '/worker-result.json', { force: true });
        await fs.rm(root + '/progress.json', { force: true });
        const threads = !supportsQuota && host.CPUSet === true && cpus.length ? cpus.length : cpuCount;
        const startedAt = new Date().toISOString();
        const resources = {
            profile: performance.profile,
            cpuCount: threads,
            memoryLimitBytes: 3 * 1024 ** 3,
            startedAt,
        };
        await writeJson(root + '/resources.json', resources);
        await writeJson(root + '/request.json', { operation, sourceLanguage: job.sourceLanguage, threads });
        let created;
        try {
            created = await api(
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
                            `OMP_NUM_THREADS=${threads}`,
                            `MKL_NUM_THREADS=${threads}`,
                            'PYTHONDONTWRITEBYTECODE=1',
                            'PYTHONUNBUFFERED=1',
                            `OPENBLAS_NUM_THREADS=${threads}`,
                            `OCR_THREADS=${threads}`,
                        ],
                        Labels: { 'io.suwayomi.private-translation': job.id },
                        HostConfig: {
                            NetworkMode: 'none',
                            ReadonlyRootfs: true,
                            CapDrop: ['ALL'],
                            SecurityOpt: ['no-new-privileges:true'],
                            Memory: 3 * 1024 ** 3,
                            ...limits,
                            Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m' },
                            Binds: [`${BASE}/updater/translations/${job.id}:/job`],
                        },
                    },
                },
            );
        } catch (error) {
            await logs.write('ocr', 'ERROR', 'OCR-Container erstellen: ' + error.message, job.id);
            throw new Error('OCR-Container konnte nicht erstellt werden: ' + error.message);
        }
        assert(/^[a-f0-9]{64}$/.test(created?.Id), 'OCR-Container konnte nicht erstellt werden.');
        const path = `/endpoints/${config.endpointId}/docker/containers/${created.Id}`;
        try {
            await api(path + '/start', { method: 'POST' });
            await logs.write('ocr', 'INFO', 'OCR-Container gestartet: ' + operation, job.id);
            const deadline = Date.now() + 4 * 60 * 60 * 1000;
            let lastProgress = '';
            let lastSample = 0;
            let previousCpu, previousSystem;

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
                    if (result.paused) {
                        const error = new Error('Bildverarbeitung an der letzten gespeicherten Seite pausiert.');
                        error.pause = true;
                        throw error;
                    }
                    return;
                }
                assert(worker.State.Status === 'running', 'Bildverarbeitung wurde nicht gestartet.');
                if (Date.now() - lastSample >= 10000) {
                    lastSample = Date.now();
                    try {
                        const stats = await api(path + '/stats?stream=false&one-shot=true', { timeout: 3000 });
                        const cpu = stats.cpu_stats?.cpu_usage?.total_usage;
                        const system = stats.cpu_stats?.system_cpu_usage;
                        const deltaCpu = cpu - previousCpu,
                            deltaSystem = system - previousSystem;
                        resources.cpuPercent =
                            Number.isFinite(deltaCpu) && deltaCpu >= 0 && deltaSystem > 0
                                ? (deltaCpu / deltaSystem) * (stats.cpu_stats?.online_cpus || host.NCPU || 1) * 100
                                : null;
                        resources.memoryUsageBytes = stats.memory_stats?.usage ?? null;
                        resources.sampledAt = new Date().toISOString();
                        previousCpu = cpu;
                        previousSystem = system;
                        await writeJson(root + '/resources.json', resources);
                    } catch {
                        /* Optional monitoring must not interrupt OCR on older Docker endpoints. */
                    }
                }
                const progress = await fs.readFile(root + '/progress.json', 'utf8').catch(() => '');
                if (progress && progress !== lastProgress) {
                    lastProgress = progress;
                    await logs.write('ocr', 'INFO', 'Fortschritt: ' + progress, job.id);
                }
                await poll(1500);
            }
            throw new Error(
                signal.aborted ? 'Bildverarbeitung abgebrochen.' : 'Bildverarbeitung hat das Zeitlimit erreicht.',
            );
        } catch (error) {
            await logs.write('ocr', error.pause ? 'INFO' : 'ERROR', operation + ': ' + error.message, job.id);
            throw error;
        } finally {
            // Only remove our exact, labelled helper, never any existing Suwayomi container.
            const worker = await inspect(api, config, created.Id).catch(() => null);
            if (worker?.Config.Labels?.['io.suwayomi.private-translation'] === job.id) {
                if (worker.State.Running) await api(path + '/stop?t=10', { method: 'POST' });
                try {
                    const response = await api(path + '/logs?stdout=true&stderr=true&timestamps=true&tail=300', {
                        binary: true,
                        timeout: 15000,
                    });
                    await logs.write('ocr', 'OUTPUT', dockerLogText(await boundedText(response)), job.id);
                } catch (error) {
                    await logs.write('ocr', 'WARN', 'Worker-Ausgabe nicht verfügbar: ' + error.message, job.id);
                }
                await api(path, { method: 'DELETE' });
            }
        }
    };
    run.recover = recover;
    return run;
}
