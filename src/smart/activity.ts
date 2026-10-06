// What happened with every subtitle, for the activity page: lists the player
// asked for, builds (with everything the pipeline decided),
// subtitles served, and what the user reported. Append-only, in the shared
// store, so every instance writes to one log. Never holds stream URLs (they
// carry debrid tokens): file names and sizes only.

import { randomUUID } from 'node:crypto';

import { appendJson, listJson } from '../store.js';
import type { Bans, BuildInfo } from './pipeline.js';

// "play" events come from versions that listed 🎓 streams (still in the log for a while).
export type EventKind = 'list' | 'play' | 'build' | 'serve' | 'report' | 'undo';

export interface ActivityEvent {
    id: string;
    at: number;
    kind: EventKind;
    /** The user's config fingerprint (several people may share one server). */
    user: string;
    /** "fre+eng" */
    pair: string;
    type: string;
    videoId: string;
    file?: { via?: string; filename?: string; size?: number };
    /** Which subtitle entry was served or reported (star, alt, main, trans, bad_sync...). */
    entry?: string;
    variant?: number;
    ok?: boolean;
    waitedMs?: number;
    /** Where the served result came from: built now, an earlier build, another instance's. */
    origin?: string;
    info?: BuildInfo;
    bans?: Bans;
    entries?: string[];
    report?: { kind: string; outcome: string; id?: string; bans?: Bans; from?: 'player' | 'page' };
    message?: string;
}

const LOG_MAX = 500;
const LOG_TTL_S = 45 * 24 * 3600;

export async function logEvent(e: Omit<ActivityEvent, 'id' | 'at'>): Promise<void> {
    const event: ActivityEvent = { id: randomUUID().slice(0, 12), at: Date.now(), ...e };
    await Promise.all([
        appendJson('log:all', event, LOG_MAX, LOG_TTL_S),
        appendJson(`log:u:${e.user}`, event, LOG_MAX, LOG_TTL_S)
    ]);
}

/** Newest first; one user's events, or everyone's. */
export function readEvents(user: string | null, limit = LOG_MAX): Promise<ActivityEvent[]> {
    return listJson<ActivityEvent>(user ? `log:u:${user}` : 'log:all', limit);
}
