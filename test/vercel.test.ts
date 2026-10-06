// Vercel: every request may run on a different instance. The 🎓 pick made on
// one instance must reach the subtitle request on another (shared store), and
// a finished build must not be redone.
import assert from 'node:assert/strict';
import { UPSTASH_TOKEN, UPSTASH_URL, fakeUpstash } from './fakeStores.js';

process.env.UPSTASH_REDIS_REST_URL = UPSTASH_URL;
process.env.UPSTASH_REDIS_REST_TOKEN = UPSTASH_TOKEN;
delete process.env.SECRET;
process.env.EXTERNAL_URL = 'https://strelingo.test';

const { default: app, encodeConfig } = await import('../src/index.js');
const { forgetLocalJobs } = await import('../src/smart/jobs.js');
const { deriveSubtitle } = await import('./synthetic.js');
const { IMDB, PAL, STREAM_ADDON, makeWorld, srtAccuracy } = await import('./world.js');

const passed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
    const t0 = performance.now();
    await fn();
    passed.push(`  ok  ${name} (${Math.round(performance.now() - t0)} ms)`);
}

const upstash = fakeUpstash();
const world = makeWorld(speech => ({
    subtitles: [
        { id: 'fr-pal', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 1, ratio: PAL, offsetMs: 2_500, resplitShare: 0.3 }) },
        { id: 'en-1', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 3, offsetMs: -3_000, resplitShare: 0.4 }) }
    ]
}));
globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    return (await upstash.handle(url, init)) || world.fetch(input, init);
}) as typeof fetch;

const get = (url: string, init?: RequestInit) => app.request(url.replace('https://strelingo.test', ''), init);
const cfg = encodeConfig({ mainLang: 'French [fre]', transLang: 'English [eng]', streamAddonUrl: STREAM_ADDON });
const osListings = () => world.log.filter(u => u.startsWith('https://opensubtitles-v3.strem.io/')).length;

await check('health reports shared state and a signing key every instance shares', async () => {
    const h: any = await (await get('/health')).json();
    assert.equal(h.sharedState, 'upstash');
    assert.equal(h.signing, 'store');
});

await check('🎓 play on instance A, subtitles on instance B: still synced to the file', async () => {
    const streams: any = await (await get(`/${cfg}/stream/movie/${IMDB}.json`)).json();
    const ours = streams.streams.find((s: any) => s.url.includes('/play/') && s.behaviorHints?.filename?.includes('1080p'));
    const play = await get(ours.url);
    assert.equal(play.status, 302);

    forgetLocalJobs(); // a fresh instance: nothing in memory
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    forgetLocalJobs();
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.ok(srtAccuracy(srt, world.speech) > 0.95);

    forgetLocalJobs();
    const status: any = await (await get(`/${cfg}/status`)).json();
    assert.equal(status.builds[0].info.tier, 'file');
    assert.equal(status.builds[0].info.file.via, 'play');
});

await check('a build finished on one instance is served by another without rebuilding', async () => {
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    forgetLocalJobs();
    const before = osListings();
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.ok(srtAccuracy(srt, world.speech) > 0.95);
    assert.equal(osListings(), before, 'no new OpenSubtitles search');
});

await check('store traffic stays small (free tier: 500K commands/month)', async () => {
    assert.ok(upstash.commands() < 60, `${upstash.commands()} commands for a whole viewing`);
});

console.log(passed.join('\n'));
console.log(`vercel: ${passed.length} passed`);
process.exit(0);
