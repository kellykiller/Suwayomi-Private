/* SPDX-License-Identifier: MPL-2.0 */
const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

export function formatLogTime(value = new Date()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : formatter.format(date).replace(',', '');
}

// Only convert timestamps at the beginning of a log line; message contents stay intact.
export function formatLogText(text) {
    return text.replace(
        /(^|\n)([ \t]*)(\[?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(\]?)/g,
        (_, line, space, open, value, close) => line + space + open + formatLogTime(value) + close,
    );
}

export function timestampBuildLog(text, now = new Date()) {
    const time = formatLogTime(now);
    return text
        .split(/\r?\n/)
        .map((line) => (line ? `${time} ${line}` : line))
        .join('\n');
}
