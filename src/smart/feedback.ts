// What the user taught the add-on, per video: picking "⚠ the sync is bad" in
// the player retires the timing reference of the subtitle they were watching;
// "⚠ the English is bad" / "⚠ the French is bad" retire that subtitle. The
// next build puts what was reported at the back of the line (never out: if
// nothing else exists, it is still better than nothing).
//
// Players may fetch every listed subtitle up front, so a report from the
// player only counts once the viewer has had the subtitle on screen for a
// while, and once per subtitle served (Smart-Hebrew-Subtitles' rules).

import { randomUUID } from 'node:crypto';

import { getJson, setJson } from '../store.js';
import type { Bans, BuildInfo, Tier } from './pipeline.js';

export type ReportKind = 'bad_sync' | 'bad_trans' | 'bad_main';
export const REPORT_KINDS: readonly ReportKind[] = ['bad_sync', 'bad_trans', 'bad_main'];

export interface ServedRecord {
    at: number;
    entry: string;
    tier: Tier;
    refBan: string[];
    mainId?: string;
    transId?: string;
}

export interface Report {
    id: string;
    at: number;
    kind: ReportKind;
    bans: Bans;
    /** The served subtitle it was about. */
    servedAt: number;
    tier: Tier;
    from: 'player' | 'page';
    undone?: boolean;
}

export type ReportOutcome = 'recorded' | 'too_soon' | 'duplicate' | 'nothing_served' | 'nothing_to_retire';

const reportMinViewMs = () => Number(process.env.REPORT_MIN_VIEW_MS ?? 15_000);
const SERVED_TTL_S = 12 * 3600;
const FEEDBACK_TTL_S = 120 * 24 * 3600;

const servedKey = (user: string, videoId: string) => `served:${user}|${videoId}`;
const feedbackKey = (user: string, videoId: string) => `fb:${user}|${videoId}`;

export async function recordServed(user: string, videoId: string, entry: string, info: BuildInfo): Promise<void> {
    const rec: ServedRecord = {
        at: Date.now(), entry, tier: info.tier, refBan: info.refBan || [],
        mainId: info.main?.id, transId: info.trans?.id
    };
    await setJson(servedKey(user, videoId), rec, SERVED_TTL_S);
}

export function lastServed(user: string, videoId: string): Promise<ServedRecord | null> {
    return getJson<ServedRecord>(servedKey(user, videoId));
}

export async function reportsFor(user: string, videoId: string): Promise<Report[]> {
    return (await getJson<Report[]>(feedbackKey(user, videoId))) || [];
}

export function bansOf(reports: Report[]): Bans {
    const refs = new Set<string>();
    const subs = new Set<string>();
    for (const r of reports) {
        if (r.undone) continue;
        r.bans.refs.forEach(x => refs.add(x));
        r.bans.subs.forEach(x => subs.add(x));
    }
    return { refs: [...refs], subs: [...subs] };
}

export async function bansFor(user: string, videoId: string): Promise<Bans> {
    return bansOf(await reportsFor(user, videoId));
}

function bansFrom(kind: ReportKind, served: ServedRecord): Bans {
    if (kind === 'bad_sync') return { refs: served.refBan, subs: [] };
    const id = kind === 'bad_trans' ? served.transId : served.mainId;
    return { refs: [], subs: id ? [id] : [] };
}

/** Records a report about the subtitle last served for this video. */
export async function applyReport(
    user: string, videoId: string, kind: ReportKind, from: 'player' | 'page'
): Promise<{ outcome: ReportOutcome; report?: Report }> {
    const served = await lastServed(user, videoId);
    if (!served) return { outcome: 'nothing_served' };
    if (from === 'player' && Date.now() - served.at < reportMinViewMs()) return { outcome: 'too_soon' };
    const reports = await reportsFor(user, videoId);
    if (reports.some(r => !r.undone && r.kind === kind && r.servedAt === served.at)) return { outcome: 'duplicate' };
    const bans = bansFrom(kind, served);
    if (bans.refs.length === 0 && bans.subs.length === 0) return { outcome: 'nothing_to_retire' };
    const report: Report = { id: randomUUID().slice(0, 12), at: Date.now(), kind, bans, servedAt: served.at, tier: served.tier, from };
    reports.push(report);
    await setJson(feedbackKey(user, videoId), reports.slice(-50), FEEDBACK_TTL_S);
    return { outcome: 'recorded', report };
}

export async function undoReport(user: string, videoId: string, id: string): Promise<boolean> {
    const reports = await reportsFor(user, videoId);
    const r = reports.find(x => x.id === id);
    if (!r || r.undone) return false;
    r.undone = true;
    await setJson(feedbackKey(user, videoId), reports, FEEDBACK_TTL_S);
    return true;
}
