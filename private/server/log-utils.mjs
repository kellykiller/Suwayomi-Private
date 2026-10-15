/* SPDX-License-Identifier: MPL-2.0 */
const LIMIT = 1024 * 1024;
export function redactLog(value, secrets = []) {
    let text = String(value);
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
        text = text.replaceAll(secret, '[ausgeblendet]');
    return text
        .replace(/\b(?:github_pat_|gh[pousr]_|sk-(?:proj-|admin-)?)[A-Za-z0-9_-]+/g, '[ausgeblendet]')
        .replace(
            /((?:authorization|x-api-key|api[_-]?key|access[_-]?token|password|passwd)\s*["']?\s*[:=]\s*)[^\r\n]+/gi,
            '$1[ausgeblendet]',
        )
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9_+/=.-]+/gi, '$1 [ausgeblendet]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[ausgeblendet]@')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
export async function boundedText(response, limit = LIMIT) {
    const chunks = [];
    let length = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > limit) throw new Error('Logantwort überschreitet das Größenlimit.');
            chunks.push(Buffer.from(chunk));
        }
    }
    return Buffer.concat(chunks);
}
export function dockerLogText(buffer) {
    const parts = [];
    let offset = 0;
    while (
        offset + 8 <= buffer.length &&
        [0, 1, 2].includes(buffer[offset]) &&
        buffer.subarray(offset + 1, offset + 4).equals(Buffer.alloc(3))
    ) {
        const length = buffer.readUInt32BE(offset + 4);
        if (offset + 8 + length > buffer.length) break;
        parts.push(buffer.subarray(offset + 8, offset + 8 + length));
        offset += 8 + length;
    }
    return parts.length && offset === buffer.length ? Buffer.concat(parts).toString('utf8') : buffer.toString('utf8');
}
