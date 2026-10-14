/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { assert, readJson, writeJson } from './common.mjs';

// Standard USD prices per million tokens, checked against the official model pages.
export const AI_PRICES = {
    'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
    'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
};
export const PRICE_DATE = '2026-10-14';
const USD = 1e9;
const dollars = (value) => (value === null ? null : value / USD);
export function estimateCost(model, usage, tier = 'default') {
    if (typeof model !== 'string') return null;
    const name = Object.keys(AI_PRICES).find((name) => model === name || model.startsWith(name + '-20'));
    const price = AI_PRICES[name];
    if (!price || tier !== 'default' || !usage) return null;
    const { inputTokens, outputTokens, cachedInputTokens = 0, reasoningTokens = 0 } = usage;
    if (
        ![inputTokens, outputTokens, cachedInputTokens, reasoningTokens].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        cachedInputTokens > inputTokens ||
        reasoningTokens > outputTokens
    )
        return null;
    // Reasoning is already included in outputTokens; never charge it a second time.
    const nanos = Math.round(
        (inputTokens - cachedInputTokens) * price.input * 1000 +
            cachedInputTokens * price.cachedInput * 1000 +
            outputTokens * price.output * 1000,
    );
    return {
        nanos,
        usd: dollars(nanos),
        pricing: { ...price, checkedAt: PRICE_DATE, unit: 'USD per 1M tokens', model: name },
    };
}

export function createAiLedger({ stateRoot = '/update', initialBalance = 2.31 } = {}) {
    let database;
    let opening;
    async function open() {
        if (!opening)
            opening = (async () => {
                await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
                const path = stateRoot + '/ai-usage.sqlite';
                const handle = await fs.open(path, 'a', 0o600);
                await handle.close();
                await fs.chmod(path, 0o600);
                database = new DatabaseSync(path);
                database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
                CREATE TABLE IF NOT EXISTS searches (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                    started TEXT NOT NULL, finished TEXT, phase TEXT NOT NULL,
                    api_state TEXT NOT NULL, cached INTEGER NOT NULL DEFAULT 0,
                    cost_nanos INTEGER, input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
                    reasoning_tokens INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS balances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, amount_nanos INTEGER NOT NULL,
                    after_seq INTEGER NOT NULL, note TEXT NOT NULL
                );`);
                if (!database.prepare('SELECT id FROM balances LIMIT 1').get())
                    database
                        .prepare('INSERT INTO balances (at, amount_nanos, after_seq, note) VALUES (?, ?, 0, ?)')
                        .run(
                            new Date().toISOString(),
                            Math.round(initialBalance * USD),
                            'Vom Nutzer genannter Ausgangsstand: $2.31. Frühere Suchen sind nicht erfasst.',
                        );
                const unfinished = database
                    .prepare('SELECT id, payload, api_state FROM searches WHERE finished IS NULL')
                    .all();
                for (const row of unfinished) {
                    const entry = JSON.parse(row.payload);
                    entry.phase = 'interrupted';
                    entry.finished = new Date().toISOString();
                    entry.error = 'Dienst wurde während des KI-Auftrags neu gestartet.';
                    const state = row.api_state === 'pending' ? 'unknown' : row.api_state;
                    entry.costUnknown = state === 'unknown';
                    database
                        .prepare('UPDATE searches SET finished=?, phase=?, api_state=?, payload=? WHERE id=?')
                        .run(entry.finished, entry.phase, state, JSON.stringify(entry), row.id);
                }
                return database;
            })();
        return opening;
    }
    function totals(db, after = 0) {
        return db
            .prepare(`SELECT COUNT(*) AS searches, COALESCE(SUM(CASE WHEN cost_nanos IS NOT NULL THEN 1 ELSE 0 END),0) AS known, COALESCE(SUM(cost_nanos),0) AS cost,
            COALESCE(SUM(cached),0) AS cached, COALESCE(SUM(CASE WHEN cost_nanos > 0 THEN 1 ELSE 0 END),0) AS paid,
            COALESCE(SUM(CASE WHEN api_state='unknown' THEN 1 ELSE 0 END),0) AS unknown,
            COALESCE(SUM(CASE WHEN api_state='pending' THEN 1 ELSE 0 END),0) AS pending,
            COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
            COALESCE(SUM(cached_input_tokens),0) AS cachedInput, COALESCE(SUM(reasoning_tokens),0) AS reasoning
            FROM searches WHERE seq > ?`)
            .get(after);
    }
    function balance(db) {
        const anchor = db.prepare('SELECT * FROM balances ORDER BY id DESC LIMIT 1').get();
        const sum = totals(db, anchor.after_seq);
        return {
            anchor: { at: anchor.at, amountUsd: dollars(anchor.amount_nanos), note: anchor.note },
            estimatedUsd: dollars(anchor.amount_nanos - sum.cost),
            knownSpendUsd: dollars(sum.cost),
            unknownCosts: sum.unknown,
            pendingCosts: sum.pending,
        };
    }
    async function summary() {
        const db = await open();
        const sum = totals(db);
        return {
            balance: balance(db),
            totals: {
                searches: sum.searches,
                cached: sum.cached,
                paid: sum.paid,
                unknown: sum.unknown,
                pending: sum.pending,
                estimatedCostUsd: dollars(sum.cost),
                averageUsd: sum.known ? dollars(sum.cost) / sum.known : null,
                inputTokens: sum.input,
                outputTokens: sum.output,
                cachedInputTokens: sum.cachedInput,
                reasoningTokens: sum.reasoning,
            },
            rates: AI_PRICES,
            priceDate: PRICE_DATE,
            checkpoints: db
                .prepare('SELECT at, amount_nanos AS amount, note FROM balances ORDER BY id DESC LIMIT 20')
                .all()
                .map((row) => ({ at: row.at, amountUsd: dollars(row.amount), note: row.note })),
        };
    }
    async function begin(job, prompt, language, config) {
        const db = await open();
        const before = balance(db);
        const entry = {
            id: job.id,
            kind: job.kind || 'search',
            translationJobId: job.translationJobId || null,
            chapter: job.chapter || null,
            stage: job.stage || null,
            instructions: job.instructions || null,
            images: job.images || [],
            started: job.started,
            finished: null,
            phase: 'planning',
            prompt,
            language,
            model: config.model,
            reasoning: config.reasoning,
            resultCount: config.resultCount,
            sources: job.sources.map(({ id, name, language }) => ({ id, name, language })),
            usage: null,
            costUsd: 0,
            costUnknown: false,
            pricing: null,
            balanceBeforeUsd: before.estimatedUsd,
            balanceAfterUsd: before.estimatedUsd,
            balanceUncertain: !!(before.unknownCosts + before.pendingCosts),
            cached: false,
            responseId: null,
            error: '',
            result: null,
        };
        db.prepare(
            'INSERT INTO searches (id, started, phase, api_state, cost_nanos, payload) VALUES (?, ?, ?, ?, 0, ?)',
        ).run(entry.id, entry.started, entry.phase, 'not_started', JSON.stringify(entry));
        return entry;
    }
    async function mutate(id, change) {
        const db = await open();
        db.exec('BEGIN IMMEDIATE');
        try {
            const row = db.prepare('SELECT * FROM searches WHERE id=?').get(id);
            assert(row, 'Suchhistorieneintrag fehlt.');
            const entry = JSON.parse(row.payload);
            change(entry, row);
            entry.costUsd = dollars(row.cost_nanos);
            entry.costUnknown = row.cost_nanos === null;
            entry.balanceAfterUsd =
                row.cost_nanos === null ? null : dollars(Math.round(entry.balanceBeforeUsd * USD) - row.cost_nanos);
            db.prepare(
                'UPDATE searches SET finished=?, phase=?, api_state=?, cached=?, cost_nanos=?, input_tokens=?, output_tokens=?, cached_input_tokens=?, reasoning_tokens=?, payload=? WHERE id=?',
            ).run(
                entry.finished,
                entry.phase,
                row.api_state,
                entry.cached ? 1 : 0,
                row.cost_nanos,
                entry.usage?.inputTokens || 0,
                entry.usage?.outputTokens || 0,
                entry.usage?.cachedInputTokens || 0,
                entry.usage?.reasoningTokens || 0,
                JSON.stringify(entry),
                id,
            );
            db.exec('COMMIT');
            return entry;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    const apiStarted = (id) =>
        mutate(id, (entry, row) => {
            row.api_state = 'pending';
            row.cost_nanos = null;
        });
    const cacheHit = (id) =>
        mutate(id, (entry, row) => {
            entry.cached = true;
            row.api_state = 'cache';
            row.cost_nanos = 0;
            entry.usage = { inputTokens: 0, outputTokens: 0 };
        });
    const providerUsage = (id, details) =>
        mutate(id, (entry, row) => {
            entry.usage = details.usage;
            entry.actualModel = details.model;
            entry.responseId = details.responseId;
            const estimate = estimateCost(details.model, details.usage, details.tier);
            row.cost_nanos = estimate?.nanos ?? null;
            row.api_state = estimate ? 'received' : 'unknown';
            entry.pricing = estimate?.pricing || null;
        });
    const rejected = (id, status) =>
        mutate(id, (entry, row) => {
            row.api_state = status >= 400 && status < 500 ? 'rejected' : 'unknown';
            row.cost_nanos = row.api_state === 'rejected' ? 0 : null;
        });
    const finish = (job) =>
        mutate(job.id, (entry, row) => {
            entry.phase = job.phase;
            entry.finished = job.finished;
            entry.error = job.error;
            if (row.api_state === 'pending') row.api_state = 'unknown';
            entry.result =
                job.kind === 'translation'
                    ? {
                          summary: job.summary || 'Kapitelübersetzung',
                          checkedQueries: 0,
                          completedSources: 0,
                          recommendations: [],
                      }
                    : {
                          summary: job.summary,
                          criteria: job.criteria,
                          notice: job.notice,
                          checkedQueries: job.checkedQueries,
                          completedSources: job.completedSources,
                          sources: job.sources,
                          recommendations: job.recommendations,
                      };
        });
    async function setBalance(input) {
        assert(
            typeof input.amountUsd === 'number' &&
                Number.isFinite(input.amountUsd) &&
                input.amountUsd >= 0 &&
                input.amountUsd <= 100000 &&
                Math.abs(input.amountUsd * 100 - Math.round(input.amountUsd * 100)) < 1e-6,
            'Guthaben bitte als USD-Betrag mit höchstens zwei Nachkommastellen eingeben.',
        );
        assert(
            typeof input.note === 'string' && input.note.trim().length > 0 && input.note.length <= 300,
            'Bitte einen kurzen Grund für den neuen Guthabenstand eingeben.',
        );
        const db = await open();
        assert(
            !db.prepare('SELECT id FROM searches WHERE finished IS NULL LIMIT 1').get(),
            'Bitte die laufende Suche vor dem Guthabenabgleich abwarten.',
        );
        const sequence = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM searches').get().seq;
        db.prepare('INSERT INTO balances (at, amount_nanos, after_seq, note) VALUES (?, ?, ?, ?)').run(
            new Date().toISOString(),
            Math.round(input.amountUsd * USD),
            sequence,
            input.note.trim(),
        );
        return summary();
    }
    async function history(offset = 0, limit = 25) {
        assert(
            Number.isInteger(offset) &&
                offset >= 0 &&
                offset <= 10000000 &&
                Number.isInteger(limit) &&
                limit >= 1 &&
                limit <= 100,
            'Ungültige Historienseite.',
        );
        const db = await open();
        const count = db.prepare('SELECT COUNT(*) AS count FROM searches').get().count;
        const entries = db
            .prepare('SELECT payload FROM searches ORDER BY seq DESC LIMIT ? OFFSET ?')
            .all(limit, offset)
            .map((row) => JSON.parse(row.payload));
        return {
            entries,
            total: count,
            offset,
            nextOffset: offset + entries.length < count ? offset + entries.length : null,
        };
    }
    return {
        summary,
        begin,
        apiStarted,
        cacheHit,
        providerUsage,
        rejected,
        finish,
        setBalance,
        history,
        entry: async (id) => {
            const db = await open();
            const row = db.prepare('SELECT payload FROM searches WHERE id=?').get(id);
            return row ? JSON.parse(row.payload) : null;
        },
        stage: (id, phase) =>
            mutate(id, (entry) => {
                entry.phase = phase;
            }),
        close: () => {
            database?.close();
            database = undefined;
            opening = undefined;
        },
    };
}

export function createBillingClient({ stateRoot = '/update', secretRoot = '/secrets', fetchImpl = fetch } = {}) {
    const path = secretRoot + '/openai-admin.token';
    const configPath = stateRoot + '/ai-billing.json';
    const snapshotPath = stateRoot + '/ai-billing-last.json';
    let busy = false;
    async function token() {
        return fs
            .readFile(path, 'utf8')
            .then((value) => value.trim())
            .catch((error) => {
                if (error.code === 'ENOENT') return '';
                throw error;
            });
    }
    async function status() {
        const config = await readJson(configPath).catch((error) => {
            if (error.code === 'ENOENT') return { projectId: '' };
            throw error;
        });
        const last = await readJson(snapshotPath).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        return { configured: !!(await token()), projectId: config.projectId, last };
    }
    async function costs(key, projectId, days = 30) {
        const end = Math.floor(Date.now() / 1000);
        const start = Math.floor(end / 86400) * 86400 - (days - 1) * 86400;
        const buckets = [];
        let page;
        for (let count = 0; count < 10; count++) {
            const url = new URL('https://api.openai.com/v1/organization/costs');
            url.searchParams.set('start_time', String(start));
            url.searchParams.set('end_time', String(end));
            url.searchParams.set('bucket_width', '1d');
            url.searchParams.set('limit', String(days));
            if (projectId) url.searchParams.set('project_ids[]', projectId);
            if (page) url.searchParams.set('page', page);
            let response;
            try {
                response = await fetchImpl(url, {
                    headers: { Authorization: `Bearer ${key}` },
                    redirect: 'error',
                    signal: AbortSignal.timeout(15000),
                });
            } catch {
                throw new Error('OpenAI-Kostenabfrage ist nicht erreichbar. Bitte DNS, TLS und Firewall prüfen.');
            }
            assert(
                response.ok,
                response.status === 401 || response.status === 403
                    ? 'Die Kostenabfrage benötigt einen OpenAI-Admin-Key mit Leserechten für Usage/Kosten.'
                    : `OpenAI-Kostenabfrage fehlgeschlagen (HTTP ${response.status}).`,
            );
            const buffer = await response.arrayBuffer();
            assert(buffer.byteLength <= 1024 * 1024, 'Kostenantwort ist zu groß.');
            const value = JSON.parse(Buffer.from(buffer).toString());
            assert(Array.isArray(value.data), 'Ungültige Kostenantwort.');
            for (const bucket of value.data) {
                assert(
                    Number.isInteger(bucket.start_time) &&
                        Number.isInteger(bucket.end_time) &&
                        Array.isArray(bucket.results),
                    'Ungültige Kostenperiode.',
                );
                let nanos = 0;
                for (const item of bucket.results) {
                    assert(
                        item.object === 'organization.costs.result' && item.amount?.currency === 'usd',
                        'Unbekannte Kostenart oder Währung.',
                    );
                    const amount = Number(item.amount.value);
                    assert(Number.isFinite(amount) && Math.abs(amount) <= 1e6, 'Ungültiger Kostenbetrag.');
                    nanos += Math.round(amount * USD);
                }
                buckets.push({ start: bucket.start_time, end: bucket.end_time, usd: dollars(nanos) });
            }
            if (!value.has_more)
                return {
                    fetchedAt: new Date().toISOString(),
                    start,
                    end,
                    projectId,
                    days,
                    totalUsd: buckets.reduce((sum, bucket) => sum + bucket.usd, 0),
                    buckets,
                };
            assert(
                typeof value.next_page === 'string' && value.next_page.length < 1000 && value.next_page !== page,
                'Ungültige Kostenseitenfolge.',
            );
            page = value.next_page;
        }
        throw new Error('Kostenabfrage hat zu viele Ergebnisseiten.');
    }
    async function save(input) {
        assert(!busy, 'Kostenabfrage läuft bereits.');
        busy = true;
        try {
            assert(
                Object.keys(input).every((name) => ['key', 'projectId', 'removeKey'].includes(name)),
                'Ungültige Abrechnungseinstellung.',
            );
            const old = await status();
            const projectId = input.projectId ?? old.projectId;
            assert(
                typeof projectId === 'string' && (projectId === '' || /^proj_[A-Za-z0-9_-]{3,100}$/.test(projectId)),
                'Ungültige OpenAI-Projekt-ID.',
            );
            assert(input.key === undefined || typeof input.key === 'string', 'Ungültiger Admin-Key.');
            assert(
                input.removeKey === undefined || typeof input.removeKey === 'boolean',
                'Ungültige Admin-Key-Aktion.',
            );
            assert(!(input.removeKey && input.key), 'Admin-Key ersetzen oder entfernen.');
            if (input.key) {
                assert(
                    /^sk-admin-[A-Za-z0-9_-]{20,500}$/.test(input.key),
                    'Hier ist ein separater sk-admin-Schlüssel erforderlich.',
                );
                const result = await costs(input.key, projectId, 7);
                const temporary = path + '.' + randomUUID();
                try {
                    await fs.writeFile(temporary, input.key + '\n', { mode: 0o600, flag: 'wx' });
                    await fs.rename(temporary, path);
                } finally {
                    await fs.rm(temporary, { force: true });
                }
                await writeJson(snapshotPath, result);
            }
            if (input.removeKey) await fs.rm(path, { force: true });
            await writeJson(configPath, { projectId });
            if (input.removeKey || (projectId !== old.projectId && !input.key))
                await fs.rm(snapshotPath, { force: true });
            return status();
        } finally {
            busy = false;
        }
    }
    async function sync(days = 30) {
        assert([7, 30, 90].includes(days), 'Ungültiger Kostenzeitraum.');
        assert(!busy, 'Kostenabfrage läuft bereits.');
        busy = true;
        try {
            const key = await token();
            assert(key, 'Für den offiziellen Kostenabruf bitte einen separaten OpenAI-Admin-Key speichern.');
            const config = await status();
            const result = await costs(key, config.projectId, days);
            await writeJson(snapshotPath, result);
            return result;
        } finally {
            busy = false;
        }
    }
    return { status, save, sync };
}
