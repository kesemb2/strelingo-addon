import assert from 'node:assert/strict';
import { buildDual, type SmartRequest } from '../src/smart/pipeline.js';
import { alignToReference } from '../src/sync/aligner.js';
import { dualFormatter, paint, parseColor } from '../src/subs/style.js';
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
    const out = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }), { fetchImpl: world.fetch });
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
    const out = await buildDual(request({ filename: FILENAME, via: 'request' }, { upstreamUrl: STREAM_ADDON }), { fetchImpl: world.fetch });
    assert.equal(out.info.tier, 'file', JSON.stringify(out.info));
    assert.match(out.info.file.via || '', /upstream/);
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
});

await check('nothing known about the file: consensus timing, PAL subtitle fixed', async () => {
    const world = makeWorld(palFirst);
    const out = await buildDual(request({}), { fetchImpl: world.fetch });
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
    const out = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }), { fetchImpl: world.fetch });
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
    const out = await buildDual(request({ url: world.fileUrl, via: 'play' }), { fetchImpl: world.fetch });
    assert.equal(out.info.main?.id, 'fr-ok', JSON.stringify(out.info.main));
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
});

await check('no English subtitles: the French line alone, still synced', async () => {
    const world = makeWorld(speech => ({
        subtitles: [{ id: 'fr-pal', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 1, ratio: PAL, offsetMs: 2_500 }) }]
    }));
    const out = await buildDual(request({ url: world.fileUrl, via: 'play' }), { fetchImpl: world.fetch });
    assert.ok(out.srt);
    assert.ok(out.info.notes.includes('no_translation_subtitles'));
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
});

await check('no French subtitles at all: explained failure', async () => {
    const world = makeWorld(speech => ({
        subtitles: [{ id: 'en-1', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 9 }) }]
    }));
    const out = await buildDual(request({}), { fetchImpl: world.fetch });
    assert.equal(out.srt, null);
    assert.ok(out.info.notes.includes('no_main_language_subtitles'));
});

await check('an embedded track that fits nothing (signs only, another cut) is not the reference', async () => {
    const world = makeWorld(speech => ({
        embeddedSpans: deriveSubtitle(speechTrack(555, 100 * 60_000), { seed: 10 }),
        subtitles: palFirst(speech).subtitles
    }));
    const out = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }), { fetchImpl: world.fetch });
    assert.ok(out.info.notes.includes('reference_rejected:file'), out.info.notes.join());
    assert.equal(out.info.references?.[0].id, 'file');
    assert.equal(out.info.references?.[0].accepted, false);
    assert.ok(['consensus', 'guess'].includes(out.info.tier), out.info.tier);
    assert.ok(out.info.main?.confident && out.info.trans?.confident, JSON.stringify(out.info));
    assert.ok((out.info.pair ?? 0) >= 0.45, `lines together: ${out.info.pair}`);
});

await check('each language alone comes out on the same timeline', async () => {
    const world = makeWorld(palFirst);
    const out = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }), { fetchImpl: world.fetch });
    assert.ok(out.mainSrt && out.transSrt);
    assert.ok(srtAccuracy(out.mainSrt!, world.speech) > 0.95);
    assert.ok(srtAccuracy(out.transSrt!, world.speech) > 0.95);
    assert.doesNotMatch(out.mainSrt!, /<i>/);
    assert.ok(out.info.timings && out.info.timings.align >= 0 && out.info.timings.download >= 0, JSON.stringify(out.info.timings));
});

await check('reported: bad sync retires the reference, a bad subtitle goes to the back', async () => {
    const world = makeWorld(palFirst);
    const first = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }), { fetchImpl: world.fetch });
    assert.deepEqual(first.info.refBan, ['file']);

    const resync = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }, {
        bans: { refs: first.info.refBan!, subs: [] }
    }), { fetchImpl: world.fetch });
    assert.notEqual(resync.info.tier, 'file');
    const fileRef = resync.info.references?.find(r => r.id === 'file');
    assert.ok(fileRef && fileRef.banned && !fileRef.accepted && fileRef.why === 'reported as bad sync', JSON.stringify(fileRef));

    const otherMain = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }, {
        bans: { refs: [], subs: [first.info.main!.id, first.info.trans!.id] }
    }), { fetchImpl: world.fetch });
    assert.notEqual(otherMain.info.main?.id, first.info.main?.id);
    assert.notEqual(otherMain.info.trans?.id, first.info.trans?.id);
    assert.ok(srtAccuracy(otherMain.srt!, world.speech) > 0.95);
});

await check('nothing fits the embedded track and the two languages disagree: still one timeline for both', async () => {
    const world = makeWorld(speech => ({
        embeddedSpans: deriveSubtitle(speechTrack(556, 100 * 60_000), { seed: 12 }),
        subtitles: [
            { id: 'fr-web', lang: 'fre' as const, spans: deriveSubtitle(speech, { seed: 2, offsetMs: 6_000, resplitShare: 0.2 }) },
            { id: 'en-pal', lang: 'eng' as const, spans: deriveSubtitle(speech, { seed: 11, ratio: PAL, offsetMs: -4_000 }) }
        ]
    }));
    const out = await buildDual(request({ url: world.fileUrl, via: 'play' }), { fetchImpl: world.fetch });
    assert.ok(out.info.trans?.confident, JSON.stringify(out.info.trans));
    assert.ok((out.info.pair ?? 0) >= 0.45, `lines together: ${out.info.pair}`);
    const both = (out.srt!.match(/<b>.+<\/b>\n<i>> /g) || []).length;
    const lines = (out.srt!.match(/ --> /g) || []).length;
    assert.ok(both / lines > 0.8, `${both} of ${lines} entries carry both lines`);
});

await check('colors: each language line in its own color, the plain format unchanged without', async () => {
    const world = makeWorld(palFirst);
    const out = await buildDual(request({ url: world.fileUrl, filename: FILENAME, via: 'play' }, {
        colors: { main: '#FFE066', trans: '#8CD9FF' }
    }), { fetchImpl: world.fetch });
    assert.match(out.srt!, /<font color="#FFE066"><b>.+<\/b><\/font>\n<font color="#8CD9FF"><i>> .+<\/i><\/font>/);
    assert.ok(srtAccuracy(out.srt!, world.speech) > 0.95);
    assert.match(out.mainSrt!, /^1\n.+\n<font color="#FFE066">/);
    assert.match(out.transSrt!, /^1\n.+\n<font color="#8CD9FF">/);

    const fmt = dualFormatter({ main: '#FFE066', trans: '#8CD9FF' });
    assert.equal(fmt('<font color="#ff0000">Bonjour</font>\n<i>toi</i>', 'Hello\nyou'),
        '<font color="#FFE066"><b>Bonjour\n<i>toi</i></b></font>\n<font color="#8CD9FF"><i>> Hello\nyou</i></font>',
        'one block per language (a source <i> may span its lines); the source\'s own color dropped');
    assert.equal(fmt('Seul', null), '<font color="#FFE066">Seul</font>');
    assert.equal(fmt(null, 'Credits'), '<font color="#8CD9FF"><i>> Credits</i></font>');
    assert.equal(dualFormatter()('Bonjour', 'Hello'), '<b>Bonjour</b>\n<i>> Hello</i>', 'no colors: as before');
    assert.equal(paint('  ', '#FFE066'), '  ', 'nothing to color');
    assert.equal(parseColor(undefined, 'Yellow [#FFE066]'), '#FFE066');
    assert.equal(parseColor('Player default (no color) [none]', 'Yellow [#FFE066]'), undefined);
    assert.equal(parseColor('#a8f0a0', 'Yellow [#FFE066]'), '#A8F0A0');
    assert.equal(parseColor('red"><b', 'Yellow [#FFE066]'), undefined);
});

console.log(passed.join('\n'));
console.log(`pipeline: ${passed.length} passed`);
