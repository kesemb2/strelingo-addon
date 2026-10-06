// Builders for test fixtures: a minimal Matroska file with subtitle tracks and
// a Cues index, and a fetch() that serves byte ranges of in-memory files.

function encodeId(id: number): number[] {
    const bytes: number[] = [];
    let v = id;
    while (v > 0) {
        bytes.unshift(v & 0xFF);
        v = Math.floor(v / 256);
    }
    return bytes;
}

function encodeSize(size: number): number[] {
    // Always 8 bytes: simple and valid.
    const out = [0x01];
    for (let i = 6; i >= 0; i--) out.push(Math.floor(size / 2 ** (8 * i)) & 0xFF);
    return out;
}

export function el(id: number, payload: number[] | Uint8Array): number[] {
    const data = Array.from(payload);
    return [...encodeId(id), ...encodeSize(data.length), ...data];
}

export function uintBytes(v: number, width = 4): number[] {
    const out: number[] = [];
    for (let i = width - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** (8 * i)) & 0xFF);
    return out;
}

const strBytes = (s: string) => Array.from(new TextEncoder().encode(s));

export interface FakeTrack {
    number: number;
    lang: string;
    name?: string;
    forced?: boolean;
    /** [startMs, durationMs | null] */
    cues: Array<[number, number | null]>;
}

/** A Matroska file: EBML header, Segment with SeekHead, Info, Tracks, a Cluster, padding, Cues. */
export function buildMkv(tracks: FakeTrack[], paddingBytes = 400_000): Uint8Array {
    const ebml = el(0x1A45DFA3, [...el(0x4282, strBytes('matroska'))]);

    const info = el(0x1549A966, el(0x2AD7B1, uintBytes(1_000_000)));
    const trackEntries = tracks.flatMap(t => el(0xAE, [
        ...el(0xD7, uintBytes(t.number, 1)),
        ...el(0x83, uintBytes(0x11, 1)),
        ...el(0x86, strBytes('S_TEXT/UTF8')),
        ...el(0x22B59C, strBytes(t.lang)),
        ...(t.name ? el(0x536E, strBytes(t.name)) : []),
        ...(t.forced ? el(0x55AA, uintBytes(1, 1)) : [])
    ]));
    const videoTrack = el(0xAE, [...el(0xD7, uintBytes(1, 1)), ...el(0x83, uintBytes(1, 1)), ...el(0x86, strBytes('V_MPEG4/ISO/AVC'))]);
    const tracksEl = el(0x1654AE6B, [...videoTrack, ...trackEntries]);
    const cluster = el(0x1F43B675, new Uint8Array(paddingBytes));

    const points: Array<{ time: number; track: number; dur: number | null }> = [];
    for (const t of tracks) for (const [time, dur] of t.cues) points.push({ time, track: t.number, dur });
    points.sort((a, b) => a.time - b.time);
    const cues = el(0x1C53BB6B, points.flatMap(p => el(0xBB, [
        ...el(0xB3, uintBytes(p.time, 4)),
        ...el(0xB7, [
            ...el(0xF7, uintBytes(p.track, 1)),
            ...el(0xF1, uintBytes(0, 4)),
            ...(p.dur ? el(0xB2, uintBytes(p.dur, 4)) : [])
        ])
    ])));

    // SeekHead positions are relative to the Segment data start; its own size
    // is fixed (3 entries × fixed widths), so compute it with dummy values first.
    const seekEntry = (id: number, pos: number) => el(0x4DBB, [...el(0x53AB, encodeId(id)), ...el(0x53AC, uintBytes(pos, 8))]);
    const seekHeadLen = el(0x114D9B74, [...seekEntry(0x1549A966, 0), ...seekEntry(0x1654AE6B, 0), ...seekEntry(0x1C53BB6B, 0)]).length;
    const infoPos = seekHeadLen;
    const tracksPos = infoPos + info.length;
    const cuesPos = tracksPos + tracksEl.length + cluster.length;
    const seekHead = el(0x114D9B74, [
        ...seekEntry(0x1549A966, infoPos), ...seekEntry(0x1654AE6B, tracksPos), ...seekEntry(0x1C53BB6B, cuesPos)
    ]);
    const segment = el(0x18538067, [...seekHead, ...info, ...tracksEl, ...cluster, ...cues]);
    return new Uint8Array([...ebml, ...segment]);
}

/** fetch() serving `files` (url → bytes | JSON-able | text) with Range support, plus a request log. */
export function fakeFetch(files: Record<string, Uint8Array | string | object | ((url: string) => unknown)>) {
    const log: string[] = [];
    const impl = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        log.push(url);
        let body = files[url];
        if (typeof body === 'function') body = (body as (u: string) => unknown)(url) as any;
        if (body === undefined) return new Response('not found', { status: 404 });
        if (body instanceof Uint8Array) {
            const range = new Headers(init?.headers).get('range');
            const m = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
            if (!m) return new Response(body as unknown as BodyInit, { status: 200, headers: { 'content-length': String(body.length) } });
            const start = Number(m[1]);
            const end = Math.min(Number(m[2]), body.length - 1);
            return new Response(body.slice(start, end + 1) as unknown as BodyInit, {
                status: 206,
                headers: { 'content-range': `bytes ${start}-${end}/${body.length}` }
            });
        }
        if (typeof body === 'string') return new Response(body, { status: 200 });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { fetch: impl, log };
}
