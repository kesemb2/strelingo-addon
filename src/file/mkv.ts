// Subtitle timings from a remote MKV, read with a few small Range requests.
// Ported from Smart-Hebrew-Subtitles (app/mkv.py).
//
// Syncing needs only *when* lines appear, not their text. In Matroska files
// muxed by mkvmerge (most WEB-DL releases) the Cues index holds an entry per
// subtitle frame — CueTime, and usually CueDuration — so the embedded
// subtitles' timings come out of the file header plus the Cues element,
// typically well under a megabyte, instead of the whole multi-GB file.
// Timings built this way belong to the exact file being played: the best
// possible sync reference.

import { RangeError_, RangeReader } from './rangeReader';
import type { Span } from '../sync/aligner';

const EBML = 0x1A45DFA3, DOCTYPE = 0x4282;
const SEGMENT = 0x18538067, CLUSTER = 0x1F43B675;
const SEEKHEAD = 0x114D9B74, SEEK = 0x4DBB, SEEK_ID = 0x53AB, SEEK_POS = 0x53AC;
const INFO = 0x1549A966, TIMESTAMP_SCALE = 0x2AD7B1;
const TRACKS = 0x1654AE6B, TRACK_ENTRY = 0xAE;
const TRACK_NUMBER = 0xD7, TRACK_TYPE = 0x83, CODEC_ID = 0x86;
const LANGUAGE = 0x22B59C, LANGUAGE_BCP47 = 0x22B59D, NAME = 0x536E, FLAG_FORCED = 0x55AA;
const CUES = 0x1C53BB6B, CUE_POINT = 0xBB, CUE_TIME = 0xB3, CUE_TRACK_POS = 0xB7;
const CUE_TRACK = 0xF7, CUE_DURATION = 0xB2;
const TRACK_TYPE_SUBTITLE = 0x11;

export const MKV_HEAD_BYTES = 256 * 1024;
const MIN_LINES = 30;
const DEFAULT_DURATION_MS = 2500;
const MAX_GAP_DURATION_MS = 4000;
const UNKNOWN_SIZE = -1;

class Fail extends Error {
    constructor(public readonly reason: string) {
        super(reason);
    }
}

function readId(buf: Uint8Array, pos: number): [number, number] {
    if (pos >= buf.length) throw new Fail('truncated');
    const first = buf[pos];
    let length = 1;
    let mask = 0x80;
    while (length <= 4 && !(first & mask)) {
        length++;
        mask >>= 1;
    }
    if (length > 4 || pos + length > buf.length) throw new Fail('truncated');
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + buf[pos + i];
    return [value, pos + length];
}

function readSize(buf: Uint8Array, pos: number): [number, number] {
    if (pos >= buf.length) throw new Fail('truncated');
    const first = buf[pos];
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) {
        length++;
        mask >>= 1;
    }
    if (length > 8 || pos + length > buf.length) throw new Fail('truncated');
    let value = first & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < length; i++) {
        value = value * 256 + buf[pos + i];
        if (buf[pos + i] !== 0xFF) allOnes = false;
    }
    return [allOnes ? UNKNOWN_SIZE : value, pos + length];
}

/** (id, dataStart, dataEnd) for each element in buf[start:end]; stops at truncation. */
function* children(buf: Uint8Array, start: number, end: number): Generator<[number, number, number]> {
    let pos = start;
    while (pos < end) {
        let id: number, p: number, size: number, data: number;
        try {
            [id, p] = readId(buf, pos);
            [size, data] = readSize(buf, p);
        } catch {
            return;
        }
        const dataEnd = size === UNKNOWN_SIZE ? end : data + size;
        yield [id, data, dataEnd];
        if (size === UNKNOWN_SIZE || dataEnd > buf.length) return;
        pos = dataEnd;
    }
}

function uint(buf: Uint8Array, start: number, end: number): number {
    let v = 0;
    for (let i = start; i < end && i < buf.length; i++) v = v * 256 + buf[i];
    return v;
}

function str(buf: Uint8Array, start: number, end: number): string {
    const slice = buf.subarray(start, Math.min(end, buf.length));
    const nul = slice.indexOf(0);
    return new TextDecoder().decode(nul >= 0 ? slice.subarray(0, nul) : slice);
}

export interface MkvTrack {
    number: number;
    lang: string;
    name: string;
    codec: string;
    forced: boolean;
}

function parseTracks(buf: Uint8Array, start: number, end: number): MkvTrack[] {
    const tracks: MkvTrack[] = [];
    for (const [id, s, e] of children(buf, start, end)) {
        if (id !== TRACK_ENTRY) continue;
        const t: MkvTrack = { number: 0, lang: 'eng', name: '', codec: '', forced: false };
        let type = 0;
        let bcp47 = '';
        for (const [cid, cs, ce] of children(buf, s, e)) {
            if (cid === TRACK_NUMBER) t.number = uint(buf, cs, ce);
            else if (cid === TRACK_TYPE) type = uint(buf, cs, ce);
            else if (cid === CODEC_ID) t.codec = str(buf, cs, ce);
            else if (cid === LANGUAGE) t.lang = str(buf, cs, ce) || 'eng';
            else if (cid === LANGUAGE_BCP47) bcp47 = str(buf, cs, ce);
            else if (cid === NAME) t.name = str(buf, cs, ce);
            else if (cid === FLAG_FORCED) t.forced = Boolean(uint(buf, cs, ce));
        }
        if (bcp47) t.lang = bcp47;
        if (type === TRACK_TYPE_SUBTITLE && t.number) tracks.push(t);
    }
    return tracks;
}

async function elementAt(reader: RangeReader, pos: number, want: number, chunk = 64 * 1024): Promise<[Uint8Array, number, number]> {
    let buf = await reader.read(pos, chunk);
    const [id, p] = readId(buf, 0);
    if (id !== want) throw new Fail('bad_seek');
    const [size, data] = readSize(buf, p);
    if (size === UNKNOWN_SIZE) throw new Fail('bad_seek');
    if (data + size > buf.length) {
        const more = await reader.read(pos + buf.length, data + size - buf.length);
        const joined = new Uint8Array(buf.length + more.length);
        joined.set(buf);
        joined.set(more, buf.length);
        buf = joined;
    }
    return [buf, data, data + size];
}

function isForced(t: MkvTrack): boolean {
    return t.forced || /forced/i.test(t.name);
}

function isSdh(t: MkvTrack): boolean {
    return /\bsdh\b|\bcc\b|hearing|malentendant/i.test(t.name);
}

export function toSpans(cues: Array<[number, number | null]>): Span[] {
    const sorted = [...cues].sort((a, b) => a[0] - b[0]);
    return sorted.map(([start, dur], i) => {
        let d = dur;
        if (!d) {
            const next = i + 1 < sorted.length ? sorted[i + 1][0] : start + DEFAULT_DURATION_MS;
            d = Math.max(300, Math.min(next - start, MAX_GAP_DURATION_MS));
        }
        return { start, end: start + d };
    });
}

export interface MkvTimings {
    ok: true;
    spans: Span[];
    track: MkvTrack & { count: number; withDurations: boolean };
    tracks: Array<MkvTrack & { count: number }>;
    bytesRead: number;
}

export type MkvResult = MkvTimings | { ok: false; reason: string };

/**
 * Timings of the best embedded subtitle track. `preferLangs` (ISO 639-2 or
 * BCP47 prefixes like "fre", "fr", "eng") breaks ties toward a language the
 * user is watching with; any full dialogue track works as a timing reference.
 */
export async function readMkvSubtitleTimings(
    reader: RangeReader,
    head: Uint8Array,
    preferLangs: string[] = []
): Promise<MkvResult> {
    try {
        return await read(reader, head, preferLangs);
    } catch (e: any) {
        if (e instanceof Fail || e instanceof RangeError_) return { ok: false, reason: e.reason };
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, reason: 'timeout' };
        return { ok: false, reason: 'error' };
    }
}

async function read(reader: RangeReader, head: Uint8Array, preferLangs: string[]): Promise<MkvResult> {
    if (head.length < 64) throw new Fail('empty');
    let [id, p] = readId(head, 0);
    if (id !== EBML) throw new Fail('not_matroska');
    let [size, data] = readSize(head, p);
    let doctype = '';
    for (const [cid, s, e] of children(head, data, data + size)) {
        if (cid === DOCTYPE) doctype = str(head, s, e);
    }
    if (doctype !== 'matroska' && doctype !== 'webm') throw new Fail('not_matroska');

    [id, p] = readId(head, data + size);
    if (id !== SEGMENT) throw new Fail('not_matroska');
    const [, segData] = readSize(head, p);

    const seeks = new Map<number, number>();
    let scale = 1_000_000;
    let tracks: MkvTrack[] | null = null;
    for (const [eid, s, e] of children(head, segData, head.length)) {
        if (eid === CLUSTER) break;
        if (e > head.length) continue;
        if (eid === SEEKHEAD) {
            for (const [sid, ss, se] of children(head, s, e)) {
                if (sid !== SEEK) continue;
                let target = 0;
                let position: number | null = null;
                for (const [fid, fs, fe] of children(head, ss, se)) {
                    if (fid === SEEK_ID) target = uint(head, fs, fe);
                    else if (fid === SEEK_POS) position = uint(head, fs, fe);
                }
                if (target && position !== null && !seeks.has(target)) seeks.set(target, segData + position);
            }
        } else if (eid === INFO) {
            for (const [iid, is, ie] of children(head, s, e)) {
                if (iid === TIMESTAMP_SCALE) scale = uint(head, is, ie) || scale;
            }
        } else if (eid === TRACKS) {
            tracks = parseTracks(head, s, e);
        }
    }

    if (tracks === null && seeks.has(TRACKS)) {
        const [buf, s, e] = await elementAt(reader, seeks.get(TRACKS)!, TRACKS);
        tracks = parseTracks(buf, s, e);
    }
    if (seeks.has(INFO) && scale === 1_000_000 && seeks.get(INFO)! >= head.length) {
        const [buf, s, e] = await elementAt(reader, seeks.get(INFO)!, INFO);
        for (const [iid, is, ie] of children(buf, s, e)) {
            if (iid === TIMESTAMP_SCALE) scale = uint(buf, is, ie) || scale;
        }
    }
    if (!tracks || tracks.length === 0) throw new Fail('no_subtitle_tracks');
    if (!seeks.has(CUES)) throw new Fail('no_cues');

    const [buf, s, e] = await elementAt(reader, seeks.get(CUES)!, CUES);
    const perTrack = new Map<number, Array<[number, number | null]>>();
    for (const t of tracks) perTrack.set(t.number, []);
    for (const [cid, cs, ce] of children(buf, s, e)) {
        if (cid !== CUE_POINT) continue;
        let time = 0;
        const positions: Array<[number, number | null]> = [];
        for (const [fid, fs, fe] of children(buf, cs, ce)) {
            if (fid === CUE_TIME) time = uint(buf, fs, fe);
            else if (fid === CUE_TRACK_POS) {
                let track = 0;
                let dur: number | null = null;
                for (const [gid, gs, ge] of children(buf, fs, fe)) {
                    if (gid === CUE_TRACK) track = uint(buf, gs, ge);
                    else if (gid === CUE_DURATION) dur = uint(buf, gs, ge);
                }
                positions.push([track, dur]);
            }
        }
        for (const [track, dur] of positions) {
            const list = perTrack.get(track);
            if (list) list.push([Math.floor(time * scale / 1e6), dur ? Math.floor(dur * scale / 1e6) : null]);
        }
    }

    const counted = tracks.map(t => ({ ...t, count: perTrack.get(t.number)?.length ?? 0 }));
    const prefer = preferLangs.map(l => l.toLowerCase()).filter(Boolean);
    const usable = counted.filter(t => t.count >= MIN_LINES && !isForced(t));
    if (usable.length === 0) {
        throw new Fail(counted.some(t => t.count > 0) ? 'too_few' : 'no_subtitle_cues');
    }
    const rank = (t: typeof counted[number]) => {
        const langMatch = prefer.some(l => t.lang.toLowerCase().startsWith(l.slice(0, 2)));
        return t.count * (isSdh(t) ? 0.85 : 1) * (langMatch ? 1.1 : 1);
    };
    const best = usable.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    const cues = perTrack.get(best.number)!;
    return {
        ok: true,
        spans: toSpans(cues),
        track: { ...best, withDurations: cues.every(([, d]) => Boolean(d)) },
        tracks: counted,
        bytesRead: reader.total
    };
}
