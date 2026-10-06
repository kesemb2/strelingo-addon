import assert from 'node:assert/strict';
import { alignToReference, sameTimelineScore } from '../src/sync/aligner.ts';
import { accuracy, deriveSubtitle, speechTrack } from './synthetic.ts';

const PAL = 23.976 / 25;
const results: string[] = [];

function check(name: string, fn: () => void) {
    const t0 = performance.now();
    fn();
    results.push(`  ok  ${name} (${Math.round(performance.now() - t0)} ms)`);
}

const speech = speechTrack(1);
// The reference: the video's own subtitle track, a bit noisy itself.
const ref = deriveSubtitle(speech, { seed: 100, jitterMs: 80, dropShare: 0.05 });

check('already in sync stays in sync', () => {
    const inc = deriveSubtitle(speech, { seed: 2, resplitShare: 0.2 });
    const r = alignToReference(ref, inc);
    assert.ok(r.confident, JSON.stringify({ ...r, spans: undefined }));
    assert.equal(r.splits, 0);
    assert.ok(Math.abs(r.offsetMs) < 150, `offset ${r.offsetMs}`);
    assert.ok(accuracy(r.spans, inc, speech) > 0.97);
});

check('constant offset (studio logo of different length)', () => {
    const inc = deriveSubtitle(speech, { seed: 3, offsetMs: 7_340, resplitShare: 0.25 });
    const r = alignToReference(ref, inc);
    assert.ok(r.confident);
    assert.ok(accuracy(r.spans, inc, speech) > 0.97, String(accuracy(r.spans, inc, speech)));
});

check('PAL speed-up (25 fps release) + offset — the classic French-subtitle drift', () => {
    const inc = deriveSubtitle(speech, { seed: 4, ratio: PAL, offsetMs: -2_100, resplitShare: 0.3 });
    const r = alignToReference(ref, inc);
    assert.ok(r.confident);
    assert.ok(Math.abs(r.ratio - 25 / 23.976) < 0.0005, `ratio ${r.ratio}`);
    assert.ok(accuracy(r.spans, inc, speech) > 0.97, String(accuracy(r.spans, inc, speech)));
});

check('two ad-break cuts (TV episode)', () => {
    const inc = deriveSubtitle(speech, {
        seed: 5, offsetMs: 1_500, cuts: [[25 * 60_000, 31_000], [62 * 60_000, 44_000]]
    });
    const r = alignToReference(ref, inc);
    assert.ok(r.confident);
    assert.ok(r.splits >= 2, `splits ${r.splits}`);
    assert.ok(accuracy(r.spans, inc, speech) > 0.95, String(accuracy(r.spans, inc, speech)));
});

check('cut + PAL together', () => {
    const inc = deriveSubtitle(speech, { seed: 6, ratio: PAL, offsetMs: 900, cuts: [[40 * 60_000, 12_000]] });
    const r = alignToReference(ref, inc);
    assert.ok(r.confident);
    assert.ok(accuracy(r.spans, inc, speech) > 0.95, String(accuracy(r.spans, inc, speech)));
});

check('missing and extra lines (SDH, translator credits)', () => {
    const inc = deriveSubtitle(speech, { seed: 7, offsetMs: -4_000, dropShare: 0.2, extraShare: 0.1, resplitShare: 0.2 });
    const r = alignToReference(ref, inc);
    assert.ok(r.confident);
    assert.ok(accuracy(r.spans, inc, speech) > 0.95, String(accuracy(r.spans, inc, speech)));
});

check('reference with only timings and coarse durations (MKV cues)', () => {
    // Cues without durations: each line runs to the next one, capped at 4 s.
    const coarse = ref.map((s, i) => ({
        start: s.start,
        end: Math.min(s.start + 4000, i + 1 < ref.length ? ref[i + 1].start : s.start + 2500)
    }));
    const inc = deriveSubtitle(speech, { seed: 8, ratio: PAL, offsetMs: 3_000, resplitShare: 0.3 });
    const r = alignToReference(coarse, inc);
    assert.ok(r.confident);
    assert.ok(accuracy(r.spans, inc, speech) > 0.93, String(accuracy(r.spans, inc, speech)));
});

check('subtitle of another movie is rejected', () => {
    const other = deriveSubtitle(speechTrack(999), { seed: 9 });
    const r = alignToReference(ref, other);
    assert.ok(!r.confident, JSON.stringify({ ...r, spans: undefined }));
});

check('subtitle of another episode (same show rhythm) is rejected', () => {
    const other = deriveSubtitle(speechTrack(4242, 42 * 60_000), { seed: 10 });
    const episodeRef = deriveSubtitle(speechTrack(4243, 42 * 60_000), { seed: 11 });
    const r = alignToReference(episodeRef, other);
    assert.ok(!r.confident, JSON.stringify({ ...r, spans: undefined }));
});

check('sameTimelineScore separates same and shifted timelines', () => {
    const same = deriveSubtitle(speech, { seed: 12, resplitShare: 0.3 });
    const shifted = deriveSubtitle(speech, { seed: 13, offsetMs: 5_000 });
    const pal = deriveSubtitle(speech, { seed: 14, ratio: PAL });
    const ntsc = deriveSubtitle(speech, { seed: 15, ratio: 23.976 / 24, offsetMs: -3_000 });
    assert.ok(sameTimelineScore(ref, same) > 0.7, String(sameTimelineScore(ref, same)));
    assert.ok(sameTimelineScore(ref, shifted) < 0.45, String(sameTimelineScore(ref, shifted)));
    assert.ok(sameTimelineScore(ref, pal) < 0.3, String(sameTimelineScore(ref, pal)));
    // Drifts across the true timing mid-film: overlaps for a while, still not the same timeline.
    assert.ok(sameTimelineScore(ref, ntsc) < 0.45, String(sameTimelineScore(ref, ntsc)));
});

console.log(results.join('\n'));
console.log(`aligner: ${results.length} passed`);
