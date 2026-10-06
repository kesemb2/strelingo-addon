import assert from 'node:assert/strict';
import { createStore, getJson, setJson } from '../src/store.js';
import { TURSO_TOKEN, TURSO_URL, UPSTASH_TOKEN, UPSTASH_URL, fakeTurso, fakeUpstash } from './fakeStores.js';

const passed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
    await fn();
    passed.push(`  ok  ${name}`);
}

const upstash = fakeUpstash();
const turso = fakeTurso();
globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    return (await upstash.handle(url, init)) || (await turso.handle(url, init)) || new Response('down', { status: 503 });
}) as typeof fetch;

const backends = {
    upstash: createStore({ UPSTASH_REDIS_REST_URL: UPSTASH_URL, UPSTASH_REDIS_REST_TOKEN: UPSTASH_TOKEN }),
    'upstash (Vercel KV names)': createStore({ KV_REST_API_URL: UPSTASH_URL, KV_REST_API_TOKEN: UPSTASH_TOKEN }),
    turso: createStore({ TURSO_DATABASE_URL: TURSO_URL, TURSO_AUTH_TOKEN: TURSO_TOKEN }),
    memory: createStore({})
};

for (const [name, store] of Object.entries(backends)) {
    await check(`${name}: values round-trip, large ones compressed, and expire`, async () => {
        assert.equal(await getJson('missing', store), null);
        await setJson('play:u|tt1', { url: 'https://x/a.mkv', size: 123 }, 60, store);
        assert.deepEqual(await getJson('play:u|tt1', store), { url: 'https://x/a.mkv', size: 123 });
        await setJson('play:u|tt1', { url: 'https://x/b.mkv' }, 60, store);
        assert.deepEqual(await getJson('play:u|tt1', store), { url: 'https://x/b.mkv' }, 'overwrite');

        const big = { srt: 'Bonjour à tous, ça va ?\n'.repeat(20_000) };
        await setJson('result:big', big, 60, store);
        if (store.kind !== 'memory') assert.ok((await store.get('result:big'))!.startsWith('gz:'));
        assert.deepEqual(await getJson('result:big', store), big);

        await setJson('short', { a: 1 }, 1, store);
        await new Promise(r => setTimeout(r, 1100));
        assert.equal(await getJson('short', store), null, 'expired');
    });
}

await check('a store that is down reads as a miss and never throws', async () => {
    const broken = createStore({ UPSTASH_REDIS_REST_URL: 'https://down.test', UPSTASH_REDIS_REST_TOKEN: 'x' });
    await setJson('k', { a: 1 }, 60, broken);
    assert.equal(await getJson('k', broken), null);
});

console.log(passed.join('\n'));
console.log(`store: ${passed.length} passed`);
