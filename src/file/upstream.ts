// The user's stream add-on (usually AIOStreams): find the exact file being
// played, and wrap its streams so a pick goes through this add-on.
// Matching ported from Smart-Hebrew-Subtitles (app/aiostreams.py).
//
// Stremio-style players tell subtitle add-ons the file's name and size at
// best — Nuvio's phone app tells them nothing. Both come from the stream's
// behaviorHints, and the stream add-on returns the same list the player
// chose from: the stream whose name and size match is the file being played.

import { hasEpisodeTag, isKnown, matchesEpisode, parseRelease, type Release } from './release.js';
import { isPublicHost, safeFetch } from './safeFetch.js';


const TIMEOUT_MS = 25_000;
const HIT_CACHE_MS = 30 * 60_000;
const MISS_CACHE_MS = 2 * 60_000;

export interface UpstreamStream {
    name?: string;
    title?: string;
    description?: string;
    url?: string;
    infoHash?: string;
    behaviorHints?: {
        filename?: string;
        videoSize?: number | string;
        bingeGroup?: string;
        proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

export interface PlayingFile {
    url: string;
    filename?: string;
    size?: number;
    headers?: Record<string, string>;
}

/** "stremio://host/…/manifest.json" or "https://…/manifest.json" → the add-on's base URL. */
export function addonBase(manifestUrl: string): string | null {
    let url = (manifestUrl || '').trim();
    if (!url) return null;
    if (url.startsWith('stremio://')) url = 'https://' + url.slice('stremio://'.length);
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
        // Anyone can craft a config: don't let it point the server at its own network.
        if (!isPublicHost(parsed.hostname)) return null;
    } catch {
        return null;
    }
    return url.split('?')[0].replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
}

const streamCache = new Map<string, { at: number; streams: Promise<UpstreamStream[]> }>();

export function fetchUpstreamStreams(manifestUrl: string, type: string, id: string, fetchImpl: typeof fetch = fetch): Promise<UpstreamStream[]> {
    const base = addonBase(manifestUrl);
    if (!base) return Promise.resolve([]);
    const key = `${base}|${type}|${id}`;
    const hit = streamCache.get(key);
    if (hit && Date.now() - hit.at < HIT_CACHE_MS) return hit.streams;
    const url = `${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id).replace(/%3A/gi, ':')}.json`;
    // Redirects are checked hop by hop: the add-on URL is user-supplied.
    const streams = safeFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }, fetchImpl)
        .then(async res => {
            if (!res.ok) throw new Error(`upstream ${res.status}`);
            const data: any = await res.json();
            return Array.isArray(data?.streams) ? data.streams as UpstreamStream[] : [];
        });
    const entry = { at: Date.now(), streams };
    streamCache.set(key, entry);
    streams.then(list => {
        if (list.length === 0) entry.at = Date.now() - HIT_CACHE_MS + MISS_CACHE_MS;
    }).catch(() => streamCache.delete(key));
    if (streamCache.size > 500) streamCache.delete(streamCache.keys().next().value!);
    return streams;
}

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|webm|mov|wmv)$/i;

export function normName(name: string | undefined): string {
    const base = (name || '').replace(/\\/g, '/').split('/').pop()!.trim();
    return base.replace(VIDEO_EXT, '').toLowerCase().replace(/[\s._\-[\]()]+/g, ' ').trim();
}

function sizeOf(value: unknown): number {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// An exact size (in bytes, near-unique) outweighs an identical name plus
// release details: the same name can come with another size.
const S_SIZE = 150, S_SIZE_NEAR = 40, S_NAME = 90, S_NAME_PART = 50;
const S_GROUP = 10, S_SERVICE = 10, S_RESOLUTION = 5;
const ACCEPT_SURE = 90, ACCEPT_LEAD_MIN = 50, ACCEPT_LEAD = 20;

function scoreStream(stream: UpstreamStream, wantName: string, wantRel: Release, videoSize: number,
    season: number, episode: number): number | null {
    const hints = stream.behaviorHints || {};
    const name = hints.filename || '';
    if (episode && name && hasEpisodeTag(name) && !matchesEpisode(name, season, episode)) return null;
    let pts = 0;
    const size = sizeOf(hints.videoSize);
    if (videoSize && size) {
        if (size === videoSize) pts += S_SIZE;
        else if (Math.abs(size - videoSize) <= videoSize * 0.005) pts += S_SIZE_NEAR;
    }
    const got = normName(name);
    if (wantName && got) {
        if (got === wantName) pts += S_NAME;
        else if (wantName.includes(got) || got.includes(wantName)) pts += S_NAME_PART;
    }
    if (name && isKnown(wantRel)) {
        const rel = parseRelease(name);
        if (wantRel.group && rel.group === wantRel.group) pts += S_GROUP;
        if (wantRel.service && rel.service === wantRel.service) pts += S_SERVICE;
        if (wantRel.resolution && rel.resolution === wantRel.resolution) pts += S_RESOLUTION;
    }
    return pts;
}

/** The stream of the file being played, or null when the evidence is not strong enough. */
export function matchStream(streams: UpstreamStream[], filename: string | undefined, videoSize: number | undefined,
    season = 0, episode = 0): UpstreamStream | null {
    if (!filename && !videoSize) return null;
    const wantName = normName(filename);
    const wantRel = parseRelease(filename || '');
    const scored: Array<[number, UpstreamStream]> = [];
    for (const s of streams) {
        if (!s || typeof s !== 'object' || !s.url) continue;
        const pts = scoreStream(s, wantName, wantRel, Number(videoSize || 0), season, episode);
        if (pts !== null) scored.push([pts, s]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    if (scored.length === 0) return null;
    const best = scored[0][0];
    const second = scored.length > 1 ? scored[1][0] : 0;
    if (best >= ACCEPT_SURE || (best >= ACCEPT_LEAD_MIN && best - second >= ACCEPT_LEAD)) return scored[0][1];
    return null;
}

export function playingFileOf(stream: UpstreamStream): PlayingFile | null {
    if (!stream.url) return null;
    const hints = stream.behaviorHints || {};
    return {
        url: stream.url,
        filename: hints.filename || undefined,
        size: sizeOf(hints.videoSize) || undefined,
        headers: hints.proxyHeaders?.request ? { ...hints.proxyHeaders.request } : undefined
    };
}
