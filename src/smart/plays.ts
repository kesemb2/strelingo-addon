// Which file each user is playing, learned when a 🎓 stream is opened
// (it passes through /play before redirecting to the real file). Kept in the
// shared store, so a later subtitle request on another server instance
// (Vercel) still finds it.

import { getJson, getStore, setJson } from '../store.js';
import type { FileHint } from './pipeline.js';

const MAX_AGE_S = 8 * 3600;
// Players re-open the /play URL on every seek: write only when it's news.
const REWRITE_AFTER_MS = 10 * 60_000;
const written = new Map<string, { url?: string; at: number }>();

/** Records the pick; true when it is a different file than this instance last saw. */
export async function recordPlay(userKey: string, videoId: string, file: FileHint): Promise<boolean> {
    const key = `${userKey}|${videoId}`;
    const prev = written.get(key);
    const changed = !prev || prev.url !== file.url;
    if (!changed && Date.now() - prev!.at < REWRITE_AFTER_MS) return false;
    written.set(key, { url: file.url, at: Date.now() });
    if (written.size > 2000) written.delete(written.keys().next().value!);
    await setJson(`play:${key}`, { ...file, at: Date.now() }, MAX_AGE_S);
    return changed;
}

export async function latestPlay(userKey: string, videoId: string): Promise<FileHint | null> {
    const hit = await getJson<FileHint & { at?: number }>(`play:${userKey}|${videoId}`);
    if (!hit) return null;
    const { at: _at, ...file } = hit;
    return file;
}

/** Whether play records reach every instance (false = this process's memory only). */
export function playsShared(): boolean {
    return getStore().kind !== 'memory';
}
