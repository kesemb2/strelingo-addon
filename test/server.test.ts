// End to end through the HTTP routes, the way Nuvio drives an add-on.
import assert from 'node:assert/strict';

process.env.SECRET = 'test-secret-test-secret-test-secret';
process.env.EXTERNAL_URL = 'https://strelingo.test';

const { default: app, encodeConfig } = await import('../src/index.js');
const { deriveSubtitle } = await import('./synthetic.js');
const { FILENAME, IMDB, PAL, STREAM_ADDON, makeWorld, srtAccuracy } = await import('./world.js');

const passed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
    const t0 = performance.now();
    await fn();
    passed.push(`  ok  ${name} (${Math.round(performance.now() - t0)} ms)`);
}

function useWorld() {
    const world = makeWorld(speech => ({
        subtitles: [
            { id: 'fr-pal', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 1, ratio: PAL, offsetMs: 2_500, resplitShare: 0.3 }) },
            { id: 'fr-web', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 2, offsetMs: 6_000, resplitShare: 0.2 }) },
            { id: 'en-1', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 3, offsetMs: -3_000, resplitShare: 0.4 }) },
            { id: 'en-2', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 4, ratio: 23.976 / 24 }) }
        ]
    }));
    globalThis.fetch = world.fetch;
    return world;
}

const path = (url: string) => url.replace('https://strelingo.test', '');
const get = (url: string, init?: RequestInit) => app.request(path(url), init);

// A user who pasted their AIOStreams link (different per test: each config is its own user).
let userN = 0;
const configWithStreams = () => encodeConfig({ mainLang: 'French [fre]', transLang: 'English [eng]', streamAddonUrl: STREAM_ADDON, n: ++userN });

await check('manifest: configured add-on also serves 🎓 streams', async () => {
    const cfg = configWithStreams();
    const res = await get(`/${cfg}/manifest.json`);
    const m: any = await res.json();
    assert.deepEqual(m.resources, ['subtitles', 'stream']);
    assert.equal(m.name, 'Strelingo Smart (FRE+ENG)');
    assert.equal(m.behaviorHints.configurationRequired, false);
    const bare: any = await (await get('/manifest.json')).json();
    assert.deepEqual(bare.resources, ['subtitles']);
    assert.equal(bare.behaviorHints.configurationRequired, true);
});

await check('Nuvio phone: 🎓 stream → play → subtitles with no file info → exact sync', async () => {
    const world = useWorld();
    const cfg = configWithStreams();

    const streams: any = await (await get(`/${cfg}/stream/movie/${IMDB}.json`)).json();
    assert.equal(streams.streams.length, 2, 'torrent-only stream skipped');
    const ours = streams.streams.find((s: any) => s.behaviorHints?.filename === FILENAME);
    assert.match(ours.name, /^🎓 /);
    assert.match(ours.url, /\/play\//);
    assert.equal(ours.behaviorHints.bingeGroup, 'aio-1080', 'stream hints passed through');

    const play = await get(ours.url, { method: 'HEAD' });
    assert.equal(play.status, 302);
    assert.equal(play.headers.get('location'), world.fileUrl);

    // Nuvio's phone app: /subtitles/movie/<id>.json, nothing else.
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    assert.equal(list.subtitles.length, 1);
    assert.equal(list.subtitles[0].lang, 'fre');
    assert.match(list.subtitles[0].url, /\.srt$/, 'Nuvio picks the parser from the URL extension');

    const srt = await (await get(list.subtitles[0].url)).text();
    const acc = srtAccuracy(srt, world.speech);
    assert.ok(acc > 0.95, `accuracy ${acc}`);

    const status: any = await (await get(`/${cfg}/status`)).json();
    assert.equal(status.builds[0].info.tier, 'file');
    assert.equal(status.builds[0].info.file.via, 'play');
});

await check('NuvioTV / Stremio: player sends the file name → found in AIOStreams → exact sync', async () => {
    const world = useWorld();
    const cfg = configWithStreams();
    const extra = `filename=${encodeURIComponent(FILENAME)}&videoSize=${world.mkv.length}`;
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${extra}.json`)).json();
    assert.equal(list.subtitles.length, 1);
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.ok(srtAccuracy(srt, world.speech) > 0.95);
    const status: any = await (await get(`/${cfg}/status`)).json();
    assert.equal(status.builds[0].info.tier, 'file');
    assert.match(status.builds[0].info.file.via, /upstream/);
});

await check('no stream add-on, no file info: ★ plus the ↻ alternative, both consistent', async () => {
    useWorld();
    const cfg = encodeConfig({ mainLang: 'French [fre]', transLang: 'English [eng]', n: ++userN });
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    assert.equal(list.subtitles.length, 2);
    for (const entry of list.subtitles) {
        const srt = await (await get(entry.url)).text();
        assert.match(srt, /^1\n\d\d:\d\d:\d\d,\d\d\d --> /m);
        assert.match(srt, /<b>.+<\/b>\n<i>> .+<\/i>/);
    }
});

await check('links from the original Strelingo (URI-encoded JSON config) still work', async () => {
    useWorld();
    const legacy = encodeURIComponent(JSON.stringify({ mainLang: 'French [fre]', transLang: 'English [eng]' }));
    const res = await get(`/${legacy}/manifest.json`);
    assert.equal(res.status, 200);
    const list: any = await (await get(`/${legacy}/subtitles/movie/${IMDB}.json`)).json();
    assert.ok(list.subtitles.length >= 1);
});

await check('same main and translation language: nothing offered', async () => {
    const cfg = encodeConfig({ mainLang: 'French [fre]', transLang: 'French [fre]' });
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    assert.equal(list.subtitles.length, 0);
});

await check('/play refuses tampered links (no open redirect)', async () => {
    const cfg = configWithStreams();
    const forged = Buffer.from(JSON.stringify({ v: IMDB, t: 'movie', u: 'https://evil.example/' })).toString('base64url');
    const res = await get(`/${cfg}/play/${forged}.AAAA`);
    assert.equal(res.status, 400);
});

await check('no main-language subtitles: the player gets a readable explanation, not an error', async () => {
    useWorld();
    // Builds are shared by video + languages, so use a pair no other test built.
    const cfg = encodeConfig({ mainLang: 'German [ger]', transLang: 'English [eng]', n: ++userN });
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.match(srt, /Strelingo: no subtitles in German were found/);
});

console.log(passed.join('\n'));
console.log(`server: ${passed.length} passed`);
process.exit(0);
