// State that must be shared between server instances: which file each user
// is playing (recorded at /play, read when subtitles are requested) and
// finished builds. On a single long-running server, memory is enough. On
// Vercel every request may land on another instance, so it goes to:
//
//   Upstash Redis   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//                   (or KV_REST_API_URL + KV_REST_API_TOKEN, as Vercel's
//                   marketplace integration names them)
//   Turso / libSQL  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN — the same kind of
//                   database Smart-Hebrew-Subtitles uses on Vercel
//
// Values are strings with a TTL; large ones are gzipped. Store failures are
// logged and treated as a miss: the add-on degrades to rebuilding, never fails.

import { gunzipSync, gzipSync } from 'node:zlib';

export interface SharedStore {
    kind: 'upstash' | 'turso' | 'memory';
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSec: number): Promise<void>;
}

class MemoryStore implements SharedStore {
    kind = 'memory' as const;
    private readonly map = new Map<string, { value: string; expires: number }>();

    async get(key: string): Promise<string | null> {
        const hit = this.map.get(key);
        if (!hit) return null;
        if (hit.expires < Date.now()) {
            this.map.delete(key);
            return null;
        }
        return hit.value;
    }

    async set(key: string, value: string, ttlSec: number): Promise<void> {
        this.map.set(key, { value, expires: Date.now() + ttlSec * 1000 });
        if (this.map.size > 5000) this.map.delete(this.map.keys().next().value!);
    }
}

class UpstashStore implements SharedStore {
    kind = 'upstash' as const;

    constructor(private readonly url: string, private readonly token: string) {}

    private async command(args: Array<string | number>): Promise<unknown> {
        const res = await fetch(this.url.replace(/\/+$/, ''), {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
            signal: AbortSignal.timeout(6000)
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(`Upstash ${res.status}: ${data.error || 'request failed'}`);
        return data.result;
    }

    async get(key: string): Promise<string | null> {
        const v = await this.command(['GET', key]);
        return typeof v === 'string' ? v : null;
    }

    async set(key: string, value: string, ttlSec: number): Promise<void> {
        await this.command(['SET', key, value, 'EX', Math.max(1, Math.round(ttlSec))]);
    }
}

type HranaValue = { type: 'text'; value: string } | { type: 'float'; value: number } | { type: 'null' };

class TursoStore implements SharedStore {
    kind = 'turso' as const;
    private readonly endpoint: string;
    private ready: Promise<void> | null = null;
    private writes = 0;

    constructor(databaseUrl: string, private readonly token: string) {
        let url = databaseUrl.trim().replace(/\/+$/, '');
        if (url.startsWith('libsql://')) url = `https://${url.slice('libsql://'.length)}`;
        this.endpoint = `${url}/v2/pipeline`;
    }

    private async execute(sql: string, args: Array<string | number> = []): Promise<Array<Array<{ type: string; value?: unknown }>>> {
        const encode = (a: string | number): HranaValue =>
            typeof a === 'number' ? { type: 'float', value: a } : { type: 'text', value: a };
        const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
            body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(encode) } }, { type: 'close' }] }),
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
        const data: any = await res.json();
        const first = data?.results?.[0];
        if (first?.type !== 'ok') throw new Error(`Turso: ${first?.error?.message || 'unknown error'}`);
        return first.response?.result?.rows || [];
    }

    private ensure(): Promise<void> {
        this.ready ??= this.execute(
            'CREATE TABLE IF NOT EXISTS strelingo_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires REAL NOT NULL)'
        ).then(() => undefined).catch(e => {
            this.ready = null;
            throw e;
        });
        return this.ready;
    }

    async get(key: string): Promise<string | null> {
        await this.ensure();
        const rows = await this.execute('SELECT value FROM strelingo_kv WHERE key = ? AND expires > ?', [key, Date.now() / 1000]);
        const cell = rows[0]?.[0];
        return cell && typeof cell.value === 'string' ? cell.value : null;
    }

    async set(key: string, value: string, ttlSec: number): Promise<void> {
        await this.ensure();
        const now = Date.now() / 1000;
        await this.execute(
            'INSERT INTO strelingo_kv (key, value, expires) VALUES (?, ?, ?) '
            + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires',
            [key, value, now + ttlSec]
        );
        if (++this.writes % 50 === 1) {
            await this.execute('DELETE FROM strelingo_kv WHERE expires < ?', [now]).catch(() => undefined);
        }
    }
}

export function createStore(env: Record<string, string | undefined> = process.env): SharedStore {
    const upUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
    const upToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
    if (upUrl && upToken) return new UpstashStore(upUrl, upToken);
    if (env.TURSO_DATABASE_URL) return new TursoStore(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN || '');
    return new MemoryStore();
}

let store: SharedStore | null = null;

export function getStore(): SharedStore {
    if (store) return store;
    store = createStore();
    console.log(`[store] shared state: ${store.kind}`);
    return store;
}

/** A secret every instance shares without extra setup: the store's own token. */
export function storeCredential(): string | undefined {
    const env = process.env;
    return env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || env.TURSO_AUTH_TOKEN || undefined;
}

const GZIP_PREFIX = 'gz:';
const GZIP_OVER = 4096;

export async function getJson<T>(key: string, from: SharedStore = getStore()): Promise<T | null> {
    try {
        let raw = await from.get(key);
        if (raw === null) return null;
        if (raw.startsWith(GZIP_PREFIX)) raw = gunzipSync(Buffer.from(raw.slice(GZIP_PREFIX.length), 'base64')).toString('utf8');
        return JSON.parse(raw) as T;
    } catch (e: any) {
        console.warn(`[store] read ${key.split(':')[0]} failed: ${e.message}`);
        return null;
    }
}

export async function setJson(key: string, value: unknown, ttlSec: number, to: SharedStore = getStore()): Promise<void> {
    try {
        let raw = JSON.stringify(value);
        if (raw.length > GZIP_OVER) raw = GZIP_PREFIX + gzipSync(raw).toString('base64');
        await to.set(key, raw, ttlSec);
    } catch (e: any) {
        console.warn(`[store] write ${key.split(':')[0]} failed: ${e.message}`);
    }
}
