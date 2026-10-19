/* SPDX-License-Identifier: MPL-2.0 */
import * as fs from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'suwayomi_private_session';
const DAY = 86400000;
const validToken = (token) => /^[A-Za-z0-9_-]{43}$/.test(token || '');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const escape = (value) =>
    String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

export function returnPath(value) {
    if (
        typeof value !== 'string' ||
        value.length > 2048 ||
        !value.startsWith('/') ||
        /^\/\//.test(value) ||
        /[\\\u0000-\u0020]/.test(value)
    )
        return '/';
    try {
        const decoded = decodeURIComponent(value);
        if (decoded.startsWith('//') || decoded.includes('\\') || /[\u0000-\u0020]/.test(decoded)) return '/';
        const url = new URL(value, 'http://private.local');
        if (url.origin !== 'http://private.local' || /^\/(?:auth(?:\/|$)|login(?:\/|$))/.test(url.pathname)) return '/';
        return url.pathname + url.search + url.hash;
    } catch {
        return '/';
    }
}

export function sessionCookie(req) {
    const values = String(req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(SESSION_COOKIE + '='));
    return values.length === 1 ? values[0].slice(SESSION_COOKIE.length + 1) : values.length ? 'invalid' : null;
}

export function upstreamCookies(value) {
    return String(value || '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith(SESSION_COOKIE + '='))
        .join('; ');
}

export function createSessionStore({ root = '/update/browser-auth', now = Date.now } = {}) {
    let keyPromise;
    const key = () =>
        (keyPromise ||= (async () => {
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            const file = root + '/key';
            try {
                const bytes = await fs.readFile(file);
                if (bytes.length !== 32) throw new Error('Ungueltiger Sitzungsschluessel.');
                return bytes;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            const bytes = randomBytes(32),
                temporary = root + '/key-' + randomBytes(16).toString('hex') + '.tmp';
            await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
            try {
                await fs.link(temporary, file);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            } finally {
                await fs.unlink(temporary);
            }
            const saved = await fs.readFile(file);
            if (saved.length !== 32) throw new Error('Ungueltiger Sitzungsschluessel.');
            return saved;
        })());
    const path = (token) => root + '/' + hash(token) + '.json';
    const revoke = async (token) => {
        if (validToken(token))
            await fs.unlink(path(token)).catch((error) => {
                if (error.code !== 'ENOENT') throw error;
            });
    };
    const read = async (token) => {
        if (!validToken(token)) return null;
        let record;
        try {
            const data = await fs.readFile(path(token));
            if (data.length > 8192) return null;
            record = JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
            throw error;
        }
        try {
            if (record.version !== 1) return null;
            const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(record.iv, 'base64url'), {
                authTagLength: 16,
            });
            decipher.setAAD(Buffer.from(hash(token)));
            decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
            const payload = JSON.parse(
                Buffer.concat([decipher.update(Buffer.from(record.data, 'base64url')), decipher.final()]).toString(),
            );
            if (!Number.isSafeInteger(payload.expires) || payload.expires <= now()) {
                await revoke(token);
                return null;
            }
            if (!/^Basic [A-Za-z0-9+/]+=*$/.test(payload.authorization || '')) return null;
            return payload;
        } catch {
            return null;
        }
    };
    const issue = async (authorization, remember) => {
        const secret = await key();
        const files = (await fs.readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
        let active = 0;
        for (const name of files) {
            const file = root + '/' + name;
            try {
                const record = JSON.parse(await fs.readFile(file, 'utf8'));
                if (record.expires <= now()) await fs.unlink(file);
                else active++;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        if (active >= 256) throw new Error('Zu viele Anmeldungen. Bitte zuerst auf einem anderen Geraet abmelden.');
        const token = randomBytes(32).toString('base64url'),
            expires = now() + (remember ? 30 * DAY : DAY / 2);
        // Keep the IV explicitly with the authenticated ciphertext, never the password.
        const iv = randomBytes(12);
        const encryptor = createCipheriv('aes-256-gcm', secret, iv);
        encryptor.setAAD(Buffer.from(hash(token)));
        const data = Buffer.concat([encryptor.update(JSON.stringify({ authorization, expires })), encryptor.final()]);
        await fs.writeFile(
            path(token),
            JSON.stringify({
                version: 1,
                expires,
                iv: iv.toString('base64url'),
                tag: encryptor.getAuthTag().toString('base64url'),
                data: data.toString('base64url'),
            }),
            { mode: 0o600, flag: 'wx' },
        );
        return token;
    };
    return { read, issue, revoke };
}

export function authCookie(value, { secure = false, remember = false, logout = false } = {}) {
    return (
        SESSION_COOKIE +
        '=' +
        value +
        '; Path=/; HttpOnly; SameSite=Lax' +
        (secure ? '; Secure' : '') +
        (remember || logout ? '; Max-Age=' + (logout ? 43200 : 2592000) : '')
    );
}

const style = `:root{color-scheme:light dark;--bg:#f2f5fb;--card:#fff;--ink:#182337;--muted:#5b687b;--line:#ccd5e2;--accent:#315da8;--field:#fff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:32px 20px}main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:24px;padding:36px;box-shadow:0 20px 70px #15294c12}.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:19px;margin-bottom:32px}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--accent);color:white;font-size:24px}h1{font-size:28px;letter-spacing:-.6px;line-height:1.2;margin:0 0 12px}p{margin:0 0 24px;color:var(--muted)}label.field{display:block;font-weight:600;font-size:14px;margin:22px 0 7px}input[type=text],input[type=password]{display:block;width:100%;min-height:50px;border:1px solid var(--line);border-radius:10px;background:var(--field);color:var(--ink);padding:12px 14px;font:inherit;outline-offset:3px}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #7ca6ef}.password{position:relative}.password input{padding-right:90px}.reveal{position:absolute;right:8px;top:8px;min-height:34px;background:transparent;color:var(--accent);border:0;font:inherit;font-size:13px;cursor:pointer}.remember{display:flex;align-items:center;gap:10px;margin:24px 0;font-size:14px;cursor:pointer}.remember input{width:19px;height:19px;accent-color:var(--accent)}button.primary{display:block;width:100%;min-height:50px;border:0;border-radius:10px;background:var(--accent);color:white;font:inherit;font-weight:650;cursor:pointer}.hint{font-size:13px;margin:22px 0 0}.error{padding:12px 14px;border:1px solid #bc4444;border-radius:10px;color:#b22c2c;margin-bottom:18px;font-size:14px}a{color:var(--accent)}@media(prefers-color-scheme:dark){:root{--bg:#101722;--card:#192332;--ink:#f0f4fc;--muted:#a8b5c9;--line:#3a485d;--accent:#85b1ff;--field:#141e2d}button.primary,.mark{color:#10213c}.error{color:#ffaaaa}}@media(max-width:480px){body{padding:20px 14px}main{padding:28px 22px;border-radius:18px}}`;

export function loginPage({ next = '/', error = '', username = '', account = false } = {}) {
    const nonce = randomBytes(18).toString('base64url');
    const content = account
        ? `<h1>Angemeldet</h1><p>Du bist als <strong>${escape(username)}</strong> angemeldet.</p><form method="post" action="/auth/logout"><button class="primary" type="submit">Abmelden</button></form><p class="hint"><a href="/">Zur Bibliothek</a></p>`
        : `<h1>Willkommen zurück</h1><p>Melde dich mit deinem Suwayomi-Konto an.</p>${error ? `<div class="error" role="alert">${escape(error)}</div>` : ''}<form method="post" action="/auth/login" autocomplete="on"><input type="hidden" name="next" value="${escape(returnPath(next))}"><label class="field" for="username">Benutzername</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="256" required value="${escape(username)}"><label class="field" for="password">Passwort</label><div class="password"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button class="reveal" type="button" aria-controls="password" aria-pressed="false">Anzeigen</button></div><label class="remember"><input type="checkbox" name="remember" value="1">Angemeldet bleiben (30 Tage)</label><button class="primary" type="submit">Anmelden</button></form><p class="hint">Du kannst deine Zugangsdaten im Passwortmanager deines Browsers speichern.</p>`;
    return {
        nonce,
        html: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${account ? 'Konto' : 'Anmelden'} · Suwayomi</title><style nonce="${nonce}">${style}</style></head><body><main><div class="brand"><span class="mark" aria-hidden="true">▤</span>Suwayomi</div>${content}</main><script nonce="${nonce}">const button=document.querySelector('.reveal');if(button)button.addEventListener('click',()=>{const field=document.getElementById('password');const show=field.type==='password';field.type=show?'text':'password';button.textContent=show?'Verbergen':'Anzeigen';button.setAttribute('aria-pressed',String(show));});</script></body></html>`,
    };
}

function html(res, status, options) {
    const page = loginPage(options);
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${page.nonce}'; script-src 'nonce-${page.nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    res.end(page.html);
}

export function createBrowserAuth({
    store = createSessionStore(),
    authenticate,
    configLoader,
    now = Date.now,
    onLogout = () => {},
} = {}) {
    const attempts = new Map();
    const redirect = (res, location) => {
        res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
        res.end();
    };
    const loginLocation = (next) => '/auth/login?next=' + encodeURIComponent(returnPath(next));
    const resolve = async (req) => {
        const token = sessionCookie(req);
        const session = await store.read(token);
        if (session) req.headers.authorization = session.authorization;
        else if (
            token !== null ||
            req.headers['sec-fetch-mode'] === 'navigate' ||
            String(req.headers.accept || '').includes('text/html')
        )
            delete req.headers.authorization;
        const cookies = upstreamCookies(req.headers.cookie);
        if (cookies) req.headers.cookie = cookies;
        else delete req.headers.cookie;
        return { token, session };
    };
    const unauthorized = (req, res, session) => {
        if (session?.token) res.setHeader('Set-Cookie', authCookie('logged-out', { logout: true }));
        if (['GET', 'HEAD'].includes(req.method) && !/^\/(?:private-api|api)(?:\/|$)/.test(req.url))
            return redirect(res, loginLocation(req.url));
        res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Bitte erneut anmelden.', login: loginLocation('/') }));
    };
    const handle = async (req, res, url, current) => {
        if (!url.pathname.startsWith('/auth/') && url.pathname !== '/login') return false;
        if (req.method === 'GET' && ['/login', '/auth/login'].includes(url.pathname)) {
            html(res, 200, { next: url.searchParams.get('next') || '/' });
            return true;
        }
        if (req.method === 'GET' && url.pathname === '/auth/account') {
            const user = await authenticate(req);
            if (!user.canManage) unauthorized(req, res, current);
            else
                html(res, 200, {
                    account: true,
                    username: Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')[0],
                });
            return true;
        }
        if (req.method !== 'POST' || !['/auth/login', '/auth/logout'].includes(url.pathname)) {
            res.writeHead(404);
            res.end();
            return true;
        }
        const config = await configLoader();
        const origin = req.headers.origin;
        if (
            !config.origins.includes(origin) ||
            (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
        ) {
            html(res, 403, { error: 'Bitte die Anmeldung direkt auf der Suwayomi-Seite öffnen.' });
            return true;
        }
        const secure = new URL(origin).protocol === 'https:';
        if (url.pathname === '/auth/logout') {
            await store.revoke(current.token);
            onLogout(current.token);
            res.setHeader('Set-Cookie', authCookie('logged-out', { secure, logout: true }));
            redirect(res, '/auth/login');
            return true;
        }
        if (!(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
            html(res, 415, { error: 'Bitte das Anmeldeformular verwenden.' });
            return true;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 8192) {
                html(res, 413, { error: 'Die Anmeldedaten sind zu lang.' });
                return true;
            }
            chunks.push(chunk);
        }
        const data = new URLSearchParams(Buffer.concat(chunks).toString());
        const username = data.get('username') || '',
            password = data.get('password') || '',
            next = returnPath(data.get('next'));
        if (
            !username ||
            username.length > 256 ||
            username.includes(':') ||
            !password ||
            password.length > 1024 ||
            /[\r\n\u0000]/.test(username + password) ||
            ['username', 'password', 'remember', 'next'].some((name) => data.getAll(name).length > 1)
        ) {
            html(res, 400, { next, error: 'Bitte gültige Anmeldedaten eingeben.' });
            return true;
        }
        for (const [address, value] of attempts) if (value.until <= now()) attempts.delete(address);
        const address = req.socket.remoteAddress;
        const limit = attempts.get(address) || { count: 0, until: now() + 300000 };
        if (limit.count >= 20 || (!attempts.has(address) && attempts.size >= 1000)) {
            res.setHeader('Retry-After', '300');
            html(res, 429, { next, error: 'Zu viele Anmeldeversuche. Bitte in fünf Minuten erneut versuchen.' });
            return true;
        }
        limit.count++;
        attempts.set(address, limit);
        const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
        let user;
        try {
            user = await authenticate({ headers: { authorization } });
        } catch {
            html(res, 503, { next, username, error: 'Suwayomi ist gerade nicht erreichbar. Bitte erneut versuchen.' });
            return true;
        }
        if (!user.authorized || !user.canManage) {
            html(res, 401, { next, username, error: 'Benutzername oder Passwort ist falsch.' });
            return true;
        }
        const remember = data.get('remember') === '1';
        const token = await store.issue(authorization, remember);
        await store.revoke(current.token);
        attempts.delete(address);
        res.setHeader('Set-Cookie', authCookie(token, { secure, remember }));
        redirect(res, next);
        return true;
    };
    return { resolve, handle, unauthorized, store };
}
