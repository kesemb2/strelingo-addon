import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMkvSubtitleTimings } from '../src/file/mkv.js';
import { hashFromChunks } from '../src/file/osHash.js';
import { probeFile } from '../src/file/probe.js';
import { RangeReader } from '../src/file/rangeReader.js';
import { matchesEpisode, parseRelease, releaseScore } from '../src/file/release.js';
import { addonBase, fetchUpstreamStreams, matchStream } from '../src/file/upstream.js';
import { assertPublic, safeFetch } from '../src/file/safeFetch.js';
import { buildMkv, fakeFetch } from './fakeFiles.js';

const passed: string[] = [];
async function check(name: string, fn: () => unknown) {
    await fn();
    passed.push(`  ok  ${name}`);
}

const dialogue: Array<[number, number | null]> = Array.from({ length: 120 }, (_, i) => [60_000 + i * 4_000, 2_200]);

await check('MKV: picks the full dialogue track over forced and SDH ones', async () => {
    const mkv = buildMkv([
        { number: 2, lang: 'fre', name: 'Forced', forced: true, cues: dialogue.slice(0, 40) },
        { number: 3, lang: 'eng', name: 'English SDH', cues: dialogue },
        { number: 4, lang: 'fre', cues: dialogue }
    ]);
    const { fetch } = fakeFetch({ 'https://cdn.example/movie.mkv': mkv });
    const reader = new RangeReader('https://cdn.example/movie.mkv', { fetchImpl: fetch });
    const head = await reader.read(0, 256 * 1024);
    const res = await readMkvSubtitleTimings(reader, head, ['fre']);
    assert.ok(res.ok, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.track.number, 4);
    assert.equal(res.spans.length, 120);
    assert.deepEqual(res.spans[0], { start: 60_000, end: 62_200 });
    assert.ok(res.bytesRead < 600_000, `read ${res.bytesRead} bytes of ${mkv.length}`);
});

await check('MKV: missing durations are filled up to the next line (capped)', async () => {
    const mkv = buildMkv([{ number: 2, lang: 'eng', cues: dialogue.map(([t]) => [t, null]) }]);
    const { fetch } = fakeFetch({ 'https://cdn.example/a.mkv': mkv });
    const reader = new RangeReader('https://cdn.example/a.mkv', { fetchImpl: fetch });
    const res = await readMkvSubtitleTimings(reader, await reader.read(0, 256 * 1024));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.track.withDurations, false);
    assert.deepEqual(res.spans[0], { start: 60_000, end: 64_000 });
});

await check('MKV: a file without subtitle tracks reports why', async () => {
    const mkv = buildMkv([]);
    const { fetch } = fakeFetch({ 'https://cdn.example/b.mkv': mkv });
    const reader = new RangeReader('https://cdn.example/b.mkv', { fetchImpl: fetch });
    const res = await readMkvSubtitleTimings(reader, await reader.read(0, 256 * 1024));
    assert.deepEqual(res, { ok: false, reason: 'no_subtitle_tracks' });
});

await check('MKV: an MP4 is not mistaken for Matroska', async () => {
    const mp4 = new Uint8Array(300_000);
    mp4.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70], 0);
    const { fetch } = fakeFetch({ 'https://cdn.example/c.mp4': mp4 });
    const reader = new RangeReader('https://cdn.example/c.mp4', { fetchImpl: fetch });
    const res = await readMkvSubtitleTimings(reader, await reader.read(0, 256 * 1024));
    assert.equal(res.ok, false);
});

await check('MKV: a real file muxed by mkvmerge gives back the exact subtitle timings', async () => {
    const dir = new URL('./fixtures/', import.meta.url);
    const bytes = new Uint8Array(readFileSync(new URL('mkvmerge-fre-forced.mkv', dir)));
    const srt = readFileSync(new URL('mkvmerge-fre.srt', dir), 'utf8');
    const ms = (h: string, m: string, s: string, f: string) => ((+h * 60 + +m) * 60 + +s) * 1000 + +f;
    const truth = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/g)]
        .map(m => ({ start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]) }));
    const { fetch } = fakeFetch({ 'https://cdn.example/real.mkv': bytes });
    const res = await probeFile('https://cdn.example/real.mkv', { fetchImpl: fetch, preferLangs: ['fre'] });
    assert.ok(res.mkv.ok, JSON.stringify(res.mkv));
    if (!res.mkv.ok) return;
    assert.equal(res.mkv.track.forced, false, 'the forced track is skipped');
    assert.deepEqual(res.mkv.spans, truth);
    // Same value as the reference Python implementation of the OpenSubtitles hash.
    assert.equal(res.hash, '165e69481d1636e6');
});

await check('OpenSubtitles hash: size + 64-bit word sums of head and tail', () => {
    const zeros = new Uint8Array(65536);
    assert.equal(hashFromChunks(131072, zeros, zeros), '0000000000020000');
    const head = new Uint8Array(65536);
    head[0] = 1;            // +1
    const tail = new Uint8Array(65536);
    tail[65528 + 7] = 0xFF; // +0xFF00000000000000
    assert.equal(hashFromChunks(131072, head, tail), 'ff00000000020001');
    const ones = new Uint8Array(65536).fill(0xFF); // each word = 2^64-1 ≡ -1
    assert.equal(hashFromChunks(131072, ones, zeros), (131072n - 8192n).toString(16).padStart(16, '0'));
});

await check('probe: hash + embedded timings in one pass, with few bytes read', async () => {
    const mkv = buildMkv([{ number: 2, lang: 'eng', cues: dialogue }], 3_000_000);
    const { fetch, log } = fakeFetch({ 'https://cdn.example/p.mkv': mkv });
    const res = await probeFile('https://cdn.example/p.mkv', { fetchImpl: fetch });
    assert.ok(res.mkv.ok);
    assert.equal(res.size, mkv.length);
    assert.match(res.hash || '', /^[0-9a-f]{16}$/);
    assert.ok(res.bytesRead < 1_000_000);
    assert.ok(log.length <= 5, `requests: ${log.length}`);
});

await check('release names: source/service/group, scores', () => {
    const video = parseRelease('Les.Choses.Humaines.2021.FRENCH.1080p.WEB-DL.DDP5.1.H264-FW.mkv');
    assert.equal(video.source, 'web');
    assert.equal(video.group, 'fw');
    assert.equal(video.resolution, '1080p');
    const nf = parseRelease('Lupin.S01E01.1080p.NF.WEB-DL.DDP5.1.x264-NTb');
    assert.equal(nf.service, 'NF');
    assert.ok(releaseScore(video, parseRelease('Les.Choses.Humaines.2021.720p.WEB-DL-FW')) >
        releaseScore(video, parseRelease('Les.Choses.Humaines.2021.1080p.BluRay.x264-AMIABLE')));
    assert.ok(matchesEpisode('Lupin.S01E05.1080p', 1, 5));
    assert.ok(!matchesEpisode('Lupin.S01E15.1080p', 1, 5));
    assert.ok(matchesEpisode('lupin 1x05', 1, 5));
});

await check('upstream: finds the playing stream by size or name, never a wrong episode', () => {
    const streams = [
        { url: 'https://d/1', behaviorHints: { filename: 'Show.S01E04.1080p.WEB-DL-GRP.mkv', videoSize: 1_000 } },
        { url: 'https://d/2', behaviorHints: { filename: 'Show.S01E05.1080p.WEB-DL-GRP.mkv', videoSize: 2_000 } },
        { url: 'https://d/3', behaviorHints: { filename: 'Show.S01E05.720p.WEB-DL-XYZ.mkv', videoSize: 3_000 } }
    ];
    assert.equal(matchStream(streams, undefined, 2_000, 1, 5)?.url, 'https://d/2');
    assert.equal(matchStream(streams, 'Show.S01E05.720p.WEB-DL-XYZ.mkv', undefined, 1, 5)?.url, 'https://d/3');
    assert.equal(matchStream(streams, undefined, 1_000, 1, 5), null, 'size of another episode');
    assert.equal(matchStream(streams, undefined, undefined), null);
    assert.equal(addonBase('stremio://aio.example/abc/manifest.json'), 'https://aio.example/abc');
    assert.equal(addonBase('not a url'), null);
    assert.equal(addonBase('http://127.0.0.1:7000/manifest.json'), null, 'no loopback');
    assert.equal(addonBase('http://192.168.1.20/abc/manifest.json'), null, 'no LAN unless allowed');
    process.env.ALLOW_PRIVATE_ADDRESSES = 'true';
    assert.equal(addonBase('http://192.168.1.20/abc/manifest.json'), 'http://192.168.1.20/abc');
    delete process.env.ALLOW_PRIVATE_ADDRESSES;
});

await check('redirects are followed hop by hop, never into private addresses (SSRF)', async () => {
    const seen: Array<{ url: string; range: string | null }> = [];
    const hops: Record<string, Response | (() => Response)> = {
        'https://public.example/a': () => new Response(null, { status: 302, headers: { location: '/b' } }),
        'https://public.example/b': () => new Response(null, { status: 307, headers: { location: 'https://cdn.example/file' } }),
        'https://cdn.example/file': () => new Response('ok', { status: 206 }),
        'https://evil.example/stream/movie/tt1.json': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
        'https://evil.example/lan': () => new Response(null, { status: 301, headers: { location: 'http://192.168.1.1/admin' } }),
        'https://evil.example/loop': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/loop' } })
    };
    const f = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, range: new Headers(init?.headers).get('range') });
        assert.equal(init?.redirect, 'manual', 'never let fetch follow on its own');
        const h = hops[url];
        if (!h) throw new Error(`unexpected request to ${url}`);
        return typeof h === 'function' ? h() : h;
    }) as typeof fetch;

    const res = await safeFetch('https://public.example/a', { headers: { Range: 'bytes=0-9' } }, f);
    assert.equal(res.status, 206);
    assert.deepEqual(seen.map(x => x.url), ['https://public.example/a', 'https://public.example/b', 'https://cdn.example/file']);
    assert.ok(seen.every(x => x.range === 'bytes=0-9'), 'Range kept across hops');

    await assert.rejects(safeFetch('https://evil.example/lan', {}, f), /private address/);
    await assert.rejects(safeFetch('https://evil.example/loop', {}, f), /too many redirects/);
    assert.ok(!seen.some(x => x.url.startsWith('http://192.168.') || x.url.startsWith('http://169.254.')), 'private hop never requested');

    // The stream add-on fetch goes through it too.
    await assert.rejects(fetchUpstreamStreams('https://evil.example/manifest.json', 'movie', 'tt1', f), /private address/);

    // A public-looking name that resolves to a private address.
    await assert.rejects(assertPublic(new URL('https://sneaky.example/'), async () => [{ address: '127.0.0.1' }]), /private address/);
    await assertPublic(new URL('https://fine.example/'), async () => [{ address: '93.184.216.34' }]);
});

console.log(passed.join('\n'));
console.log(`file: ${passed.length} passed`);
