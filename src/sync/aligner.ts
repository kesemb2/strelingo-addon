// Aligns one subtitle timeline to a reference timeline.
//
// The reference is "when people talk in the video": the video's own embedded
// subtitle track (read from the MKV index), a subtitle matched to the file by
// its hash, or — when nothing about the file is known — the timing most
// subtitles for the title agree on. The subtitle being aligned can be in any
// language: only *when* lines appear matters, not what they say, so French
// and English lines split differently still line up by speech overlap.
//
// Same idea as alass (used by Smart-Hebrew-Subtitles), done in-process:
//
//   1. Frame-rate ratio + global offset: for each common fps conversion,
//      score every offset in a wide window by how much of the subtitle's
//      speech time lands on the reference's speech time. The sharpest peak
//      wins; a fine search around it refines both.
//   2. Splits: a dynamic program lets the offset change between lines
//      (ad-break cuts, an extra scene in another cut of the film), paying a
//      penalty per change so jitter never pays off. Splits are kept only when
//      they beat the single-offset result by a clear margin.
//
// Everything is O(lines × offsets) with O(1) overlap lookups on a 10 ms
// coverage grid: tens of milliseconds for a two-hour movie, so it runs even
// on a small free-tier CPU.

export interface Span {
    start: number;
    end: number;
}

export interface AlignResult {
    /** The aligned spans, index-for-index with the input. */
    spans: Span[];
    ratio: number;
    offsetMs: number;
    splits: number;
    /** Share of the subtitle's speech time that lands on reference speech (0..1). */
    score: number;
    /** Share of lines that materially overlap reference speech (0..1). */
    matched: number;
    /**
     * How much the winning alignment stands out from chance (0..1). A
     * subtitle for another movie or episode scores near 0: some offset
     * always overlaps *something*, but no offset stands out.
     */
    contrast: number;
    confident: boolean;
}

// Frame-rate conversions seen in practice (PAL speed-up, NTSC pulldown, …).
export const FPS_RATIOS: readonly number[] = [
    1,
    25 / 23.976,
    23.976 / 25,
    24 / 23.976,
    23.976 / 24,
    25 / 24,
    24 / 25
];

const GRID_MS = 10;
const MAX_GLOBAL_OFFSET_MS = 300_000;
const COARSE_STEP_MS = 250;
const COARSE_MAX_CUES = 700;
const FINE_RATIO_STEPS = 6;
const FINE_RATIO_DELTA = 0.0002;
const FINE_OFFSET_RANGE_MS = 1500;
const FINE_OFFSET_STEP_MS = 50;
const FINAL_OFFSET_RANGE_MS = 60;
const FINAL_OFFSET_STEP_MS = 10;

const SPLIT_WINDOW_MS = 150_000;
const SPLIT_STEP_MS = 100;
// Cost of changing the offset between two lines, in ms of overlap: well above
// what a single line can gain (≈ its duration), so only a lasting change — a
// cut — pays for itself. Far jumps cost a little more than near ones.
const SPLIT_PENALTY_MS = 2500;
const SPLIT_DISTANCE_COST = 0.03;
// After the DP, every run of lines at one offset must clearly beat its
// neighbours' offsets — by this much overlap, over at least this many
// lines — or it is folded into the better neighbour. Real cuts leave long
// runs that win by minutes; noise leaves short runs that win by little.
const MIN_SEGMENT_GAIN_MS = 6000;
const MIN_SEGMENT_RELATIVE_GAIN = 0.25;
const MIN_SEGMENT_LINES = 12;
// A run shifted against *both* neighbours (out and back) is what noise looks
// like; a real cut changes the offset and keeps it. Such a run needs more.
const MIN_EXCURSION_LINES = 25;
const MIN_EXCURSION_RELATIVE_GAIN = 0.5;

const MIN_SCORED_DURATION_MS = 300;
const MAX_SCORED_DURATION_MS = 7000;
const MATERIAL_OVERLAP_RATIO = 0.3;

export const MIN_CONFIDENT_CONTRAST = 0.45;
export const MIN_CONFIDENT_MATCHED = 0.45;
// A single offset that stands this far above chance means the subtitle is for
// this video even if cuts keep it from fitting everywhere.
const MIN_GLOBAL_CONTRAST = 0.2;

class Coverage {
    private readonly prefix: Int32Array;
    private readonly cells: Uint8Array;
    private readonly size: number;

    constructor(ref: Span[]) {
        let endMs = 0;
        for (const span of ref) endMs = Math.max(endMs, span.end);
        this.size = Math.ceil(endMs / GRID_MS) + 2;
        this.cells = new Uint8Array(this.size);
        for (const span of ref) {
            const from = Math.max(0, Math.floor(span.start / GRID_MS));
            const to = Math.min(this.size, Math.ceil(span.end / GRID_MS));
            this.cells.fill(1, from, to);
        }
        this.prefix = new Int32Array(this.size + 1);
        for (let i = 0; i < this.size; i++) this.prefix[i + 1] = this.prefix[i] + this.cells[i];
    }

    /** Covered milliseconds in [0, x). */
    upTo(x: number): number {
        if (x <= 0) return 0;
        const k = x / GRID_MS;
        const i = Math.floor(k);
        if (i >= this.size) return this.prefix[this.size] * GRID_MS;
        return (this.prefix[i] + (k - i) * this.cells[i]) * GRID_MS;
    }

    overlap(a: number, b: number): number {
        return b > a ? this.upTo(b) - this.upTo(a) : 0;
    }

    get coveredMs(): number {
        return this.prefix[this.size] * GRID_MS;
    }
}

interface Prepared {
    starts: Float64Array;
    ends: Float64Array;
    durations: Float64Array;
    totalMs: number;
}

// Very long cues (a sign held on screen) and tiny ones would otherwise weigh
// too much or too little; scoring uses a clamped duration around each midpoint.
function prepare(spans: Span[]): Prepared {
    const n = spans.length;
    const starts = new Float64Array(n);
    const ends = new Float64Array(n);
    const durations = new Float64Array(n);
    let totalMs = 0;
    for (let i = 0; i < n; i++) {
        const { start, end } = spans[i];
        const raw = Math.max(0, end - start);
        const dur = Math.min(MAX_SCORED_DURATION_MS, Math.max(MIN_SCORED_DURATION_MS, raw));
        const mid = start + raw / 2;
        starts[i] = mid - dur / 2;
        ends[i] = mid + dur / 2;
        durations[i] = dur;
        totalMs += dur;
    }
    return { starts, ends, durations, totalMs };
}

function scoreAt(cov: Coverage, inc: Prepared, ratio: number, offset: number, indices?: Int32Array): number {
    let total = 0;
    if (indices) {
        for (let j = 0; j < indices.length; j++) {
            const i = indices[j];
            total += cov.overlap(inc.starts[i] * ratio + offset, inc.ends[i] * ratio + offset);
        }
    } else {
        for (let i = 0; i < inc.starts.length; i++) {
            total += cov.overlap(inc.starts[i] * ratio + offset, inc.ends[i] * ratio + offset);
        }
    }
    return total;
}

function sampleIndices(n: number, max: number): Int32Array {
    const count = Math.min(n, max);
    const out = new Int32Array(count);
    for (let j = 0; j < count; j++) out[j] = Math.floor(j * n / count);
    return out;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface GlobalFit {
    ratio: number;
    offset: number;
    score: number;
    contrast: number;
    /** Share of speech overlapping at a typical (wrong) offset: what chance gives. */
    background: number;
}

function globalFit(cov: Coverage, inc: Prepared, ratios: readonly number[], maxOffsetMs: number): GlobalFit {
    const n = inc.starts.length;
    const sample = sampleIndices(n, COARSE_MAX_CUES);
    let sampleTotal = 0;
    for (let j = 0; j < sample.length; j++) sampleTotal += inc.durations[sample[j]];

    let best: GlobalFit = { ratio: 1, offset: 0, score: -1, contrast: 0, background: 0 };
    for (const ratio of ratios) {
        const scores: number[] = [];
        let bestScore = -1;
        let bestOffset = 0;
        for (let offset = -maxOffsetMs; offset <= maxOffsetMs; offset += COARSE_STEP_MS) {
            const s = scoreAt(cov, inc, ratio, offset, sample);
            scores.push(s);
            if (s > bestScore) {
                bestScore = s;
                bestOffset = offset;
            }
        }
        if (bestScore > best.score) {
            const background = median(scores);
            const contrast = sampleTotal > background ? (bestScore - background) / (sampleTotal - background) : 0;
            best = { ratio, offset: bestOffset, score: bestScore, contrast, background: background / sampleTotal };
        }
    }

    // Refine ratio and offset around the coarse peak, on every line.
    let ratio = best.ratio;
    let offset = best.offset;
    let score = -1;
    for (let k = -FINE_RATIO_STEPS; k <= FINE_RATIO_STEPS; k++) {
        const r = best.ratio * (1 + k * FINE_RATIO_DELTA);
        for (let o = best.offset - FINE_OFFSET_RANGE_MS; o <= best.offset + FINE_OFFSET_RANGE_MS; o += FINE_OFFSET_STEP_MS) {
            const s = scoreAt(cov, inc, r, o);
            if (s > score) {
                score = s;
                ratio = r;
                offset = o;
            }
        }
    }
    const coarseOffset = offset;
    for (let o = coarseOffset - FINAL_OFFSET_RANGE_MS; o <= coarseOffset + FINAL_OFFSET_RANGE_MS; o += FINAL_OFFSET_STEP_MS) {
        const s = scoreAt(cov, inc, ratio, o);
        if (s > score) {
            score = s;
            offset = o;
        }
    }
    return { ratio, offset, score, contrast: best.contrast, background: best.background };
}

interface SplitFit {
    offsets: Float64Array;
    score: number;
    splits: number;
}

// Per-line offsets in [base - window, base + window]: maximise total overlap
// minus a penalty for every change of offset. dp[k] holds the best total for
// the lines so far with the current line at offset k; a change from any k'
// costs SPLIT_PENALTY_MS + SPLIT_DISTANCE_COST·|k - k'|, computed for all k
// at once with a two-pass distance transform.
function splitFit(cov: Coverage, inc: Prepared, ratio: number, baseOffset: number): SplitFit {
    const n = inc.starts.length;
    const half = Math.round(SPLIT_WINDOW_MS / SPLIT_STEP_MS);
    const K = 2 * half + 1;
    const stepCost = SPLIT_DISTANCE_COST * SPLIT_STEP_MS;

    let prev = new Float64Array(K);
    let cur = new Float64Array(K);
    const reach = new Float64Array(K);
    const reachFrom = new Int32Array(K);
    const from = new Int16Array(n * K);

    for (let k = 0; k < K; k++) {
        const o = baseOffset + (k - half) * SPLIT_STEP_MS;
        prev[k] = cov.overlap(inc.starts[0] * ratio + o, inc.ends[0] * ratio + o);
        from[k] = k;
    }

    for (let i = 1; i < n; i++) {
        // reach[k] = max_j prev[j] - stepCost·|k - j|
        for (let k = 0; k < K; k++) {
            reach[k] = prev[k];
            reachFrom[k] = k;
        }
        for (let k = 1; k < K; k++) {
            const v = reach[k - 1] - stepCost;
            if (v > reach[k]) {
                reach[k] = v;
                reachFrom[k] = reachFrom[k - 1];
            }
        }
        for (let k = K - 2; k >= 0; k--) {
            const v = reach[k + 1] - stepCost;
            if (v > reach[k]) {
                reach[k] = v;
                reachFrom[k] = reachFrom[k + 1];
            }
        }
        const s = inc.starts[i] * ratio;
        const e = inc.ends[i] * ratio;
        const row = i * K;
        for (let k = 0; k < K; k++) {
            const o = baseOffset + (k - half) * SPLIT_STEP_MS;
            const stay = prev[k];
            const jump = reach[k] - SPLIT_PENALTY_MS;
            let base: number;
            if (jump > stay && reachFrom[k] !== k) {
                base = jump;
                from[row + k] = reachFrom[k];
            } else {
                base = stay;
                from[row + k] = k;
            }
            cur[k] = base + cov.overlap(s + o, e + o);
        }
        const tmp = prev;
        prev = cur;
        cur = tmp;
    }

    let bestK = half;
    for (let k = 0; k < K; k++) if (prev[k] > prev[bestK]) bestK = k;

    const ks = new Int32Array(n);
    ks[n - 1] = bestK;
    for (let i = n - 1; i > 0; i--) ks[i - 1] = from[i * K + ks[i]];

    const offsets = new Float64Array(n);
    for (let i = 0; i < n; i++) offsets[i] = baseOffset + (ks[i] - half) * SPLIT_STEP_MS;
    cleanSegments(cov, inc, ratio, offsets);

    let score = 0;
    let splits = 0;
    for (let i = 0; i < n; i++) {
        score += cov.overlap(inc.starts[i] * ratio + offsets[i], inc.ends[i] * ratio + offsets[i]);
        if (i > 0 && offsets[i] !== offsets[i - 1]) splits++;
    }
    return { offsets, score, splits };
}

interface Segment {
    from: number;
    to: number;     // inclusive
    offset: number;
}

function segmentsOf(offsets: Float64Array): Segment[] {
    const out: Segment[] = [];
    for (let i = 0; i < offsets.length;) {
        let j = i;
        while (j + 1 < offsets.length && offsets[j + 1] === offsets[i]) j++;
        out.push({ from: i, to: j, offset: offsets[i] });
        i = j + 1;
    }
    return out;
}

function segmentScore(cov: Coverage, inc: Prepared, ratio: number, seg: Segment, offset: number): number {
    let total = 0;
    for (let t = seg.from; t <= seg.to; t++) {
        total += cov.overlap(inc.starts[t] * ratio + offset, inc.ends[t] * ratio + offset);
    }
    return total;
}

// Folds every run that does not clearly beat its neighbours' offsets into the
// better neighbour, weakest first, until each remaining run earns its split.
// A short excursion (an untranslated stretch that grabbed speech elsewhere)
// or a jitter step disappears; a real cut stays.
function cleanSegments(cov: Coverage, inc: Prepared, ratio: number, offsets: Float64Array): void {
    for (let guard = 0; guard < 10_000; guard++) {
        const segs = segmentsOf(offsets);
        if (segs.length <= 1) return;
        let weakest = -1;
        let weakestGain = Infinity;
        let weakestTarget = 0;
        for (let s = 0; s < segs.length; s++) {
            const seg = segs[s];
            const own = segmentScore(cov, inc, ratio, seg, seg.offset);
            let bestAlt = -Infinity;
            let target = seg.offset;
            for (const nb of [segs[s - 1], segs[s + 1]]) {
                if (!nb) continue;
                const alt = segmentScore(cov, inc, ratio, seg, nb.offset);
                if (alt > bestAlt) {
                    bestAlt = alt;
                    target = nb.offset;
                }
            }
            const lines = seg.to - seg.from + 1;
            const prev = segs[s - 1];
            const next = segs[s + 1];
            const excursion = Boolean(prev && next && prev.offset === next.offset);
            const minLines = excursion ? MIN_EXCURSION_LINES : MIN_SEGMENT_LINES;
            const minShare = excursion ? MIN_EXCURSION_RELATIVE_GAIN : MIN_SEGMENT_RELATIVE_GAIN;
            // Gain left after the run's required margin; negative = fold it.
            const gain = lines < minLines
                ? -Infinity
                : own - bestAlt - Math.max(MIN_SEGMENT_GAIN_MS, minShare * own);
            if (gain < weakestGain) {
                weakestGain = gain;
                weakest = s;
                weakestTarget = target;
            }
        }
        if (weakestGain >= 0) return;
        const seg = segs[weakest];
        for (let t = seg.from; t <= seg.to; t++) offsets[t] = weakestTarget;
    }
}

function matchedShare(cov: Coverage, inc: Prepared, ratio: number, offsets: ArrayLike<number>): number {
    const n = inc.starts.length;
    if (n === 0) return 0;
    let matched = 0;
    for (let i = 0; i < n; i++) {
        const ov = cov.overlap(inc.starts[i] * ratio + offsets[i], inc.ends[i] * ratio + offsets[i]);
        if (ov >= MATERIAL_OVERLAP_RATIO * inc.durations[i]) matched++;
    }
    return matched / n;
}

export interface AlignOptions {
    ratios?: readonly number[];
    maxOffsetMs?: number;
    allowSplits?: boolean;
}

export function alignToReference(ref: Span[], incSpans: Span[], options: AlignOptions = {}): AlignResult {
    const empty: AlignResult = {
        spans: incSpans.map(s => ({ ...s })), ratio: 1, offsetMs: 0, splits: 0,
        score: 0, matched: 0, contrast: 0, confident: false
    };
    if (ref.length < 3 || incSpans.length < 3) return empty;

    const cov = new Coverage(ref);
    const inc = prepare(incSpans);
    if (inc.totalMs <= 0 || cov.coveredMs <= 0) return empty;

    const fit = globalFit(cov, inc, options.ratios ?? FPS_RATIOS, options.maxOffsetMs ?? MAX_GLOBAL_OFFSET_MS);
    const n = incSpans.length;
    let offsets: ArrayLike<number> = new Float64Array(n).fill(fit.offset);
    let score = fit.score;
    let splits = 0;

    if (options.allowSplits !== false && n >= 2 * MIN_SEGMENT_LINES) {
        const split = splitFit(cov, inc, fit.ratio, fit.offset);
        const margin = Math.max(SPLIT_PENALTY_MS, 0.01 * inc.totalMs);
        if (split.splits > 0 && split.score > fit.score + margin) {
            offsets = split.offsets;
            score = split.score;
            splits = split.splits;
        }
    }

    const matched = matchedShare(cov, inc, fit.ratio, offsets);
    const spans = incSpans.map((span, i) => ({
        start: Math.round(span.start * fit.ratio + offsets[i]),
        end: Math.round(span.end * fit.ratio + offsets[i])
    }));

    // How far the final alignment rises above chance. The single-offset peak
    // alone undersells a file with cuts (one offset fits only part of it),
    // so the final score counts too — but only when the single-offset peak
    // is itself well clear of chance, since splits can fit noise a little.
    const scoreShare = score / inc.totalMs;
    const finalContrast = fit.background < 1 ? (scoreShare - fit.background) / (1 - fit.background) : 0;
    const contrast = fit.contrast >= MIN_GLOBAL_CONTRAST ? Math.max(fit.contrast, finalContrast) : fit.contrast;

    return {
        spans,
        ratio: fit.ratio,
        offsetMs: Math.round(fit.offset),
        splits,
        score: scoreShare,
        matched,
        contrast,
        confident: contrast >= MIN_CONFIDENT_CONTRAST && matched >= MIN_CONFIDENT_MATCHED
    };
}

/**
 * Whether two subtitles already share one timeline (no shift, no fps change),
 * as a contrast in 0..1: how far the overlap at offset ≈ 0 (±maxShiftMs)
 * rises above what chance gives at clearly wrong offsets. In dense dialogue
 * about half of any subtitle overlaps speech by accident, so raw overlap
 * alone can't tell; ~0.8+ means same timeline, ≲0.3 means not.
 */
export function sameTimelineScore(a: Span[], b: Span[], maxShiftMs = 400): number {
    if (a.length < 3 || b.length < 3) return 0;
    const cov = new Coverage(a);
    const inc = prepare(b);
    if (inc.totalMs <= 0) return 0;
    let best = 0;
    for (let o = -maxShiftMs; o <= maxShiftMs; o += 50) {
        best = Math.max(best, scoreAt(cov, inc, 1, o));
    }
    const sample = sampleIndices(inc.starts.length, COARSE_MAX_CUES);
    let sampleTotal = 0;
    for (let j = 0; j < sample.length; j++) sampleTotal += inc.durations[sample[j]];
    const chance: number[] = [];
    for (let o = 15_000; o <= 120_000; o += 7_000) {
        chance.push(scoreAt(cov, inc, 1, o, sample) / sampleTotal, scoreAt(cov, inc, 1, -o, sample) / sampleTotal);
    }
    const bg = median(chance);
    const share = best / inc.totalMs;
    return bg < 1 ? Math.max(0, (share - bg) / (1 - bg)) : 0;
}
