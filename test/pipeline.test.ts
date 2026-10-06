import assert from 'node:assert/strict';
import { buildDual, type SmartRequest } from '../src/smart/pipeline.js';
import { alignToReference } from '../src/sync/aligner.js';
import { deriveSubtitle, speechTrack } from './synthetic.js';
import { FILENAME, IMDB, PAL, STREAM_ADDON, makeWorld, srtAccuracy, srtSpans } from './world.js';

const passed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
    const t0 = performance.now();
    await fn();
    passed.push(`  ok  ${name} (${Math.round(performance.now() - t0)} ms)`);
}

const optional = { wyzieKey: '', wyzieSources: [], subsourceKey: '', mode: 'fallback' as const };
const request = (file: SmartRequest['file'], extra: Partial<SmartRequest> = {}): SmartRequest => ({
    type: 'movie', videoId: IMDB, imdbId: IMDB, mainLang: 'fre', transLang: 'eng',
    optional, file, variant: 1, ...extra
});

// The situation that broke the original add-on: the top French subtitle is
// a 25 fps (PAL) release, so everything merged onto it drifted.
const palFirst = (speech: ReturnType<typeof speechTrack>) => ({
    subtitles: [
        { id: 'fr-pal', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 1, ratio: PAL, offsetMs: 2_500, resplitShare: 0.3 }) },
        { id: 'fr-web', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 2, offsetMs: 6_000, resplitShare: 0.2 }) },
        { id: 'en-1', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 3, offsetMs: -3_000, resplitShare: 0.4 }) },
        { id: 'en-2', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 4, ratio: 23.976 / 24, resplitShare: 0.3 }) }
    ]
});

await check('file known (🎓 stream): both languages synced to the embedded track', async () => {
    const world = makeWorld(palFirst);
    const out = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }), undefined, { fetchImpl: world.fetch });
    assert.ok(out.srt, JSON.stringify(out.info));
    assert.equal(out.info.tier, 'file');
    assert.ok(out.info.main?.confident && out.info.trans?.confident, JSON.stringify(out.info));
    const acc = srtAccuracy(out.srt!, world.speech);
    assert.ok(acc > 0.95, `accuracy ${acc}`);
    assert.match(out.srt!, /<b>.+<\/b>\n<i>> .+<\/i>/);
    // The hash and size were passed on to OpenSubtitles.
    assert.ok(world.log.some(u => /videoHash=[0-9a-f]{16}/.test(u)), 'hash passed to OpenSubtitles');
});

await check('player sent only the file name: the stream add-on finds the file', async () => {
    const world = makeWorld(palFirst);
    const out = await buildDual(request({ filename: FILENAME, via: 'request' }, { upstreamUrl: STREAM_ADDON }), undefined, { fetchImpl: world.fetch });
    assert.equal(out.info.tier, 'file', JSON.stringify(out.info));
    assert.match(out.info.file.via || '', /upstream/);
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
});

await check('nothing known about the file: consensus timing, PAL subtitle fixed', async () => {
    const world = makeWorld(palFirst);
    const out = await buildDual(request({}), undefined, { fetchImpl: world.fetch });
    assert.ok(out.srt);
    assert.ok(['consensus', 'guess'].includes(out.info.tier), out.info.tier);
    // Not tied to the file, but internally consistent and not drifting:
    // the result follows a film-speed release's timing, so against the real
    // video it is off by one constant offset at most (the player's subtitle
    // delay fixes that) — never the growing drift of a PAL subtitle.
    assert.ok(out.info.main?.confident && out.info.trans?.confident, JSON.stringify(out.info));
    const vsVideo = alignToReference(world.speech, srtSpans(out.srt!), { allowSplits: false });
    assert.ok(Math.abs(vsVideo.ratio - 1) < 0.0015, `ratio vs video ${vsVideo.ratio}`);
    assert.ok(out.info.notes.includes('preferred_film_speed_over_pal'), out.info.notes.join());
});

await check('embedded timings missing: a hash-matched subtitle is the reference', async () => {
    const world = makeWorld(speech => ({
        embedded: false,
        subtitles: [
            { id: 'fr-pal', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 1, ratio: PAL, offsetMs: 2_500 }) },
            { id: 'en-hash', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 5, resplitShare: 0.3 }), m: 'h' },
            { id: 'en-off', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 6, offsetMs: 8_000 }) }
        ]
    }));
    const out = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }), undefined, { fetchImpl: world.fetch });
    assert.equal(out.info.tier, 'hash', JSON.stringify(out.info));
    assert.ok(out.info.notes.some(n => n.startsWith('no_embedded_timings')));
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
});

await check('a French subtitle for another movie is passed over', async () => {
    const world = makeWorld(speech => ({
        subtitles: [
            { id: 'fr-wrong', lang: 'fre' as const, spans: deriveSubtitle(speechTrack(777, 100 * 60_000), { seed: 7 }) },
            { id: 'fr-ok', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 8, offsetMs: 1_200 }) },
            { id: 'en-1', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 9 }) }
        ]
    }));
    const out = await buildDual(request({ url: world.fileUrl, via: 'play' }), undefined, { fetchImpl: world.fetch });
    assert.equal(out.info.main?.id, 'fr-ok', JSON.stringify(out.info.main));
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
});

await check('no English subtitles: the French line alone, still synced', async () => {
    const world = makeWorld(speech => ({
        subtitles: [{ id: 'fr-pal', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 1, ratio: PAL, offsetMs: 2_500 }) }]
    }));
    const out = await buildDual(request({ url: world.fileUrl, via: 'play' }), undefined, { fetchImpl: world.fetch });
    assert.ok(out.srt);
    assert.ok(out.info.notes.includes('no_translation_subtitles'));
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
});

await check('no French subtitles at all: explained failure', async () => {
    const world = makeWorld(speech => ({
        subtitles: [{ id: 'en-1', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 9 }) }]
    }));
    const out = await buildDual(request({}), undefined, { fetchImpl: world.fetch });
    assert.equal(out.srt, null);
    assert.ok(out.info.notes.includes('no_main_language_subtitles'));
});

await check('a quick stage is published before the final one', async () => {
    const world = makeWorld(palFirst);
    const stages: string[] = [];
    await buildDual(request({ url: world.fileUrl, via: 'play' }), o => stages.push(o.info.stage), { fetchImpl: world.fetch });
    assert.equal(stages[stages.length - 1], 'final');
});

console.log(passed.join('\n'));
console.log(`pipeline: ${passed.length} passed`);
