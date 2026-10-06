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
const { FILENAME, IMDB, PAL, STREAM_ADDON, makeWorld, srtAccuracy } = await import('./world.js');

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

await check('subtitles listed on instance A, fetched on instance B: still synced to the file the player named', async () => {
    const extra = `filename=${encodeURIComponent(FILENAME)}&videoSize=${world.mkv.length}`;
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${extra}.json`)).json();
    forgetLocalJobs(); // a fresh instance: nothing in memory
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.ok(srtAccuracy(srt, world.speech) > 0.95);

    forgetLocalJobs();
    await new Promise(r => setTimeout(r, 50));
    const activity: any = await (await get(`/${cfg}/api/activity`)).json();
    const build = activity.videos[0].events.find((e: any) => e.kind === 'build' && e.variant === 1);
    assert.equal(build.info.tier, 'file');
    assert.equal(build.info.file.via, 'request+upstream');
});

await check('two instances asked for the same subtitle at once: one builds, the other waits for it', async () => {
    const cfg2 = encodeConfig({ mainLang: 'French [fre]', transLang: 'English [eng]', n: 2 });
    const list: any = await (await get(`/${cfg2}/subtitles/movie/${IMDB}/filename=x.mkv&videoSize=123.json`)).json();
    const url = list.subtitles.find((s: any) => s.url.includes('/sub/main/')).url;
    const before = osListings();
    forgetLocalJobs();
    const a = Promise.resolve(get(url)).then(r => r.text());
    await new Promise(r => setTimeout(r, 5));
    forgetLocalJobs(); // the second request lands on a fresh instance
    const b = Promise.resolve(get(url)).then(r => r.text());
    const [ta, tb] = await Promise.all([a, b]);
    assert.equal(ta, tb);
    assert.match(ta, /-->/);
    assert.ok(osListings() - before <= 2, `OpenSubtitles searched ${osListings() - before} times (one build for ★, maybe one for ↻)`);
});

await check('a build finished on one instance is served by another without rebuilding', async () => {
    const extra = `filename=${encodeURIComponent(FILENAME)}&videoSize=${world.mkv.length}`;
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${extra}.json`)).json();
    forgetLocalJobs();
    const before = osListings();
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.ok(srtAccuracy(srt, world.speech) > 0.95);
    assert.equal(osListings(), before, 'no new OpenSubtitles search');
});

await check('store traffic stays small (free tier: 500K commands/month)', async () => {
    assert.ok(upstash.commands() < 150, `${upstash.commands()} commands for these viewings`);
    console.log(`  (store commands: ${upstash.commands()})`);
});

console.log(passed.join('\n'));
console.log(`vercel: ${passed.length} passed`);
process.exit(0);
