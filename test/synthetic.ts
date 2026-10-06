// Synthetic subtitle timelines for alignment tests: a "speech" track for a
// video, and subtitles derived from it the way real releases differ (fps,
// offsets, ad-break cuts, line splitting, missing/extra lines).

export interface TrueSpan {
    start: number;
    end: number;
    /** Index of the speech span this line came from (-1 for an extra line). */
    source: number;
}

export function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Speech spans for a video of `durationMs`, starting after a short intro. */
export function speechTrack(seed: number, durationMs = 2 * 3600_000): TrueSpan[] {
    const rand = rng(seed);
    const out: TrueSpan[] = [];
    let t = 30_000 + rand() * 60_000;
    while (t < durationMs - 60_000) {
        const dur = 900 + rand() * 4200;
        out.push({ start: Math.round(t), end: Math.round(t + dur), source: out.length });
        // Mostly short pauses, sometimes a long silent stretch.
        t += dur + (rand() < 0.08 ? 15_000 + rand() * 60_000 : 150 + rand() * 4000);
    }
    return out;
}

interface DeriveOptions {
    seed: number;
    /** inc time = video time * ratio + offset (applied before cuts). */
    ratio?: number;
    offsetMs?: number;
    /** [videoTimeMs, extraShiftMs]: after videoTimeMs, the subtitle runs extraShiftMs earlier (an ad break the subtitle's release didn't have). */
    cuts?: Array<[number, number]>;
    jitterMs?: number;
    dropShare?: number;
    extraShare?: number;
    /** Share of lines split in two / merged with the next (different language segmentation). */
    resplitShare?: number;
}

export function deriveSubtitle(speech: TrueSpan[], opts: DeriveOptions): TrueSpan[] {
    const rand = rng(opts.seed);
    const ratio = opts.ratio ?? 1;
    const offset = opts.offsetMs ?? 0;
    const jitter = opts.jitterMs ?? 120;
    const cuts = [...(opts.cuts ?? [])].sort((a, b) => a[0] - b[0]);

    const mapTime = (t: number): number => {
        let shifted = t;
        for (const [at, shift] of cuts) if (t >= at) shifted -= shift;
        return shifted * ratio + offset;
    };

    // An ad break is a stretch of video the subtitle's release doesn't have:
    // nobody talks in it, so no line falls inside [at, at + shift).
    const inBreak = (t: number) => cuts.some(([at, shift]) => t >= at && t < at + shift);

    const out: TrueSpan[] = [];
    for (let i = 0; i < speech.length; i++) {
        const span = speech[i];
        if (inBreak(span.start) || inBreak(span.end)) continue;
        if (rand() < (opts.dropShare ?? 0)) continue;
        const j = () => (rand() - 0.5) * 2 * jitter;
        const start = mapTime(span.start) + j();
        const end = mapTime(span.end) + j();
        if (rand() < (opts.resplitShare ?? 0) && end - start > 1600) {
            const mid = (start + end) / 2;
            out.push({ start, end: mid - 40, source: span.source });
            out.push({ start: mid + 40, end, source: span.source });
        } else {
            out.push({ start, end, source: span.source });
        }
    }

    const extras = Math.round(out.length * (opts.extraShare ?? 0));
    const last = out.length ? out[out.length - 1].end : 0;
    for (let k = 0; k < extras; k++) {
        const start = rand() * last;
        out.push({ start, end: start + 800 + rand() * 2500, source: -1 });
    }
    out.sort((a, b) => a.start - b.start);
    return out.map(s => ({ start: Math.round(s.start), end: Math.round(s.end), source: s.source }));
}

/** Share of derived lines whose aligned start is within `toleranceMs` of the true speech start. */
export function accuracy(
    aligned: Array<{ start: number }>,
    derived: TrueSpan[],
    speech: TrueSpan[],
    toleranceMs = 400
): number {
    let total = 0;
    let good = 0;
    for (let i = 0; i < derived.length; i++) {
        const src = derived[i].source;
        if (src < 0) continue;
        total++;
        // A split line's second half starts mid-span; compare against the span itself.
        const truth = speech[src];
        const s = aligned[i].start;
        if (s >= truth.start - toleranceMs && s <= truth.end + toleranceMs
            && (Math.abs(s - truth.start) <= toleranceMs || derived[i - 1]?.source === src)) {
            good++;
        }
    }
    return total ? good / total : 0;
}
