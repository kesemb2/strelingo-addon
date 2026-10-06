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
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith('https://v3-cinemeta.strem.io/')) {
            return Response.json({ meta: { name: 'Le Film', poster: 'https://img.example/p.jpg', releaseInfo: '2021' } });
        }
        return world.fetch(input, init);
    }) as typeof fetch;
    return world;
}

const path = (url: string) => url.replace('https://strelingo.test', '');
const get = (url: string, init?: RequestInit) => app.request(path(url), init);
const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const settle = () => new Promise(r => setTimeout(r, 50));

// A user who pasted their AIOStreams link (different per test: each config is its own user).
let userN = 0;
const configWithStreams = () => encodeConfig({ mainLang: 'French [fre]', transLang: 'English [eng]', streamAddonUrl: STREAM_ADDON, n: ++userN });

async function events(cfg: string): Promise<any[]> {
    await settle();
    const a: any = await (await get(`/${cfg}/api/activity`)).json();
    return a.videos.flatMap((v: any) => v.events);
}
async function lastBuild(cfg: string): Promise<any> {
    return (await events(cfg)).find(e => e.kind === 'build' && e.variant === 1)?.info;
}
const entry = (list: any, kind: string) => list.subtitles.find((s: any) => s.url.includes(`/sub/${kind}/`));
// What NuvioTV and Stremio send with a subtitle request: the playing file's name and size.
const namedFile = (world: { mkv: Uint8Array }) => `filename=${encodeURIComponent(FILENAME)}&videoSize=${world.mkv.length}`;
// French line then English line; by default each in its own color.
const TWO_LINES = /<font color="#FFE066"><b>.+<\/b><\/font>\n<font color="#8CD9FF"><i>> .+<\/i><\/font>/;

await check('manifest: a subtitles add-on only — no streams, no stream links', async () => {
    const cfg = configWithStreams();
    const res = await get(`/${cfg}/manifest.json`);
    const m: any = await res.json();
    assert.deepEqual(m.resources, ['subtitles']);
    assert.equal(m.name, 'Strelingo Smart (FRE+ENG)');
    assert.equal(m.behaviorHints.configurationRequired, false);
    const bare: any = await (await get('/manifest.json')).json();
    assert.deepEqual(bare.resources, ['subtitles']);
    assert.equal(bare.behaviorHints.configurationRequired, true);
    assert.equal((await get(`/${cfg}/stream/movie/${IMDB}.json`)).status, 404);
    assert.equal((await get(`/${cfg}/play/anything`)).status, 404);
});

await check('Nuvio phone: no file info → the timing most subtitles agree on, and ★ says so', async () => {
    const world = useWorld();
    const cfg = configWithStreams();

    // Nuvio's phone app: /subtitles/movie/<id>.json, nothing else.
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    const star = list.subtitles[0];
    assert.equal(star.id, '★ צרפתית+אנגלית · תזמון משוער', 'Nuvio shows the id: it is the readable name');
    assert.ok(list.subtitles.every((s: any) => s.lang === 'eng'), 'listed under the viewer\'s language');
    assert.ok(list.subtitles.every((s: any) => /\.srt$/.test(s.url)), 'Nuvio picks the parser from the URL extension');
    assert.equal(new Set(list.subtitles.map((s: any) => s.id)).size, list.subtitles.length, 'unique ids');

    const srt = await (await get(star.url)).text();
    assert.match(srt, TWO_LINES);
    const info = await lastBuild(cfg);
    assert.ok(['consensus', 'guess'].includes(info.tier), info.tier);
    assert.equal(info.file.known, false);
    void world;
});

await check('the entries: ★, ↻, each language alone, and the ⚠ ones', async () => {
    const world = useWorld();
    const cfg = configWithStreams();
    const extra = `filename=${encodeURIComponent(FILENAME)}&videoSize=${world.mkv.length}`;
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${extra}.json`)).json();
    assert.deepEqual(list.subtitles.map((s: any) => s.id), [
        '★ צרפתית+אנגלית · לפי הקובץ',
        '↻ צרפתית+אנגלית · חלופה',
        'צרפתית בלבד · מסונכרן',
        'אנגלית בלבד · מסונכרן',
        '⚠ הסנכרון לא טוב · החלף',
        '⚠ האנגלית לא טובה · החלף',
        '⚠ הצרפתית לא טובה · החלף'
    ]);
    const fr = await (await get(entry(list, 'main').url)).text();
    const en = await (await get(entry(list, 'trans').url)).text();
    assert.ok(srtAccuracy(fr, world.speech) > 0.95 && srtAccuracy(en, world.speech) > 0.95);
    assert.doesNotMatch(fr, /<i>/);
    assert.match(en, /the|you|we|I /);
    const alt = await (await get(entry(list, 'alt').url)).text();
    assert.match(alt, TWO_LINES);
});

await check('a color per language: French yellow, English light blue by default; configurable', async () => {
    const world = useWorld();
    const cfg = configWithStreams();
    const extra = `filename=${encodeURIComponent(FILENAME)}&videoSize=${world.mkv.length}`;
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${extra}.json`)).json();
    const star = await (await get(list.subtitles[0].url)).text();
    assert.match(star, TWO_LINES);
    const fr = await (await get(entry(list, 'main').url)).text();
    const cues = fr.split('\n\n').filter(Boolean);
    assert.ok(cues.every(c => /\n<font color="#FFE066">[^]*<\/font>$/.test(c.trim())), 'every French entry colored');
    const en = await (await get(entry(list, 'trans').url)).text();
    assert.match(en, /<font color="#8CD9FF">/);
    assert.doesNotMatch(en, /#FFE066/);

    // Chosen on the configure page: no color for French, white for English.
    const plain = encodeConfig({
        mainLang: 'French [fre]', transLang: 'English [eng]', streamAddonUrl: STREAM_ADDON, n: ++userN,
        mainColor: 'Player default (no color) [none]', transColor: 'White [#FFFFFF]'
    });
    const list2: any = await (await get(`/${plain}/subtitles/movie/${IMDB}/${extra}.json`)).json();
    const star2 = await (await get(list2.subtitles[0].url)).text();
    assert.match(star2, /\n<b>.+<\/b>\n<font color="#FFFFFF"><i>> .+<\/i><\/font>\n/);
    assert.doesNotMatch(star2, /#FFE066|#8CD9FF/);

    // Only a real color ever reaches the subtitle text.
    const { parseUserConfig } = await import('../src/config.js');
    const evil = parseUserConfig(encodeConfig({ mainLang: 'French [fre]', mainColor: 'x [#fff"><script>]', transColor: 'Pink [#ffb3d9]' }));
    assert.deepEqual(evil?.colors, { main: undefined, trans: '#FFB3D9' });
    const old = parseUserConfig(encodeConfig({ mainLang: 'French [fre]', transLang: 'English [eng]' }));
    assert.deepEqual(old?.colors, { main: '#FFE066', trans: '#8CD9FF' }, 'links installed before colors get the defaults');

    const m: any = await (await get(`/${cfg}/manifest.json`)).json();
    const keys = m.config.map((c: any) => c.key);
    assert.ok(keys.includes('mainColor') && keys.includes('transColor'));
});

await check('"⚠ the sync is bad" teaches it: the next ★ uses another timing, undo brings it back', async () => {
    const world = useWorld();
    const cfg = configWithStreams();
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${namedFile(world)}.json`)).json();
    await (await get(list.subtitles[0].url)).text();
    await settle();

    // Picked right away (a player prefetching the whole list): not counted.
    process.env.REPORT_MIN_VIEW_MS = '15000';
    await (await get(entry(list, 'bad_sync').url)).text();
    let ev = await events(cfg);
    assert.equal(ev.find(e => e.kind === 'report')?.report.outcome, 'too_soon');

    // After watching for a while: counted, and the replacement is served at once.
    process.env.REPORT_MIN_VIEW_MS = '0';
    const replaced = await (await get(entry(list, 'bad_sync').url)).text();
    assert.match(replaced, /<b>.+<\/b>/);
    ev = await events(cfg);
    const report = ev.find(e => e.kind === 'report');
    assert.equal(report.report.outcome, 'recorded');
    assert.deepEqual(report.report.bans.refs, ['file']);
    const served = ev.find(e => e.kind === 'serve');
    assert.notEqual(served.info.tier, 'file', 'served on another timing');
    assert.ok(served.bans.refs.includes('file'));

    // The same report about the same subtitle counts once (from the page too).
    const first: any = await (await postJson(`/${cfg}/api/feedback`, { videoId: IMDB, kind: 'bad_trans' })).json();
    const second: any = await (await postJson(`/${cfg}/api/feedback`, { videoId: IMDB, kind: 'bad_trans' })).json();
    assert.equal(first.outcome, 'recorded');
    assert.equal(second.outcome, 'duplicate');

    // The activity page can take it back.
    const a: any = await (await get(`/${cfg}/api/activity`)).json();
    const reports = a.videos[0].reports.filter((r: any) => !r.undone);
    for (const r of reports) {
        const res: any = await (await postJson(`/${cfg}/api/feedback/undo`, { videoId: IMDB, id: r.id })).json();
        assert.equal(res.ok, true);
    }
    await (await get(list.subtitles[0].url)).text();
    assert.equal((await events(cfg)).find(e => e.kind === 'serve').info.tier, 'file');
    delete process.env.REPORT_MIN_VIEW_MS;
});

await check('"⚠ the English is bad" swaps the English subtitle only', async () => {
    useWorld();
    const cfg = configWithStreams();
    process.env.REPORT_MIN_VIEW_MS = '0';
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    await (await get(list.subtitles[0].url)).text();
    await settle();
    const before = (await events(cfg)).find(e => e.kind === 'serve').info;
    await (await get(entry(list, 'bad_trans').url)).text();
    const after = (await events(cfg)).find(e => e.kind === 'serve').info;
    assert.equal(after.main.id, before.main.id);
    assert.notEqual(after.trans.id, before.trans.id);
    delete process.env.REPORT_MIN_VIEW_MS;
});

await check('build keys: same name + size is the same file; a bare generic name is not; reports change it', async () => {
    const { jobKey } = await import('../src/smart/jobs.js');
    const base = {
        type: 'movie', videoId: IMDB, imdbId: IMDB, mainLang: 'fre', transLang: 'eng', variant: 1 as const,
        optional: { wyzieKey: '', wyzieSources: [], subsourceKey: '', mode: 'fallback' as const }
    };
    const k = (file: object, bans?: { refs: string[]; subs: string[] }) => jobKey({ ...base, file, bans });
    assert.equal(k({ url: 'https://d/1?token=a', filename: 'a.mkv', size: 5 }), k({ url: 'https://d/9?token=b', filename: 'a.mkv', size: 5 }));
    assert.notEqual(k({ url: 'https://d/1', filename: 'video.mkv' }), k({ url: 'https://d/2', filename: 'video.mkv' }));
    assert.notEqual(k({ filename: 'a.mkv', size: 5 }), k({ filename: 'a.mkv', size: 6 }));
    assert.equal(k({ size: 5 }), k({ size: 5 }, { refs: [], subs: [] }));
    assert.notEqual(k({ size: 5 }), k({ size: 5 }, { refs: ['file'], subs: [] }));
    const colored = jobKey({ ...base, file: { size: 5 }, colors: { main: '#FFE066', trans: '#8CD9FF' } });
    assert.notEqual(colored, k({ size: 5 }), 'a color change never serves an old build');
    assert.notEqual(colored, jobKey({ ...base, file: { size: 5 }, colors: { main: '#FFE066', trans: '#FFFFFF' } }));
});

await check('NuvioTV / Stremio: player sends the file name → found in AIOStreams → exact sync', async () => {
    const world = useWorld();
    const cfg = configWithStreams();
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${namedFile(world)}.json`)).json();
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.ok(srtAccuracy(srt, world.speech) > 0.95);
    // Built for an earlier user with the same file: served from that build.
    const served = (await events(cfg)).find(e => e.kind === 'serve');
    assert.equal(served.info.tier, 'file');
    assert.equal(served.info.file.via, 'request+upstream');

    // Once built, ★ says what it is synced to.
    const again: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}/${namedFile(world)}.json`)).json();
    assert.equal(again.subtitles[0].id, '★ צרפתית+אנגלית · מסונכרן לקובץ');
});

await check('no stream add-on, no file info: ★ and ↻ both carry two lines', async () => {
    useWorld();
    const cfg = encodeConfig({ mainLang: 'French [fre]', transLang: 'English [eng]', n: ++userN });
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    assert.equal(list.subtitles[0].id, '★ צרפתית+אנגלית · תזמון משוער');
    for (const kind of ['star', 'alt']) {
        const srt = await (await get(entry(list, kind).url)).text();
        assert.match(srt, /^1\n\d\d:\d\d:\d\d,\d\d\d --> /m);
        assert.match(srt, TWO_LINES);
    }
});

await check('links from the original Strelingo and from version 1.0 still work', async () => {
    useWorld();
    const legacy = encodeURIComponent(JSON.stringify({ mainLang: 'French [fre]', transLang: 'English [eng]' }));
    const res = await get(`/${legacy}/manifest.json`);
    assert.equal(res.status, 200);
    const list: any = await (await get(`/${legacy}/subtitles/movie/${IMDB}.json`)).json();
    assert.ok(list.subtitles.length >= 1);
    const cfg = configWithStreams();
    const old = await get(`/${cfg}/dual/1/movie/${IMDB}/-/strelingo.srt`);
    assert.equal(old.status, 200);
    assert.match(await old.text(), /<b>/);
});

await check('same main and translation language: nothing offered', async () => {
    const cfg = encodeConfig({ mainLang: 'French [fre]', transLang: 'French [fre]' });
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    assert.equal(list.subtitles.length, 0);
});

await check('no main-language subtitles: the player gets a readable explanation all through the film', async () => {
    useWorld();
    // Builds are shared by video + languages, so use a pair no other test built.
    const cfg = encodeConfig({ mainLang: 'German [ger]', transLang: 'English [eng]', n: ++userN });
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    const srt = await (await get(list.subtitles[0].url)).text();
    assert.match(srt, /Strelingo: לא נמצאו כתוביות בגרמנית/);
    assert.match(srt, /01:30:\d\d,\d\d\d -->/, 'repeated, wherever the viewer is in the film');
});

await check('activity page: everyone\'s at /, one user\'s at /<config>/status; ADMIN_PASSWORD locks the global one', async () => {
    useWorld();
    const cfg = configWithStreams();
    const list: any = await (await get(`/${cfg}/subtitles/movie/${IMDB}.json`)).json();
    await (await get(list.subtitles[0].url)).text();
    await settle();

    const html = await (await get('/')).text();
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.doesNotMatch(html, /__STRELINGO_BOOT__/);
    assert.match(await (await get('/status')).text(), /"apiBase":""/);
    assert.match(await (await get(`/${cfg}/status`)).text(), new RegExp(`"apiBase":"/${cfg}"`));

    const mine: any = await (await get(`/${cfg}/api/activity`)).json();
    assert.equal(mine.videos[0].title, 'Le Film');
    assert.ok(mine.videos[0].events.some((e: any) => e.kind === 'serve' && e.ok));
    const html2 = JSON.stringify(mine);
    assert.doesNotMatch(html2, /debrid\.example/, 'stream URLs (debrid tokens) never reach the log');
    const st: any = await (await get(`/${cfg}/api/status`)).json();
    assert.equal(st.scope, 'user');
    assert.equal(st.streamAddon, true);

    const all: any = await (await get('/api/activity')).json();
    assert.ok(all.videos.length >= 1);

    process.env.ADMIN_PASSWORD = 'open sesame';
    assert.equal((await get('/api/activity')).status, 401);
    assert.equal((await get(`/${cfg}/api/activity`)).status, 200, 'a user\'s own page needs no password');
    assert.equal((await postJson('/api/login', { password: 'nope' })).status, 401);
    const login = await postJson('/api/login', { password: 'open sesame' });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.equal((await get('/api/activity', { headers: { cookie } })).status, 200);
    delete process.env.ADMIN_PASSWORD;
});

console.log(passed.join('\n'));
console.log(`server: ${passed.length} passed`);
process.exit(0);
