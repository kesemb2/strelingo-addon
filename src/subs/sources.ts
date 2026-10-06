// Where candidate subtitles come from, and how one is downloaded into cues.
// Sources and decoding are the original Strelingo ones: OpenSubtitles through
// Stremio's own OpenSubtitles v3 add-on (no key needed), Buta-no-subs for
// Japanese, and the optional key-based providers (Wyzie, SubSource).

import { Buffer } from 'node:buffer';
import { unzipSync } from 'fflate';

import { decodeSubtitleBuffer, getLanguageAliases } from '../encoding.js';
import {
    fetchOptionalProviderSubtitles,
    hasAnyOptionalProvider,
    resolveRequestedLangs,
    type OptionalProviderConfig
} from '../providers.js';
import { languageName } from '../languages.js';
import type { SubtitleCue } from '../subtitleMatching.js';
import type { Span } from '../sync/aligner.js';
import { parseSrtTimeToMs } from '../subtitleMatching.js';
import { SubtitleConverter, parseSrt } from './formats.js';
import { safeFetch } from '../file/safeFetch.js';

export interface Candidate {
    id: string;
    url: string;
    lang: string;
    format: string;
    source: string;
    /** Rank within its language, in the order the sources returned it. */
    rank: number;
    /** OpenSubtitles says it was uploaded for this file's hash. */
    hashMatch: boolean;
    releaseName?: string;
    apiKey?: string;
    season?: string;
    episode?: string;
}

export interface LoadedSubtitle {
    candidate: Candidate;
    cues: SubtitleCue[];
    spans: Span[];
}

export interface VideoQuery {
    type: string;
    /** "tt1234567" */
    imdbId: string;
    season?: string;
    episode?: string;
    butaId?: string;
    filename?: string;
    videoSize?: number;
    videoHash?: string;
}

const OPENSUBTITLES_V3 = 'https://opensubtitles-v3.strem.io/subtitles';
const BUTA_NO_SUBS = 'https://buta-no-subs-stremio-addon.onrender.com/subtitles';

async function fetchOpenSubtitles(q: VideoQuery, fetchImpl: typeof fetch): Promise<any[]> {
    let url = `${OPENSUBTITLES_V3}/${q.type}/${q.imdbId}`;
    if (q.type === 'series' && q.season && q.episode) url += `:${q.season}:${q.episode}`;
    // The file's name, size and hash let OpenSubtitles put subtitles made for
    // this exact release first.
    const extra: string[] = [];
    if (q.filename) extra.push(`filename=${encodeURIComponent(q.filename)}`);
    if (q.videoSize) extra.push(`videoSize=${q.videoSize}`);
    if (q.videoHash) extra.push(`videoHash=${q.videoHash}`);
    if (extra.length) url += `/${extra.join('&')}`;
    url += '.json';
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`OpenSubtitles v3 responded ${res.status}`);
    const data: any = await res.json();
    return Array.isArray(data?.subtitles) ? data.subtitles : [];
}

async function fetchButaNoSubs(q: VideoQuery, fetchImpl: typeof fetch): Promise<any[]> {
    const id = q.butaId || `${q.imdbId}${q.season ? `:${q.season}:${q.episode}` : ''}`;
    try {
        const res = await fetchImpl(`${BUTA_NO_SUBS}/${q.type}/${id}.json`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return [];
        const data: any = await res.json();
        return Array.isArray(data?.subtitles)
            ? data.subtitles.map((s: any) => ({ ...s, lang: s.lang || 'jpn', source: 'buta-no-subs' }))
            : [];
    } catch {
        return [];
    }
}

function toCandidates(raw: any[], languageId: string): Candidate[] {
    const codes = getLanguageAliases(languageId);
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const sub of raw) {
        if (!sub?.url || !codes.includes(sub.lang) || seen.has(sub.url)) continue;
        seen.add(sub.url);
        out.push({
            id: String(sub.id ?? sub.url),
            url: sub.url,
            lang: sub.lang,
            format: sub.format || 'srt',
            source: sub.provider || sub.source || 'opensubtitles',
            rank: 0,
            // Stremio's OpenSubtitles add-on marks how each result matched:
            // "h" = by the file's hash (timed for this very file), "i" = by IMDb id.
            hashMatch: sub.m === 'h',
            releaseName: sub.releaseName,
            apiKey: sub.apiKey,
            season: sub.season,
            episode: sub.episode
        });
    }
    // Hash matches first; otherwise keep the source's own order.
    out.sort((a, b) => Number(b.hashMatch) - Number(a.hashMatch));
    out.forEach((c, i) => { c.rank = i; });
    return out;
}

export interface CandidateLists {
    main: Candidate[];
    trans: Candidate[];
    counts: Record<string, number>;
}

export async function listCandidates(
    q: VideoQuery,
    mainLang: string,
    transLang: string,
    optional: OptionalProviderConfig,
    fetchImpl: typeof fetch = fetch
): Promise<CandidateLists> {
    const needsJapanese = mainLang === 'jpn' || transLang === 'jpn';
    const [os, buta] = await Promise.all([
        fetchOpenSubtitles(q, fetchImpl).catch(e => {
            console.warn(`[sources] OpenSubtitles failed: ${e.message}`);
            return [] as any[];
        }),
        needsJapanese ? fetchButaNoSubs(q, fetchImpl) : Promise.resolve([] as any[])
    ]);
    let all = [...os, ...buta];
    const counts: Record<string, number> = { opensubtitles: os.length, buta: buta.length };

    const imdbNumeric = q.imdbId;
    const providerSubs = async (langs: string[]) => {
        if (!hasAnyOptionalProvider(optional) || langs.length === 0) return [];
        const resolved = await resolveRequestedLangs([...new Set(langs)], languageName);
        return fetchOptionalProviderSubtitles(
            { imdbId: imdbNumeric, type: q.type, season: q.season, episode: q.episode, langs: resolved },
            optional
        );
    };

    if (optional.mode === 'parallel') {
        const extra = await providerSubs([mainLang, transLang]);
        counts.optional = extra.length;
        all = all.concat(extra);
    }
    let main = toCandidates(all, mainLang);
    let trans = toCandidates(all, transLang);
    if (optional.mode === 'fallback') {
        const missing = [main.length === 0 ? mainLang : '', trans.length === 0 ? transLang : ''].filter(Boolean);
        if (missing.length) {
            const extra = await providerSubs(missing);
            counts.optional = extra.length;
            all = all.concat(extra);
            main = toCandidates(all, mainLang);
            trans = toCandidates(all, transLang);
        }
    }
    return { main, trans, counts };
}

const SUBTITLE_EXT_PRIORITY = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'sbv', 'smi', 'lrc', 'ttml', 'dfxp'];

function isZipBuffer(buffer: Buffer): boolean {
    // ZIP local-file / central-dir / end-of-central-dir magic: 'PK' + (03 04 | 05 06 | 07 08)
    return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B
        && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
        && (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);
}

function pickZipSubtitleEntry(names: string[], season?: string, episode?: string): string | null {
    const subs = names.filter(n => {
        const ext = n.split('.').pop()?.toLowerCase();
        return ext ? SUBTITLE_EXT_PRIORITY.includes(ext) : false;
    });
    if (subs.length === 0) return null;

    // A single-file archive has nothing to disambiguate — the episode match
    // (if any was required) already happened before download, using the
    // provider's own listing metadata (see SubSource's commentary/releaseInfo
    // filtering in providers.ts). The filename itself is often just a release
    // title with no "SxxExx" in it, so don't reject a lone file for failing a
    // pattern match against its name.
    if (subs.length === 1) return subs[0];

    if (season && episode) {
        const s = parseInt(season, 10);
        const ep = parseInt(episode, 10);
        const patterns = [
            new RegExp(`s0*${s}\\s*[._ -]?\\s*e0*${ep}(?!\\d)`, 'i'),
            new RegExp(`(?:^|[^0-9])0*${s}\\s*x\\s*0*${ep}(?!\\d)`, 'i'),
            new RegExp(`\\bepisode\\W{0,3}0*${ep}(?!\\d)`, 'i'),
            new RegExp(`\\bep\\W{0,3}0*${ep}(?!\\d)`, 'i'),
            new RegExp(`\\be0*${ep}(?!\\d)`, 'i'),
            // Last resort: bare episode number immediately before the extension
            // (e.g. season-pack entries named "05.srt", "Show - 5.srt").
            new RegExp(`(?:^|[^0-9])0*${ep}\\.[a-z0-9]{2,4}$`, 'i')
        ];
        for (const re of patterns) {
            const hit = subs.find(n => re.test(n));
            if (hit) return hit;
        }
        // This archive is a season pack (or similar) that doesn't contain the
        // requested episode — don't guess a wrong episode's file. Returning null
        // lets the caller fall back to the next subtitle candidate instead of
        // silently serving mismatched content.
        return null;
    }

    // No episode filter requested (movies, or providers that don't zip season
    // packs): prefer the highest-priority extension, then the shortest name.
    subs.sort((a, b) => {
        const ea = SUBTITLE_EXT_PRIORITY.indexOf(a.split('.').pop()!.toLowerCase());
        const eb = SUBTITLE_EXT_PRIORITY.indexOf(b.split('.').pop()!.toLowerCase());
        if (ea !== eb) return ea - eb;
        return a.length - b.length;
    });
    return subs[0];
}

// Extract a single subtitle file (and its format) from a zip archive. Used for
// providers that deliver zipped subtitles (SubSource).
function extractSubtitleFromZip(buffer: Buffer, season?: string, episode?: string): { buffer: Buffer; format: string } | null {
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(new Uint8Array(buffer));
    } catch (e: any) {
        console.warn('[zip] unzip failed:', e.message);
        return null;
    }
    const names = Object.keys(entries).filter(name => !name.endsWith('/'));
    const chosen = pickZipSubtitleEntry(names, season, episode);
    if (!chosen) {
        console.warn(season && episode
            ? `[zip] no entry for S${season}E${episode} in archive (${names.length} files)`
            : '[zip] no subtitle file in archive');
        return null;
    }
    console.log(`[zip] picked "${chosen}" of ${names.length}`);
    const ext = chosen.split('.').pop()?.toLowerCase() || 'srt';
    return { buffer: Buffer.from(entries[chosen]), format: ext };
}

export function isSafeSubtitleUrl(urlString: string): boolean {
    if (!urlString || urlString.length > 2048) return false;

    let parsed: URL;
    try {
        parsed = new URL(urlString);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;

    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (isBlockedIpv4Host(host) || isBlockedIpv6Host(host)) return false;

    return true;
}

function isBlockedIpv4Host(host: string): boolean {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!match) return false;

    const parts = match.slice(1).map(Number);
    if (parts.some(part => part < 0 || part > 255)) return true;

    const [a, b] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || a >= 224;
}

function isBlockedIpv6Host(host: string): boolean {
    if (!host.includes(':')) return false;
    const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
    return normalized === '::'
        || normalized === '::1'
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || normalized.startsWith('fe80:')
        || normalized.startsWith('0:');
}

async function fetchSubtitleText(c: Candidate, fetchImpl: typeof fetch): Promise<string | null> {
    if (!isSafeSubtitleUrl(c.url)) return null;
    const headers: Record<string, string> = {};
    if (c.apiKey) headers['X-API-Key'] = c.apiKey;
    const res = await safeFetch(c.url, { headers, signal: AbortSignal.timeout(15_000) }, fetchImpl);
    if (!res.ok) throw new Error(`download responded ${res.status}`);
    let buffer: Buffer = Buffer.from(await res.arrayBuffer());
    let format = c.format || 'srt';
    if (isZipBuffer(buffer)) {
        const extracted = extractSubtitleFromZip(buffer, c.season, c.episode);
        if (!extracted) return null;
        buffer = extracted.buffer;
        format = extracted.format;
    }
    // Decodes legacy encodings and rejects files that aren't in the expected language.
    let text = await decodeSubtitleBuffer(buffer, c.lang);
    if (!text) return null;
    if (format.toLowerCase() !== 'srt') text = SubtitleConverter.convert(text, format) || text;
    return text;
}

const loadCache = new Map<string, { at: number; value: Promise<LoadedSubtitle | null> }>();
const LOAD_TTL_MS = 6 * 3600_000;

/** Downloads, decodes and parses one candidate (cached by URL). Never throws. */
export function loadSubtitle(c: Candidate, fetchImpl: typeof fetch = fetch): Promise<LoadedSubtitle | null> {
    const key = `${c.url}\u0000${c.lang}\u0000${c.season || ''}:${c.episode || ''}`;
    const hit = loadCache.get(key);
    if (hit && Date.now() - hit.at < LOAD_TTL_MS) {
        return hit.value.then(v => (v ? { ...v, candidate: c } : null));
    }
    const value = (async () => {
        try {
            const text = await fetchSubtitleText(c, fetchImpl);
            const cues = text ? parseSrt(text) : null;
            if (!cues || cues.length < 5) return null;
            const timed: Array<{ cue: SubtitleCue; span: Span }> = [];
            for (const cue of cues) {
                const start = parseSrtTimeToMs(cue.startTime);
                const end = parseSrtTimeToMs(cue.endTime);
                if (start === null || end === null || end <= start) continue;
                timed.push({ cue, span: { start, end } });
            }
            // Some uploads list lines out of order; the aligner reads them in time order.
            timed.sort((a, b) => a.span.start - b.span.start);
            return timed.length >= 5
                ? { candidate: c, cues: timed.map(t => t.cue), spans: timed.map(t => t.span) }
                : null;
        } catch (e: any) {
            console.warn(`[sources] ${c.source} ${c.id} failed: ${e.message}`);
            return null;
        }
    })();
    loadCache.set(key, { at: Date.now(), value });
    if (loadCache.size > 400) loadCache.delete(loadCache.keys().next().value!);
    value.then(v => { if (!v) loadCache.delete(key); });
    return value;
}
