// The OpenSubtitles "moviehash" of a remote file, from two 64 KiB range reads:
// file size + the sum of the first and last 64 KiB as little-endian uint64s.
// Subtitles uploaded with this hash were timed against this exact file.

import { RangeReader } from './rangeReader';

const CHUNK = 64 * 1024;
const MASK = (1n << 64n) - 1n;

function sumChunk(bytes: Uint8Array): bigint {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let sum = 0n;
    for (let i = 0; i + 8 <= bytes.length; i += 8) {
        sum = (sum + view.getBigUint64(i, true)) & MASK;
    }
    return sum;
}

export function hashFromChunks(size: number, head: Uint8Array, tail: Uint8Array): string {
    const total = (BigInt(size) + sumChunk(head) + sumChunk(tail)) & MASK;
    return total.toString(16).padStart(16, '0');
}

export async function openSubtitlesHash(reader: RangeReader, knownSize?: number): Promise<{ hash: string; size: number } | null> {
    const head = await reader.read(0, CHUNK);
    const size = knownSize || reader.size || 0;
    if (!size || size < 2 * CHUNK || head.length < CHUNK) return null;
    const tail = await reader.read(size - CHUNK, CHUNK);
    if (tail.length < CHUNK) return null;
    return { hash: hashFromChunks(size, head, tail), size };
}
