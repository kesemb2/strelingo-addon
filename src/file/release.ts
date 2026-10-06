// What a release name says about subtitle timing, and how alike two are.
// Ported from Smart-Hebrew-Subtitles (app/release.py).
//
// Two releases share subtitle timing when they were ripped from the same
// source, not when they have the same resolution: a 2160p and a 1080p
// Netflix WEB-DL are the same stream re-encoded, while a Netflix and an
// Amazon WEB-DL of the same episode can differ in intros, logos and
// ad-break cuts. So the score weighs, highest first: source, streaming
// service, edition, release group, and resolution only as a tie-break.

export interface Release {
    source: string;
    service: string;
    resolution: string;
    group: string;
    edition: Set<string>;
}

const W_SOURCE = 8;
const W_SERVICE = 6;
const W_SERVICE_CLASH = -4;
const W_EDITION = 3;
const W_EDITION_CLASH = -3;
const W_GROUP = 2;
const W_RESOLUTION = 1;

// Streaming-service tags as scene releases write them → one canonical name.
// Matched case-sensitively as whole tokens, and only after the title, so
// words like "Now" or "Max" in a title don't count.
const SERVICES: Record<string, string> = {
    NF: 'NF', AMZN: 'AMZN', DSNP: 'DSNP', DSNY: 'DSNP', ATVP: 'ATVP',
    HMAX: 'MAX', MAX: 'MAX', HBO: 'MAX', HULU: 'HULU', PCOK: 'PCOK',
    PMTP: 'PMTP', iT: 'iT', CR: 'CR', STAN: 'STAN', CRAV: 'CRAV',
    DSCP: 'DSCP', ROKU: 'ROKU', SHO: 'SHO', NOW: 'NOW', SKST: 'SKST',
    MUBI: 'MUBI', VIAP: 'VIAP', TVING: 'TVING', KNPY: 'KNPY', FOD: 'FOD',
    APPS: 'APPS', BCORE: 'BCORE', RED: 'RED', YT: 'YT',
    // French platforms (French films are often WEB-DLs from these).
    CANAL: 'CANAL', MYCANAL: 'CANAL', ARTE: 'ARTE', FTV: 'FTV', ADN: 'ADN', MOLO: 'MOLO'
};

const EDITIONS: Array<[string, string]> = [
    ['extended', 'extended'], ["director's cut", 'directors'], ['directors cut', 'directors'],
    ['dc', 'directors'], ['unrated', 'unrated'], ['uncut', 'uncut'], ['theatrical', 'theatrical'],
    ['imax', 'imax'], ['remastered', 'remastered'], ['final cut', 'final']
];

const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu;
const TITLE_END = /[.\s_-]((?:19|20)\d{2}|[Ss]\d{1,2}[Ee]\d{1,3}|\d{1,2}x\d{2})(?=[.\s_-]|$)/;

export function emptyRelease(): Release {
    return { source: '', service: '', resolution: '', group: '', edition: new Set() };
}

export function isKnown(r: Release): boolean {
    return Boolean(r.source || r.service || r.resolution);
}

function tail(name: string): string {
    const m = TITLE_END.exec(name);
    return m ? name.slice(m.index) : name;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseRelease(rawName: string | undefined | null): Release {
    if (!rawName) return emptyRelease();
    let name = rawName.trim().replace(/\s*\[[^\]]*\]\s*$/, '');
    name = name.replace(/\.(mkv|mp4|avi|srt|m4v|ts|webm)$/i, '');
    const t = tail(name);
    const low = t.toLowerCase();

    let source = '';
    if (/blu-?ray|bdrip|brrip|bdremux|remux|\bbd\b/.test(low)) source = 'bluray';
    else if (/web-?dl|webrip|\bweb\b/.test(low)) source = 'web';
    else if (low.includes('hdtv')) source = 'hdtv';
    else if (/dvdrip|\bdvd\b/.test(low)) source = 'dvd';

    const tokens = t.match(TOKEN) || [];
    const serviceToken = tokens.find(tok => Object.prototype.hasOwnProperty.call(SERVICES, tok));
    const service = serviceToken ? SERVICES[serviceToken] : '';
    if (service && !source) source = 'web';

    let resolution = '';
    for (const [token, norm] of [['2160p', '2160p'], ['4k', '2160p'], ['uhd', '2160p'], ['1080p', '1080p'],
        ['1080i', '1080p'], ['720p', '720p'], ['576p', '576p'], ['480p', '480p']]) {
        if (new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`).test(low)) {
            resolution = norm;
            break;
        }
    }

    let group = '';
    const gm = /-([A-Za-z0-9]+)$/.exec(name);
    if (gm && !/^(\d{3,4}p|x26[45]|h\.?26[45]|hevc)$/i.test(gm[1])) group = gm[1].toLowerCase();

    const spaced = low.replace(/[._]/g, ' ');
    const edition = new Set<string>();
    for (const [key, value] of EDITIONS) {
        if (new RegExp(`(?<![a-z])${escapeRe(key)}(?![a-z])`).test(spaced)) edition.add(value);
    }

    return { source, service, resolution, group, edition };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

export function releaseScore(video: Release, cand: Release): number {
    let pts = 0;
    if (video.source && video.source === cand.source) pts += W_SOURCE;
    if (video.service && cand.service) pts += video.service === cand.service ? W_SERVICE : W_SERVICE_CLASH;
    if (video.edition.size || cand.edition.size) pts += sameSet(video.edition, cand.edition) ? W_EDITION : W_EDITION_CLASH;
    if (video.group && video.group === cand.group) pts += W_GROUP;
    if (video.resolution && video.resolution === cand.resolution) pts += W_RESOLUTION;
    return pts;
}

/**
 * Whether a release name is for this episode. Understands S02E05, s02.e05,
 * S02 E05, 2x05 and multi-episode files (S02E04E05). A name without any
 * episode tag doesn't match.
 */
export function matchesEpisode(name: string, season: number, episode: number): boolean {
    if (!episode) return true;
    const n = name.toLowerCase();
    const e = `e0*${episode}(?!\\d)`;
    if (season) {
        const s = `(?<![a-z0-9])s0*${season}`;
        return new RegExp(`${s}(?:[ ._-]*e\\d{1,3})*[ ._-]*${e}`).test(n)
            || new RegExp(`(?<!\\d)0*${season}x0*${episode}(?!\\d)`).test(n);
    }
    return new RegExp(`(?:(?<![a-z0-9])|(?<=\\d))${e}`).test(n);
}

export function hasEpisodeTag(name: string): boolean {
    return /s\d{1,2}[ ._-]*e\d{1,3}|\d{1,2}x\d{2}/i.test(name);
}
