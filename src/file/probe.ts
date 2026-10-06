// Everything the add-on can learn about the playing file from its URL: the
// OpenSubtitles hash (subtitles timed for exactly this file) and the timings
// of its embedded subtitles (the video's own timeline). A few hundred KB of
// Range requests, never the whole file.

import { MKV_HEAD_BYTES, readMkvSubtitleTimings, type MkvResult } from './mkv';
import { hashFromChunks } from './osHash';
import { RangeReader } from './rangeReader';
import { isPublicHost } from './upstream';

export interface ProbeResult {
    hash?: string;
    size?: number;
    mkv: MkvResult;
    bytesRead: number;
    ms: number;
}

const CACHE_TTL_MS = 6 * 3600_000;
const cache = new Map<string, { at: number; result: Promise<ProbeResult> }>();

export function probeFile(
    url: string,
    options: { headers?: Record<string, string>; size?: number; preferLangs?: string[]; fetchImpl?: typeof fetch } = {}
): Promise<ProbeResult> {
    const key = `${url}\u0000${options.size || ''}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
    const result = run(url, options).catch(() => ({ mkv: { ok: false as const, reason: 'error' }, bytesRead: 0, ms: 0 }));
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    return result;
}

async function run(
    url: string,
    options: { headers?: Record<string, string>; size?: number; preferLangs?: string[]; fetchImpl?: typeof fetch }
): Promise<ProbeResult> {
    const t0 = Date.now();
    let host = '';
    try { host = new URL(url).hostname; } catch { /* invalid */ }
    if (!isPublicHost(host)) return { mkv: { ok: false, reason: 'private_address' }, bytesRead: 0, ms: 0 };
    const reader = new RangeReader(url, { headers: options.headers, fetchImpl: options.fetchImpl });
    let head: Uint8Array;
    try {
        head = await reader.read(0, MKV_HEAD_BYTES);
    } catch (e: any) {
        return { mkv: { ok: false, reason: e?.reason || 'unreachable' }, bytesRead: reader.total, ms: Date.now() - t0 };
    }

    const size = options.size || reader.size || undefined;
    const hashPromise = (async () => {
        if (!size || size < 2 * 65536 || head.length < 65536) return undefined;
        try {
            const tail = await reader.read(size - 65536, 65536);
            return tail.length === 65536 ? hashFromChunks(size, head.subarray(0, 65536), tail) : undefined;
        } catch {
            return undefined;
        }
    })();
    const [hash, mkv] = await Promise.all([hashPromise, readMkvSubtitleTimings(reader, head, options.preferLangs)]);
    return { hash, size, mkv, bytesRead: reader.total, ms: Date.now() - t0 };
}
