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
    let commands = 0;
    const handle = async (url: string, init?: RequestInit): Promise<Response | null> => {
        if (!url.startsWith(UPSTASH_URL)) return null;
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${UPSTASH_TOKEN}`) {
            return Response.json({ error: 'WRONGPASS' }, { status: 401 });
        }
        commands++;
        const [cmd, key, value, ex, ttl] = JSON.parse(String(init?.body)) as [string, string, string?, string?, number?];
        if (cmd === 'GET') {
            const hit = data.get(key);
            return Response.json({ result: hit && hit.expires > Date.now() ? hit.value : null });
        }
        if (cmd === 'SET' && ex === 'EX') {
            data.set(key, { value: value!, expires: Date.now() + Number(ttl) * 1000 });
            return Response.json({ result: 'OK' });
        }
        return Response.json({ error: `ERR unknown command '${cmd}'` }, { status: 400 });
    };
    return { handle, data, commands: () => commands };
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
                const args = r.stmt.args.map((a: any) => (a.type === 'float' ? Number(a.value) : a.type === 'null' ? null : a.value));
                const stmt = db.prepare(r.stmt.sql);
                const isRead = /^\s*select/i.test(r.stmt.sql);
                const rows = isRead ? (stmt.all(...args) as Array<Record<string, unknown>>) : (stmt.run(...args), []);
                const cols = rows[0] ? Object.keys(rows[0]).map(name => ({ name })) : [];
                return {
                    type: 'ok',
                    response: {
                        type: 'execute',
                        result: { cols, rows: rows.map(row => Object.values(row).map(v => (typeof v === 'number' ? { type: 'float', value: v } : { type: 'text', value: v }))) }
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
