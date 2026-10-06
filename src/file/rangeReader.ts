// Reads byte ranges of a remote video file without downloading it.

import { safeFetch } from './safeFetch.js';

export class RangeError_ extends Error {
    constructor(public readonly reason: string) {
        super(reason);
    }
}

export interface RangeReaderOptions {
    headers?: Record<string, string>;
    /** Upper bound on bytes read through this reader, across all requests. */
    maxTotalBytes?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export class RangeReader {
    total = 0;
    /** Full file size, when a response revealed it (Content-Range). */
    size: number | null = null;
    private readonly headers: Record<string, string>;
    private readonly maxTotalBytes: number;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(public readonly url: string, options: RangeReaderOptions = {}) {
        this.headers = { ...(options.headers || {}) };
        this.maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
        this.timeoutMs = options.timeoutMs ?? 12_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    /** Bytes [start, start + length); fewer only at the end of the file. */
    async read(start: number, length: number): Promise<Uint8Array> {
        if (length <= 0) return new Uint8Array(0);
        if (this.total + length > this.maxTotalBytes) throw new RangeError_('too_large');
        // Stream links redirect (debrid CDNs); every hop must stay public.
        const res = await safeFetch(this.url, {
            headers: { ...this.headers, Range: `bytes=${start}-${start + length - 1}` },
            signal: AbortSignal.timeout(this.timeoutMs)
        }, this.fetchImpl);
        if (res.status === 200 && start > 0) {
            await res.body?.cancel().catch(() => undefined);
            throw new RangeError_('range_not_supported');
        }
        if (res.status !== 200 && res.status !== 206) {
            await res.body?.cancel().catch(() => undefined);
            throw new RangeError_(`http_${res.status}`);
        }
        const contentRange = res.headers.get('content-range');
        const sizeMatch = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
        if (sizeMatch) this.size = Number(sizeMatch[1]);
        else if (res.status === 200) {
            const len = Number(res.headers.get('content-length'));
            if (len > 0) this.size = len;
        }

        const out = new Uint8Array(length);
        let filled = 0;
        const reader = res.body?.getReader();
        if (!reader) return out.subarray(0, 0);
        try {
            while (filled < length) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                const take = Math.min(value.length, length - filled);
                out.set(value.subarray(0, take), filled);
                filled += take;
            }
        } finally {
            // A 200 for start=0 streams the whole file: stop after what we asked for.
            await reader.cancel().catch(() => undefined);
        }
        this.total += filled;
        return out.subarray(0, filled);
    }
}
