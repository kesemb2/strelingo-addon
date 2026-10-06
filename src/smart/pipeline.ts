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
// A reference only counts once a subtitle actually fits it (an embedded track
// can be a signs-only or picture track); otherwise the next one is tried.
// Each candidate is aligned to the reference (fps, offset, cuts — see
// sync/aligner.ts); one that doesn't fit (another cut, another episode, a
// broken upload) is passed over for the next. The two lines must then agree
// with each other too, or the translation is fitted to the main line.
//
// What the user reported earlier (bad sync, bad translation...) arrives as
// bans: a banned reference or subtitle goes to the back of the line.

import { probeFile, type ProbeResult } from '../file/probe.js';
import { fetchUpstreamStreams, matchStream, playingFileOf } from '../file/upstream.js';
import { ISO639_3_TO_1 } from '../encoding.js';
import type { OptionalProviderConfig } from '../providers.js';
import { formatSrt } from '../subs/formats.js';
import { dualFormatter, paint, type LineColors } from '../subs/style.js';
import { listCandidates, loadSubtitle, type Candidate, type CandidateLists, type LoadedSubtitle } from '../subs/sources.js';
import { mergeSubtitlesByTime, type SubtitleCue } from '../subtitleMatching.js';
import { alignToReference, sameTimelineScore, type AlignResult, type Span } from '../sync/aligner.js';

export interface FileHint {
    url?: string;
    headers?: Record<string, string>;
    filename?: string;
    size?: number;
    hash?: string;
    /** How the add-on learned about the file: "play" (a 🎓 stream), "request" (the player said), "upstream". */
    via?: string;
}

/** What the user taught the add-on for one video: references and subtitles that were bad. */
export interface Bans {
    /** "file", or "sub:<id>" for a subtitle used as the timing reference. */
    refs: string[];
    /** Subtitle ids not to use as a line. */
    subs: string[];
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
    bans?: Bans;
    /** A color per language line. */
    colors?: LineColors;
}

export type Tier = 'file' | 'hash' | 'consensus' | 'guess' | 'none';

export interface CandidateInfo {
    id: string;
    lang: string;
    source: string;
    rank: number;
    release?: string;
    hashMatch: boolean;
    ratio: number;
    offsetMs: number;
    splits: number;
    contrast: number;
    matched: number;
    confident: boolean;
    banned?: boolean;
}

export interface PickInfo extends CandidateInfo {
    /** What its timing follows: the reference, the synced main line, itself (it is the reference), or its own (no fit). */
    alignedTo: 'reference' | 'main' | 'itself' | 'unsynced';
}

export interface ReferenceTried {
    id: string;
    kind: Tier;
    label: string;
    accepted: boolean;
    why: string;
    banned?: boolean;
}

export interface BuildInfo {
    stage: 'quick' | 'final';
    tier: Tier;
    reference?: string;
    /** Ban keys that retire this reference when the user reports bad sync. */
    refBan?: string[];
    references?: ReferenceTried[];
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
    /** How well the two lines share one timeline (0..1, ≳0.5 = together). */
    pair?: number;
    evaluated?: { main: CandidateInfo[]; trans: CandidateInfo[] };
    candidates: { main: number; trans: number; loadedMain: number; loadedTrans: number; sources: Record<string, number> };
    notes: string[];
    timings?: Record<string, number>;
    ms: number;
}

export interface BuildOutput {
    /** The two lines together; null when nothing could be built (info.notes says why). */
    srt: string | null;
    /** Each language alone, on the same timeline. */
    mainSrt?: string | null;
    transSrt?: string | null;
    info: BuildInfo;
}

const MAX_PER_LANGUAGE = 4;
const PROBE_TIMEOUT_MS = 15_000;
// Two subtitles share a timeline when their overlap with no shift or fps
// change (±0.4 s) stands this far above chance (see sameTimelineScore).
const SAME_TIMELINE = 0.6;
// The two output lines are accepted as together from here.
const PAIR_TOGETHER = 0.45;
// An alignment short of confident is still applied when it is clearly above
// chance; below that the subtitle keeps its own timing (a random shift of a
// minute would only make it worse).
const USABLE_CONTRAST = 0.3;
const USABLE_MATCHED = 0.35;
const PAL_RATIO = 25 / 23.976;

interface Reference {
    id: string;
    kind: Tier;
    spans: Span[];
    label: string;
    /** The downloaded subtitle that is the reference (consensus/hash/guess). */
    self?: LoadedSubtitle;
    ban: string[];
    banned: boolean;
}

interface Evaluated {
    loaded: LoadedSubtitle;
    align: AlignResult;
    /** Output timing: the alignment, or the subtitle's own when nothing fitted. */
    spans: Span[];
    alignedTo: PickInfo['alignedTo'];
    banned: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
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

function usable(a: AlignResult): boolean {
    return a.confident || (a.contrast >= USABLE_CONTRAST && a.matched >= USABLE_MATCHED);
}

function fitted(loaded: LoadedSubtitle, align: AlignResult, to: 'reference' | 'main', banned: boolean): Evaluated {
    return usable(align)
        ? { loaded, align, spans: align.spans, alignedTo: to, banned }
        : { loaded, align, spans: loaded.spans, alignedTo: 'unsynced', banned };
}

function quality(e: Evaluated): number {
    const a = e.align;
    return (a.confident ? 10 : 0) + 0.6 * a.contrast + 0.4 * a.matched + (e.loaded.candidate.hashMatch ? 0.15 : 0);
}

function sortEvaluated(list: Evaluated[]): Evaluated[] {
    return list.sort((a, b) =>
        Number(a.banned) - Number(b.banned)
        || quality(b) - quality(a)
        || a.loaded.candidate.rank - b.loaded.candidate.rank);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function candidateInfo(e: Evaluated): CandidateInfo {
    const c = e.loaded.candidate;
    return {
        id: c.id, lang: c.lang, source: c.source, rank: c.rank, release: c.releaseName, hashMatch: c.hashMatch,
        ratio: round3(e.align.ratio), offsetMs: e.align.offsetMs, splits: e.align.splits,
        contrast: round3(e.align.contrast), matched: round3(e.align.matched), confident: e.align.confident,
        ...(e.banned ? { banned: true } : {})
    };
}

function pickInfo(e: Evaluated): PickInfo {
    return { ...candidateInfo(e), alignedTo: e.alignedTo };
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

const subBan = (l: LoadedSubtitle) => `sub:${l.candidate.id}`;

/** Groups subtitles that share a timeline, biggest group first; each group's best member stands for it. */
function consensusReferences(all: LoadedSubtitle[], mainLang: string, notes: string[]): Reference[] {
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

    // Near-tie between a 25 fps (PAL) timing and the film-speed one: streams
    // are almost always film speed, so prefer that.
    if (clusters.length >= 2 && clusters[0].length - clusters[1].length <= 1) {
        const r = alignToReference(all[rep(clusters[1])].spans, all[rep(clusters[0])].spans, { allowSplits: false });
        if (r.confident && Math.abs(r.ratio - PAL_RATIO) < 0.003) {
            [clusters[0], clusters[1]] = [clusters[1], clusters[0]];
            notes.push('preferred_film_speed_over_pal');
        }
    }
    return clusters.map(members => {
        const self = all[rep(members)];
        return {
            id: subBan(self),
            kind: members.length >= 2 ? 'consensus' : 'guess',
            spans: self.spans,
            label: members.length >= 2
                ? `${describe(self)}, agreed by ${members.length - 1} other(s)`
                : `${describe(self)} (no other subtitle shares its timing)`,
            self,
            ban: members.map(i => subBan(all[i])),
            banned: false
        } satisfies Reference;
    });
}

function twoLetter(code: string): string {
    return ISO639_3_TO_1[code] || code.slice(0, 2);
}

/** The top of the list, plus the top non-banned ones when bans pushed some aside. */
function toLoad(list: Candidate[], bannedSubs: Set<string>): Candidate[] {
    const top = list.slice(0, MAX_PER_LANGUAGE);
    const fresh = list.filter(c => !bannedSubs.has(c.id)).slice(0, MAX_PER_LANGUAGE);
    return [...new Set([...top, ...fresh])];
}

export async function buildDual(
    req: SmartRequest,
    deps: { fetchImpl?: typeof fetch } = {}
): Promise<BuildOutput> {
    const t0 = Date.now();
    const f = deps.fetchImpl ?? fetch;
    const notes: string[] = [];
    const timings: Record<string, number> = {};
    const timed = async <T>(name: string, work: Promise<T>): Promise<T> => {
        const s = Date.now();
        try {
            return await work;
        } finally {
            timings[name] = Date.now() - s;
        }
    };
    const bannedRefs = new Set(req.bans?.refs || []);
    const bannedSubs = new Set(req.bans?.subs || []);
    let file: FileHint = { ...req.file };

    // 1. The player named the file but gave no URL: find it in the user's stream add-on.
    if (!file.url && req.upstreamUrl && (file.filename || file.size)) {
        await timed('streamAddon', (async () => {
            try {
                const streams = await fetchUpstreamStreams(req.upstreamUrl!, req.type, req.videoId, f);
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
        })());
    }

    // 2. Read what the file itself can tell (its hash and embedded subtitle
    //    timings) while the subtitle lists load.
    const probing: Promise<ProbeResult | null> = file.url
        ? timed('probe', withTimeout(probeFile(file.url, {
            headers: file.headers, size: file.size,
            preferLangs: [req.mainLang, twoLetter(req.mainLang), req.transLang, twoLetter(req.transLang)],
            fetchImpl: f
        }), PROBE_TIMEOUT_MS))
        : Promise.resolve(null);

    // The hash helps OpenSubtitles rank subtitles made for this file; worth a
    // short wait when the probe is quick, not the whole probe.
    const early = file.url ? await withTimeout(probing, 4_000) : null;
    const listQuery = {
        type: req.type, imdbId: req.imdbId, season: req.season, episode: req.episode, butaId: req.butaId,
        filename: file.filename, videoSize: file.size || early?.size, videoHash: file.hash || early?.hash || undefined
    };
    const lists: CandidateLists = await timed('list', listCandidates(listQuery, req.mainLang, req.transLang, req.optional, f));

    const mainPicks = toLoad(lists.main, bannedSubs);
    const transPicks = toLoad(lists.trans, bannedSubs);
    const downloads = timed('download', Promise.all([
        Promise.all(mainPicks.map(c => loadSubtitle(c, f))),
        Promise.all(transPicks.map(c => loadSubtitle(c, f)))
    ]));
    const probe = await probing;
    if (file.url) {
        if (!probe) notes.push('file_probe_timeout');
        else if (!probe.mkv.ok) notes.push(`no_embedded_timings:${probe.mkv.reason}`);
    }
    const videoHash = file.hash || probe?.hash || undefined;
    const fileInfo: BuildInfo['file'] = {
        known: Boolean(file.url || file.filename || file.size || file.hash),
        via: file.via, filename: file.filename, size: file.size || probe?.size, hash: videoHash,
        embedded: probe?.mkv.ok
            ? `${probe.mkv.track.lang}${probe.mkv.track.name ? ` "${probe.mkv.track.name}"` : ''}`
                + `${probe.mkv.track.codec ? ` ${probe.mkv.track.codec}` : ''}: ${probe.mkv.spans.length} lines`
            : undefined
    };

    const baseInfo = (): BuildInfo => ({
        stage: 'final', tier: 'none', file: fileInfo, notes,
        candidates: { main: lists.main.length, trans: lists.trans.length, loadedMain: 0, loadedTrans: 0, sources: lists.counts },
        timings, ms: Date.now() - t0
    });

    if (lists.main.length === 0) {
        notes.push('no_main_language_subtitles');
        await downloads;
        return { srt: null, info: baseInfo() };
    }

    const [mainLoads, transLoads] = await downloads;
    const loadedMain = mainLoads.filter((l): l is LoadedSubtitle => Boolean(l));
    const loadedTrans = transLoads.filter((l): l is LoadedSubtitle => Boolean(l));
    const counted = (info: BuildInfo) => {
        info.candidates.loadedMain = loadedMain.length;
        info.candidates.loadedTrans = loadedTrans.length;
        return info;
    };
    if (loadedMain.length === 0) {
        notes.push('main_language_downloads_failed');
        return { srt: null, info: counted(baseInfo()) };
    }

    const tAlign = Date.now();
    const isBanned = (l: LoadedSubtitle) => bannedSubs.has(l.candidate.id);
    const cache = new Map<Reference, Map<LoadedSubtitle, Evaluated>>();
    const evaluate = (l: LoadedSubtitle, ref: Reference): Evaluated => {
        let byRef = cache.get(ref);
        if (!byRef) cache.set(ref, byRef = new Map());
        let e = byRef.get(l);
        if (!e) {
            e = ref.self === l
                ? { loaded: l, align: identity(l), spans: l.spans, alignedTo: 'itself', banned: isBanned(l) }
                : fitted(l, alignToReference(ref.spans, l.spans), 'reference', isBanned(l));
            byRef.set(l, e);
        }
        return e;
    };

    // 3. Reference options, best first; banned ones last.
    const refs: Reference[] = [];
    if (probe?.mkv.ok) {
        refs.push({
            id: 'file', kind: 'file', spans: probe.mkv.spans, ban: ['file'], banned: false,
            label: `the file's embedded subtitles (${fileInfo.embedded})`
        });
    }
    for (const l of [...loadedMain, ...loadedTrans].filter(x => x.candidate.hashMatch)) {
        refs.push({ id: subBan(l), kind: 'hash', spans: l.spans, label: describe(l), self: l, ban: [subBan(l)], banned: false });
    }
    for (const r of consensusReferences([...loadedMain, ...loadedTrans], req.mainLang, notes)) {
        if (!refs.some(x => x.id === r.id)) refs.push(r);
    }
    for (const r of refs) r.banned = r.ban.some(b => bannedRefs.has(b));
    const ordered = [...refs.filter(r => !r.banned), ...refs.filter(r => r.banned)];

    // 4. Try them in order: a reference counts once a subtitle really fits it.
    const tried: ReferenceTried[] = [];
    const accepted: Array<{ ref: Reference; mains: Evaluated[] }> = [];
    const want = req.variant === 2 ? 2 : 1;
    for (const ref of ordered) {
        if (accepted.length >= want) break;
        const mains = sortEvaluated(loadedMain.map(l => evaluate(l, ref)));
        let ok = true;
        let why = '';
        if (ref.self) {
            why = ref.kind === 'hash' ? 'uploaded for this file (hash match)' : ref.kind === 'consensus' ? 'most subtitles share this timing' : 'best guess';
        } else if (mains.some(e => e.align.confident)) {
            why = 'a main-language subtitle fits it';
        } else if (loadedTrans.some(l => evaluate(l, ref).align.confident)) {
            why = 'a translation subtitle fits it (no main-language one does)';
        } else {
            ok = false;
            why = 'no subtitle fits it';
            notes.push(`reference_rejected:${ref.id}`);
        }
        tried.push({ id: ref.id, kind: ref.kind, label: ref.label, accepted: ok, why, ...(ref.banned ? { banned: true } : {}) });
        if (ok) accepted.push({ ref, mains });
    }
    for (const r of ordered) {
        if (r.banned && !tried.some(t => t.id === r.id)) {
            tried.push({ id: r.id, kind: r.kind, label: r.label, accepted: false, why: 'reported as bad sync', banned: true });
        }
    }
    if (accepted.length === 0) {
        // Nothing fits anything: the first option, as best effort.
        const ref = ordered[0];
        accepted.push({ ref, mains: sortEvaluated(loadedMain.map(l => evaluate(l, ref))) });
        notes.push('no_reference_fits');
    }

    // Variant 2: another timeline if one exists, else the next-best pair.
    let chosen = accepted[0];
    let mainIndex = 0;
    let skipFirstTrans = false;
    if (req.variant === 2) {
        if (accepted[1]) {
            chosen = accepted[1];
            notes.push('alternative:other_timing');
        } else {
            const next = chosen.mains.findIndex((e, i) => i > 0 && e.align.confident && !e.banned);
            if (next > 0) mainIndex = next;
            else skipFirstTrans = true;
            notes.push(next > 0 ? 'alternative:next_main' : 'alternative:next_translation');
        }
    }
    const ref = chosen.ref;
    if (ref.banned) notes.push('every_reference_was_reported');
    const main = chosen.mains[mainIndex];
    if (!main.align.confident) notes.push('main_subtitle_low_confidence');
    if (main.banned) notes.push('every_main_subtitle_was_reported');

    // 5. The translation: fitted to the reference, and together with the main
    //    line — else fitted to the main line itself.
    let trans: Evaluated | undefined;
    let pair: number | undefined;
    const evTrans = sortEvaluated(loadedTrans.map(l => evaluate(l, ref)));
    if (evTrans.length > 0) {
        const order = skipFirstTrans && evTrans.length > 1 ? [...evTrans.slice(1), evTrans[0]] : evTrans;
        let best: { e: Evaluated; pair: number } | undefined;
        const rankOf = (x: { e: Evaluated; pair: number }) => [Number(x.pair >= PAIR_TOGETHER), Number(!x.e.banned), x.pair];
        const consider = (o: Evaluated): boolean => {
            if (o.alignedTo === 'unsynced') return false;
            const cand = { e: o, pair: sameTimelineScore(main.spans, o.spans) };
            const a = rankOf(cand);
            const b = best ? rankOf(best) : null;
            if (!b || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = cand;
            return cand.pair >= PAIR_TOGETHER && !o.banned;
        };
        for (const e of order) {
            if (consider(e)) break;
            if (consider(fitted(e.loaded, alignToReference(main.spans, e.loaded.spans), 'main', e.banned))) break;
        }
        const found = best as { e: Evaluated; pair: number } | undefined;
        if (found) {
            trans = found.e;
            pair = round3(found.pair);
            if (found.pair < PAIR_TOGETHER) notes.push('lines_not_together');
            if (trans.alignedTo === 'main') notes.push('translation_fitted_to_main_line');
            if (trans.banned) notes.push('every_translation_was_reported');
        } else {
            trans = order[0];
            pair = round3(sameTimelineScore(main.spans, trans.spans));
            notes.push('translation_low_confidence');
        }
    } else {
        notes.push('no_translation_subtitles');
    }
    timings.align = Date.now() - tAlign;

    // 6. Merge on the shared timeline, a color per language.
    const colors = req.colors || {};
    const mainCues = retime(main.loaded.cues, main.spans);
    const transCues = trans ? retime(trans.loaded.cues, trans.spans) : null;
    const painted = (list: SubtitleCue[], color?: string) => list.map(c => ({ ...c, text: paint(c.text, color) }));
    const cues = transCues
        ? mergeSubtitlesByTime(mainCues, transCues, 500, { align: false, format: dualFormatter(colors) })
        : painted(mainCues, colors.main);
    const srt = formatSrt(cues);
    if (!srt) {
        notes.push('format_failed');
        return { srt: null, info: counted(baseInfo()) };
    }

    const info: BuildInfo = counted({
        ...baseInfo(),
        stage: 'final',
        tier: ref.kind,
        reference: ref.label,
        refBan: ref.ban,
        references: tried,
        main: pickInfo(main),
        trans: trans ? pickInfo(trans) : undefined,
        pair,
        evaluated: {
            main: chosen.mains.map(candidateInfo),
            trans: evTrans.map(candidateInfo)
        }
    });
    return {
        srt,
        mainSrt: formatSrt(painted(mainCues, colors.main)),
        transSrt: transCues ? formatSrt(painted(transCues, colors.trans)) : null,
        info
    };
}
