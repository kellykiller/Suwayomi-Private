/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { assert, readJson, writeJson } from './common.mjs';

export const AI_MAX_RESULTS = 100;
export const AI_MAX_TURNS = 100;
export const AI_MAX_CONTEXT = 240000;
export const chatId = (value) =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const notFound = () => Object.assign(new Error('Gespräch nicht gefunden.'), { status: 404 });

export function conversationContext(turns) {
    const messages = turns.flatMap((turn) => {
        const response = {
            summary: turn.summary,
            criteria: turn.criteria,
            notice: turn.notice,
            recommendations: turn.recommendations.map(({ title, aliases, reason, caveat, matches }) => ({
                title,
                aliases,
                reason,
                caveat,
                // Historical source observations, never a new availability claim.
                sourceMatches: matches
                    .slice(0, 5)
                    .map(({ sourceName, language, chapterCount }) => ({ sourceName, language, chapterCount })),
            })),
        };
        return [
            { role: 'user', content: turn.prompt },
            { role: 'assistant', content: JSON.stringify(response) },
        ];
    });
    assert(
        JSON.stringify(messages).length <= AI_MAX_CONTEXT,
        'Dieses Gespräch ist für eine weitere KI-Anfrage zu umfangreich. Bitte ein neues Gespräch starten; der Verlauf bleibt gespeichert.',
    );
    return messages;
}

export function createConversationStore(root) {
    const path = (id) => {
        assert(chatId(id), 'Ungültige Gesprächskennung.');
        return root + '/' + id + '.json';
    };
    const read = async (id, owner, optional = false) => {
        let value;
        try {
            const file = path(id);
            assert((await fs.stat(file)).size <= 16 * 1024 ** 2, 'Gesprächsdatei ist zu groß.');
            value = await readJson(file);
        } catch (error) {
            if (error.code === 'ENOENT') {
                if (optional) return null;
                throw notFound();
            }
            throw error;
        }
        if (value.owner !== owner) throw notFound();
        assert(
            value.version === 1 && value.id === id && Array.isArray(value.turns) && value.turns.length <= AI_MAX_TURNS,
            'Ungültiges gespeichertes Gespräch.',
        );
        return value;
    };
    const save = async (value) => {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        assert(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024 ** 2, 'Gesprächsdatei ist zu groß.');
        await writeJson(path(value.id), value);
    };
    const list = async (owner) => {
        const names = await fs.readdir(root).catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        const result = [];
        for (const name of names.filter((name) => name.endsWith('.json') && chatId(name.slice(0, -5)))) {
            const value = await readJson(root + '/' + name);
            if (value.owner === owner)
                result.push({
                    id: value.id,
                    title: value.title,
                    updated: value.updated,
                    turnCount: value.turns.length,
                });
        }
        return result.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 500);
    };
    const create = async (id, owner, turn) => {
        const existing = await read(id, owner, true);
        if (existing) return existing;
        assert((await list(owner)).length < 500, 'Maximal 500 gespeicherte Gespräche erreicht.');
        const value = {
            version: 1,
            id,
            owner,
            title: turn.prompt.slice(0, 120),
            created: turn.started,
            updated: turn.started,
            turns: [turn],
        };
        await save(value);
        return value;
    };
    return { read, save, list, create };
}
