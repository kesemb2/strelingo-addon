// Which file each user is playing, learned when a 🎓 stream is opened
// (it passes through /play before redirecting to the real file).
// In memory: a record lives for a viewing, not across restarts.

import type { FileHint } from './pipeline';

const MAX_AGE_MS = 8 * 3600_000;
const plays = new Map<string, { file: FileHint; at: number }>();

export function recordPlay(userKey: string, videoId: string, file: FileHint): boolean {
    const key = `${userKey}|${videoId}`;
    const prev = plays.get(key);
    plays.set(key, { file, at: Date.now() });
    if (plays.size > 2000) plays.delete(plays.keys().next().value!);
    // A seek re-opens the same URL; only a different file is news.
    return !prev || prev.file.url !== file.url;
}

export function latestPlay(userKey: string, videoId: string): FileHint | null {
    const hit = plays.get(`${userKey}|${videoId}`);
    if (!hit || Date.now() - hit.at > MAX_AGE_MS) return null;
    return hit.file;
}
