// A fake world for pipeline/server tests: one movie with a known speech
// timeline, its file (an MKV with embedded subtitle timings), the user's
// stream add-on, and OpenSubtitles results in French and English made for
// different releases.

import { buildMkv } from './fakeFiles.js';
import { deriveSubtitle, speechTrack, type TrueSpan } from './synthetic.js';

const FRENCH = [
    'Je ne sais pas ce que tu veux dire par là.',
    'Il faut que nous partions maintenant, avant la nuit.',
    'Tu as vu ce qui est arrivé hier soir chez elle ?',
    "C'est la dernière fois que je te le demande.",
    'Nous avons attendu pendant des heures à la gare.',
    'Pourquoi est-ce que personne ne me dit la vérité ?',
    'Elle était déjà partie quand je suis arrivé.',
    'On pourrait aller manger quelque chose ensemble.',
    "Je crois qu'il est temps de rentrer à la maison.",
    'Ce n’est pas grave, ça arrive à tout le monde.'
];

const ENGLISH = [
    "I don't know what you mean by that.",
    'We have to leave now, before it gets dark.',
    'Did you see what happened at her place last night?',
    "This is the last time I'm asking you.",
    'We waited for hours at the station.',
    'Why is nobody telling me the truth?',
    'She had already left when I arrived.',
    'We could go and get something to eat together.',
    "I think it's time to go back home.",
    "It's fine, it happens to everyone."
];

function srtTime(ms: number): string {
    const v = Math.max(0, Math.round(ms));
    const p = (n: number, w: number) => String(n).padStart(w, '0');
    return `${p(Math.floor(v / 3600000), 2)}:${p(Math.floor(v / 60000) % 60, 2)}:${p(Math.floor(v / 1000) % 60, 2)},${p(v % 1000, 3)}`;
}

export function toSrt(spans: TrueSpan[], lang: 'fr' | 'en'): string {
    const lines = lang === 'fr' ? FRENCH : ENGLISH;
    return spans.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${lines[(s.source < 0 ? i : s.source) % lines.length]}\n`).join('\n');
}

export const PAL = 23.976 / 25;
export const IMDB = 'tt0000001';
export const STREAM_ADDON = 'https://aio.example/cfg123/manifest.json';
export const FILENAME = 'Le.Film.2021.FRENCH.1080p.WEB-DL-GRP.mkv';
// Every world gets its own URLs: the add-on caches downloads and file probes by URL.
let worldCount = 0;

export interface World {
    fileUrl: string;
    speech: TrueSpan[];
    fetch: typeof fetch;
    log: string[];
    mkv: Uint8Array;
}

export interface WorldOptions {
    /** OpenSubtitles entries, in the order the service returns them. */
    subtitles?: Array<{ id: string; lang: 'fre' | 'eng'; spans: TrueSpan[]; m?: string }>;
    embedded?: boolean;
}

export function makeWorld(build: (speech: TrueSpan[]) => WorldOptions): World {
    const speech = speechTrack(42, 100 * 60_000);
    const opts = build(speech);
    const n = ++worldCount;
    const fileUrl = `https://debrid.example/w${n}/${FILENAME}`;
    const embedded = deriveSubtitle(speech, { seed: 900, jitterMs: 60, dropShare: 0.05 });
    const mkv = buildMkv(opts.embedded === false
        ? []
        : [{ number: 2, lang: 'fre', cues: embedded.map(s => [s.start, s.end - s.start] as [number, number]) }], 300_000);

    const subs = opts.subtitles || [];
    const files = new Map<string, string>();
    const listing = subs.map(s => {
        const url = `https://subs.example/w${n}/${s.id}.srt`;
        files.set(url, toSrt(s.spans, s.lang === 'fre' ? 'fr' : 'en'));
        return { id: s.id, url, lang: s.lang, ...(s.m ? { m: s.m } : {}) };
    });

    const log: string[] = [];
    const impl = (async (input: any, init?: any) => {
        const url: string = typeof input === 'string' ? input : input.url;
        log.push(url);
        if (url.startsWith(`https://opensubtitles-v3.strem.io/subtitles/movie/${IMDB}`)) {
            return Response.json({ subtitles: listing });
        }
        if (files.has(url)) return new Response(files.get(url)!, { status: 200 });
        if (url === `https://aio.example/cfg123/stream/movie/${IMDB}.json`) {
            return Response.json({
                streams: [
                    { name: 'AIO 2160p', url: 'https://debrid.example/dl/other-2160p.mkv', behaviorHints: { filename: 'Le.Film.2021.2160p.BluRay-XYZ.mkv', videoSize: 40_000_000_000 } },
                    { name: 'AIO 1080p', url: fileUrl, behaviorHints: { filename: FILENAME, videoSize: mkv.length, bingeGroup: 'aio-1080' } },
                    { name: 'AIO torrent', infoHash: 'abc' }
                ]
            });
        }
        if (url === fileUrl) {
            const range = new Headers(init?.headers).get('range');
            const m = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
            if (!m) return new Response(mkv as unknown as BodyInit, { status: 200 });
            const start = Number(m[1]);
            const end = Math.min(Number(m[2]), mkv.length - 1);
            return new Response(mkv.slice(start, end + 1) as unknown as BodyInit, {
                status: 206, headers: { 'content-range': `bytes ${start}-${end}/${mkv.length}` }
            });
        }
        return new Response('not found', { status: 404 });
    }) as typeof fetch;

    return { fileUrl, speech, fetch: impl, log, mkv };
}

/**
 * Share of output cues whose start falls on the true start of a speech span,
 * or on its middle (where a release that splits long lines starts the second
 * half), ±toleranceMs.
 */
export function srtAccuracy(srt: string, speech: TrueSpan[], toleranceMs = 300): number {
    const starts = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)]
        .map(m => ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4]);
    if (starts.length === 0) return 0;
    const truth = speech.flatMap(s => [s.start, (s.start + s.end) / 2]).sort((a, b) => a - b);
    let good = 0;
    for (const s of starts) {
        let lo = 0, hi = truth.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (truth[mid] < s) lo = mid + 1; else hi = mid;
        }
        const near = Math.min(Math.abs(truth[lo] - s), lo > 0 ? Math.abs(truth[lo - 1] - s) : Infinity);
        if (near <= toleranceMs) good++;
    }
    return good / starts.length;
}

export function srtSpans(srt: string): Array<{ start: number; end: number }> {
    const t = (h: string, m: string, s: string, ms: string) => ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
    return [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)]
        .map(m => ({ start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]) }));
}
