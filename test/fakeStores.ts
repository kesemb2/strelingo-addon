// Fakes of the two shared-store services, reached through fetch():
// Upstash's REST API (one Redis command per POST) and Turso's Hrana-over-HTTP
// pipeline, the latter running the add-on's SQL on a real in-memory SQLite.

import { DatabaseSync } from 'node:sqlite';

export const UPSTASH_URL = 'https://fake-upstash.test';
export const UPSTASH_TOKEN = 'upstash-token-for-tests';
export const TURSO_URL = 'libsql://fake-db.turso.test';
export const TURSO_TOKEN = 'turso-token-for-tests';

export function fakeUpstash() {
    const data = new Map<string, { value: string; expires: number }>();
    const lists = new Map<string, { items: string[]; expires: number }>();
    let commands = 0;
    const live = (key: string) => {
        const hit = data.get(key);
        return hit && hit.expires > Date.now() ? hit : null;
    };
    const run = (args: Array<string | number>): { result?: unknown; error?: string } => {
        commands++;
        const [cmd, key, ...rest] = args.map(String);
        if (cmd === 'GET') return { result: live(key)?.value ?? null };
        if (cmd === 'SET') {
            const [value, ...opts] = rest;
            const nx = opts.includes('NX');
            const ex = opts.indexOf('EX');
            if (ex < 0) return { error: 'ERR test fake needs EX' };
            if (nx && live(key)) return { result: null };
            data.set(key, { value, expires: Date.now() + Number(opts[ex + 1]) * 1000 });
            return { result: 'OK' };
        }
        if (cmd === 'LPUSH') {
            const l = lists.get(key) || { items: [], expires: Infinity };
            l.items.unshift(...rest.reverse());
            lists.set(key, l);
            return { result: l.items.length };
        }
        if (cmd === 'LTRIM') {
            const l = lists.get(key);
            if (l) l.items = l.items.slice(Number(rest[0]), Number(rest[1]) + 1);
            return { result: 'OK' };
        }
        if (cmd === 'EXPIRE') {
            const l = lists.get(key);
            if (l) l.expires = Date.now() + Number(rest[0]) * 1000;
            return { result: l ? 1 : 0 };
        }
        if (cmd === 'LRANGE') {
            const l = lists.get(key);
            if (!l || l.expires < Date.now()) return { result: [] };
            return { result: l.items.slice(Number(rest[0]), Number(rest[1]) + 1) };
        }
        return { error: `ERR unknown command '${cmd}'` };
    };
    const handle = async (url: string, init?: RequestInit): Promise<Response | null> => {
        if (!url.startsWith(UPSTASH_URL)) return null;
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${UPSTASH_TOKEN}`) {
            return Response.json({ error: 'WRONGPASS' }, { status: 401 });
        }
        const body = JSON.parse(String(init?.body));
        if (url.replace(/\/+$/, '') === `${UPSTASH_URL}/pipeline`) return Response.json(body.map(run));
        const r = run(body);
        return r.error ? Response.json(r, { status: 400 }) : Response.json(r);
    };
    return { handle, data, lists, commands: () => commands };
}

export function fakeTurso() {
    const db = new DatabaseSync(':memory:');
    const endpoint = TURSO_URL.replace('libsql://', 'https://') + '/v2/pipeline';
    const handle = async (url: string, init?: RequestInit): Promise<Response | null> => {
        if (url !== endpoint) return null;
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${TURSO_TOKEN}`) {
            return new Response('unauthorized', { status: 401 });
        }
        const body = JSON.parse(String(init?.body));
        const results = body.requests.map((r: any) => {
            if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
            try {
                const args = r.stmt.args.map((a: any) => (a.type === 'float' ? Number(a.value) : a.type === 'integer' ? BigInt(a.value) : a.type === 'null' ? null : a.value));
                const stmt = db.prepare(r.stmt.sql);
                const isRead = /^\s*select/i.test(r.stmt.sql);
                let affected = 0;
                const rows = isRead ? (stmt.all(...args) as Array<Record<string, unknown>>) : (affected = Number(stmt.run(...args).changes), []);
                const cols = rows[0] ? Object.keys(rows[0]).map(name => ({ name })) : [];
                return {
                    type: 'ok',
                    response: {
                        type: 'execute',
                        result: { cols, affected_row_count: affected, rows: rows.map(row => Object.values(row).map(v => (typeof v === 'number' ? { type: 'float', value: v } : { type: 'text', value: v }))) }
                    }
                };
            } catch (e: any) {
                return { type: 'error', error: { message: e.message } };
            }
        });
        return Response.json({ results });
    };
    return { handle, db };
}
