// Builds one dual-language subtitle for one video, synced to the file being
// played whenever anything about that file is known.
//
// Why the original Strelingo drifted: it synced the translation to the main
// subtitle, but took the main subtitle as-is from the top of the OpenSubtitles
// list. When that subtitle was made for another release (a 25 fps French TV
// rip, a cut with a different intro), every merged option inherited its
// timing — and Nuvio's phone app sends no file name or hash, so the top of
// the list is a guess.
//
// Here both languages are synced to one reference timeline, best first:
//
//   file       the video's own embedded subtitle track, read from the MKV
//              index of the very file being played
//   hash       a subtitle OpenSubtitles matched to the file's hash
//   consensus  the timing most downloaded subtitles agree on (no file info)
//   guess      nothing agrees: the top main-language subtitle
//
// Each candidate is aligned to the reference (fps, offset, cuts — see
// sync/aligner.ts); one that doesn't fit (another cut, another episode, a
// broken upload) is passed over for the next.

import { probeFile, type ProbeResult } from '../file/probe';
import { fetchUpstreamStreams, matchStream, playingFileOf } from '../file/upstream';
import { ISO639_3_TO_1 } from '../encoding';
import type { OptionalProviderConfig } from '../providers';
import { formatSrt } from '../subs/formats';
import { listCandidates, loadSubtitle, type CandidateLists, type LoadedSubtitle } from '../subs/sources';
import { mergeSubtitlesByTime, type SubtitleCue } from '../subtitleMatching';
import { alignToReference, sameTimelineScore, type AlignResult, type Span } from '../sync/aligner';

export interface FileHint {
    url?: string;
    headers?: Record<string, string>;
    filename?: string;
    size?: number;
    hash?: string;
    /** How the add-on learned about the file: "play" (a 🎓 stream), "request" (the player said), "upstream". */
    via?: string;
}

export interface SmartRequest {
    type: string;
    videoId: string;
    /** "tt1234567" */
    imdbId: string;
    season?: string;
    episode?: string;
    butaId?: string;
    mainLang: string;
    transLang: string;
    optional: OptionalProviderConfig;
    upstreamUrl?: string;
    file: FileHint;
    /** 1 = best (★); 2 = the alternative (↻): another timeline or the next-best pair. */
    variant: 1 | 2;
}

export type Tier = 'file' | 'hash' | 'consensus' | 'guess' | 'none';

export interface PickInfo {
    id: string;
    source: string;
    rank: number;
    hashMatch: boolean;
    alignedTo: 'reference' | 'main' | 'itself' | 'unsynced';
    ratio: number;
    offsetMs: number;
    splits: number;
    contrast: number;
    matched: number;
    confident: boolean;
}

export interface BuildInfo {
    stage: 'quick' | 'final';
    tier: Tier;
    reference?: string;
    file: {
        known: boolean;
        via?: string;
        filename?: string;
        size?: number;
        hash?: string;
        embedded?: string;
    };
    main?: PickInfo;
    trans?: PickInfo;
    candidates: { main: number; trans: number; loadedMain: number; loadedTrans: number; sources: Record<string, number> };
    notes: string[];
    ms: number;
}

export interface BuildOutput {
    /** null when nothing could be built; info.notes says why. */
    srt: string | null;
    info: BuildInfo;
}

export type Publish = (out: BuildOutput) => void;

const MAX_PER_LANGUAGE = 4;
const PROBE_TIMEOUT_MS = 15_000;
// Two subtitles share a timeline when their overlap with no shift or fps
// change (±0.4 s) stands this far above chance (see sameTimelineScore).
const SAME_TIMELINE = 0.6;
const PAL_RATIO = 25 / 23.976;

interface Reference {
    kind: Tier;
    spans: Span[];
    label: string;
    /** The downloaded subtitle that is the reference (consensus/hash/guess). */
    self?: LoadedSubtitle;
}

interface Evaluated {
    loaded: LoadedSubtitle;
    align: AlignResult;
    alignedTo: PickInfo['alignedTo'];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
}

async function firstLoaded(loads: Array<Promise<LoadedSubtitle | null>>): Promise<LoadedSubtitle | null> {
    for (const p of loads) {
        const v = await p;
        if (v) return v;
    }
    return null;
}

function describe(l: LoadedSubtitle): string {
    const c = l.candidate;
    return `${c.lang} ${c.source}#${c.rank + 1}${c.hashMatch ? ' (hash match)' : ''}`;
}

function identity(l: LoadedSubtitle): AlignResult {
    return {
        spans: l.spans.map(s => ({ ...s })), ratio: 1, offsetMs: 0, splits: 0,
        score: 1, matched: 1, contrast: 1, confident: true
    };
}

function quality(e: Evaluated): number {
    const a = e.align;
    return (a.confident ? 10 : 0) + 0.6 * a.contrast + 0.4 * a.matched + (e.loaded.candidate.hashMatch ? 0.15 : 0);
}

function pickInfo(e: Evaluated): PickInfo {
    const c = e.loaded.candidate;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    return {
        id: c.id, source: c.source, rank: c.rank, hashMatch: c.hashMatch, alignedTo: e.alignedTo,
        ratio: round(e.align.ratio), offsetMs: e.align.offsetMs, splits: e.align.splits,
        contrast: round(e.align.contrast), matched: round(e.align.matched), confident: e.align.confident
    };
}

function msToSrt(ms: number): string {
    const v = Math.max(0, Math.round(ms));
    const pad = (n: number, w: number) => String(n).padStart(w, '0');
    return `${pad(Math.floor(v / 3600000), 2)}:${pad(Math.floor(v / 60000) % 60, 2)}:${pad(Math.floor(v / 1000) % 60, 2)},${pad(v % 1000, 3)}`;
}

function retime(cues: SubtitleCue[], spans: Span[]): SubtitleCue[] {
    const out: SubtitleCue[] = [];
    for (let i = 0; i < cues.length; i++) {
        const s = spans[i];
        if (!s || s.end <= 0) continue;
        out.push({ ...cues[i], startTime: msToSrt(s.start), endTime: msToSrt(Math.max(s.end, s.start + 1)) });
    }
    return out;
}

/** Groups subtitles that share a timeline; the biggest group's best member is the reference. */
function consensus(all: LoadedSubtitle[], mainLang: string, notes: string[]): { ref: Reference; alt?: Reference } {
    const n = all.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const agree = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const s = Math.min(sameTimelineScore(all[i].spans, all[j].spans), sameTimelineScore(all[j].spans, all[i].spans));
            if (s >= SAME_TIMELINE) {
                parent[find(i)] = find(j);
                agree[i]++;
                agree[j]++;
            }
        }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root)!.push(i);
    }
    const isMain = (i: number) => all[i].candidate.lang === mainLang || mainLang.startsWith(all[i].candidate.lang);
    const rep = (members: number[]) => [...members].sort((a, b) =>
        agree[b] - agree[a]
        || Number(isMain(b)) - Number(isMain(a))
        || all[a].candidate.rank - all[b].candidate.rank)[0];
    const clusters = [...groups.values()].sort((a, b) =>
        b.length - a.length
        || Number(b.some(i => all[i].candidate.hashMatch)) - Number(a.some(i => all[i].candidate.hashMatch))
        || Math.min(...a.map(i => all[i].candidate.rank)) - Math.min(...b.map(i => all[i].candidate.rank)));

    let [first, second] = clusters;
    // Near-tie between a 25 fps (PAL) timing and the film-speed one: streams
    // are almost always film speed, so prefer that.
    if (second && first.length - second.length <= 1) {
        const r = alignToReference(all[rep(second)].spans, all[rep(first)].spans, { allowSplits: false });
        if (r.confident && Math.abs(r.ratio - PAL_RATIO) < 0.003) {
            [first, second] = [second, first];
            notes.push('preferred_film_speed_over_pal');
        }
    }
    const make = (members: number[]): Reference => {
        const self = all[rep(members)];
        return {
            kind: members.length >= 2 ? 'consensus' : 'guess',
            spans: self.spans,
            label: `${describe(self)}, agreed by ${members.length - 1} other(s)`,
            self
        };
    };
    return { ref: make(first), alt: second ? make(second) : undefined };
}

function twoLetter(code: string): string {
    return ISO639_3_TO_1[code] || code.slice(0, 2);
}

export async function buildDual(
    req: SmartRequest,
    publish: Publish = () => undefined,
    deps: { fetchImpl?: typeof fetch } = {}
): Promise<BuildOutput> {
    const t0 = Date.now();
    const f = deps.fetchImpl ?? fetch;
    const notes: string[] = [];
    let file: FileHint = { ...req.file };

    // 1. The player named the file but gave no URL: find it in the user's stream add-on.
    if (!file.url && req.upstreamUrl && (file.filename || file.size)) {
        try {
            const streams = await fetchUpstreamStreams(req.upstreamUrl, req.type, req.videoId, f);
            const match = matchStream(streams, file.filename, file.size, Number(req.season || 0), Number(req.episode || 0));
            const found = match ? playingFileOf(match) : null;
            if (found) {
                file = {
                    ...file, url: found.url, headers: found.headers,
                    filename: file.filename || found.filename, size: file.size || found.size,
                    via: file.via ? `${file.via}+upstream` : 'upstream'
                };
            } else {
                notes.push('stream_not_found_in_stream_addon');
            }
        } catch {
            notes.push('stream_addon_unreachable');
        }
    }

    // 2. Read what the file itself can tell: its hash and embedded subtitle timings.
    let probe: ProbeResult | null = null;
    if (file.url) {
        probe = await withTimeout(probeFile(file.url, {
            headers: file.headers, size: file.size,
            preferLangs: [req.mainLang, twoLetter(req.mainLang), req.transLang, twoLetter(req.transLang)],
            fetchImpl: f
        }), PROBE_TIMEOUT_MS);
        if (!probe) notes.push('file_probe_timeout');
        else if (!probe.mkv.ok) notes.push(`no_embedded_timings:${probe.mkv.reason}`);
    }
    const videoHash = file.hash || probe?.hash;
    const videoSize = file.size || probe?.size;
    const fileInfo: BuildInfo['file'] = {
        known: Boolean(file.url || file.filename || file.size || file.hash),
        via: file.via, filename: file.filename, size: videoSize, hash: videoHash,
        embedded: probe?.mkv.ok
            ? `${probe.mkv.track.lang}${probe.mkv.track.name ? ` "${probe.mkv.track.name}"` : ''}: ${probe.mkv.spans.length} lines`
            : undefined
    };

    // 3. Candidates in both languages.
    const lists: CandidateLists = await listCandidates({
        type: req.type, imdbId: req.imdbId, season: req.season, episode: req.episode, butaId: req.butaId,
        filename: file.filename, videoSize, videoHash
    }, req.mainLang, req.transLang, req.optional, f);

    const baseInfo = (): BuildInfo => ({
        stage: 'final', tier: 'none', file: fileInfo, notes,
        candidates: { main: lists.main.length, trans: lists.trans.length, loadedMain: 0, loadedTrans: 0, sources: lists.counts },
        ms: Date.now() - t0
    });

    if (lists.main.length === 0) {
        notes.push('no_main_language_subtitles');
        return { srt: null, info: baseInfo() };
    }

    const mainLoads = lists.main.slice(0, MAX_PER_LANGUAGE).map(c => loadSubtitle(c, f));
    const transLoads = lists.trans.slice(0, MAX_PER_LANGUAGE).map(c => loadSubtitle(c, f));

    // Quick stage: the top pair, translation fitted to the main line only.
    // Served if the full build isn't done in time; replaced as soon as it is.
    let finalPublished = false;
    void (async () => {
        const [m, t] = await Promise.all([firstLoaded(mainLoads), firstLoaded(transLoads)]);
        if (!m || finalPublished) return;
        const cues = t ? mergeSubtitlesByTime(m.cues, t.cues) : m.cues;
        const srt = formatSrt(cues);
        if (srt && !finalPublished) publish({ srt, info: { ...baseInfo(), stage: 'quick', tier: 'none' } });
    })();

    const loadedMain = (await Promise.all(mainLoads)).filter((l): l is LoadedSubtitle => Boolean(l));
    const loadedTrans = (await Promise.all(transLoads)).filter((l): l is LoadedSubtitle => Boolean(l));
    if (loadedMain.length === 0) {
        notes.push('main_language_downloads_failed');
        finalPublished = true;
        return { srt: null, info: baseInfo() };
    }

    // 4. The reference timeline.
    let ref: Reference;
    let altRef: Reference | undefined;
    const hashed = [...loadedMain, ...loadedTrans].find(l => l.candidate.hashMatch);
    if (probe?.mkv.ok) {
        ref = { kind: 'file', spans: probe.mkv.spans, label: `the file's embedded subtitles (${fileInfo.embedded})` };
    } else if (hashed) {
        ref = { kind: 'hash', spans: hashed.spans, label: describe(hashed), self: hashed };
    } else {
        const c = consensus([...loadedMain, ...loadedTrans], req.mainLang, notes);
        ref = c.ref;
        altRef = c.alt;
    }
    let pickIndex = 0;
    if (req.variant === 2) {
        if (altRef) ref = altRef;
        else pickIndex = 1;
    }

    // 5. Fit every candidate to the reference; keep the best of each language.
    const evaluate = (l: LoadedSubtitle): Evaluated => (ref.self === l
        ? { loaded: l, align: identity(l), alignedTo: 'itself' }
        : { loaded: l, align: alignToReference(ref.spans, l.spans), alignedTo: 'reference' });
    const sortEvaluated = (list: Evaluated[]) => list.sort((a, b) =>
        quality(b) - quality(a) || a.loaded.candidate.rank - b.loaded.candidate.rank);

    const evMain = sortEvaluated(loadedMain.map(evaluate));
    const main = evMain[Math.min(pickIndex, evMain.length - 1)];
    if (!main.align.confident) notes.push('main_subtitle_low_confidence');

    let trans: Evaluated | undefined;
    if (loadedTrans.length > 0) {
        const evTrans = sortEvaluated(loadedTrans.map(evaluate));
        trans = evTrans[Math.min(pickIndex, evTrans.length - 1)];
        if (!trans.align.confident) {
            // No good fit to the reference: fit it to the synced main line instead.
            const toMain = alignToReference(main.align.spans, trans.loaded.spans);
            if (toMain.confident) trans = { loaded: trans.loaded, align: toMain, alignedTo: 'main' };
            else notes.push('translation_low_confidence');
        }
    } else {
        notes.push('no_translation_subtitles');
    }

    // 6. Merge on the shared timeline.
    const mainCues = retime(main.loaded.cues, main.align.spans);
    const cues = trans
        ? mergeSubtitlesByTime(mainCues, retime(trans.loaded.cues, trans.align.spans), 500, { align: false })
        : mainCues;
    const srt = formatSrt(cues);
    if (!srt) {
        notes.push('format_failed');
        finalPublished = true;
        return { srt: null, info: baseInfo() };
    }

    const info: BuildInfo = {
        ...baseInfo(),
        stage: 'final',
        tier: ref.kind,
        reference: ref.label,
        main: pickInfo(main),
        trans: trans ? pickInfo(trans) : undefined
    };
    info.candidates.loadedMain = loadedMain.length;
    info.candidates.loadedTrans = loadedTrans.length;
    finalPublished = true;
    const out = { srt, info };
    publish(out);
    return out;
}
