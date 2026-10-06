// Background builds, so the merged subtitle is usually ready before the
// player asks for it (the Smart-Hebrew-Subtitles ★ approach). A build starts
// as soon as the add-on learns about a video — when a 🎓 stream is played, or
// when the player lists subtitles — and every stage it reaches is kept, so a
// request that can't wait any longer still gets the best result so far.
//
// Finished builds also go to the shared store (see ../store.ts): on Vercel the
// request that plays the stream and the one that fetches the subtitle may run
// on different instances. waitUntil keeps a Vercel function alive for a build
// that outlives its response; elsewhere it does nothing.

import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

import { getJson, setJson } from '../store.js';
import { buildDual, type BuildInfo, type BuildOutput, type SmartRequest } from './pipeline.js';

interface Job {
    key: string;
    userKey: string;
    videoId: string;
    startedAt: number;
    finishedAt?: number;
    latest?: BuildOutput;
    final?: BuildOutput;
    done: Promise<void>;
    listeners: Set<() => void>;
}

const RESULT_TTL_MS = 6 * 3600_000;
const FAILED_TTL_MS = 10 * 60_000;
const MAX_JOBS = 300;
const jobs = new Map<string, Job>();

export interface RecentBuild {
    at: string;
    userKey: string;
    videoId: string;
    variant: number;
    ok: boolean;
    info: BuildInfo;
}
const RECENT_MAX = 30;
const RECENT_TTL_S = 30 * 24 * 3600;

/** Keep a Vercel function alive until `work` settles (no-op elsewhere). */
export function keepAlive(work: Promise<unknown>): void {
    try {
        waitUntil(work.catch(() => undefined));
    } catch { /* not on Vercel */ }
}

function resultKey(key: string): string {
    return `result:${createHash('sha256').update(key).digest('base64url').slice(0, 32)}`;
}

export function jobKey(req: SmartRequest): string {
    const f = req.file;
    // Name + exact byte size is the same file whichever link serves it (debrid
    // links rotate their tokens, so the URL would defeat reuse). Without a
    // size, a name alone may be generic: then the link or hash identifies it.
    const fileId = f.size
        ? `f:${f.filename || ''}|${f.size}|${f.url ? 'u' : '-'}`
        : f.url ? `u:${f.url}` : f.hash ? `h:${f.hash}` : f.filename ? `n:${f.filename}` : 'none';
    const keys = `${req.optional.mode}|${req.optional.subsourceKey ? 's' : ''}${req.optional.wyzieKey ? 'w' : ''}`;
    return [req.videoId, req.mainLang, req.transLang, `v${req.variant}`, fileId, keys].join('|');
}

function isFresh(job: Job): boolean {
    if (!job.finishedAt) return true;
    const ttl = job.final?.srt ? RESULT_TTL_MS : FAILED_TTL_MS;
    return Date.now() - job.finishedAt < ttl;
}

function notify(job: Job): void {
    for (const fn of job.listeners) fn();
}

export function startJob(req: SmartRequest, userKey: string): Job {
    const key = jobKey(req);
    const existing = jobs.get(key);
    if (existing && isFresh(existing)) return existing;

    const job: Job = {
        key, userKey, videoId: req.videoId, startedAt: Date.now(),
        listeners: new Set(), done: Promise.resolve()
    };
    job.done = (async () => {
        try {
            // Built already, maybe by another instance.
            const stored = await getJson<BuildOutput>(resultKey(key));
            if (stored?.info) {
                job.final = stored;
                job.latest = stored;
                return;
            }
            const out = await buildDual(req, partial => {
                if (job.final) return;
                job.latest = partial;
                notify(job);
            });
            const i = out.info;
            console.log(`[build] ${req.videoId} v${req.variant} ${out.srt ? 'ok' : 'FAILED'} tier=${i.tier} `
                + `file=${i.file.known ? i.file.via || 'yes' : 'unknown'} ref="${i.reference || '-'}" `
                + `main=${i.main ? `${i.main.source}#${i.main.rank + 1} ratio=${i.main.ratio} off=${i.main.offsetMs} cuts=${i.main.splits} conf=${i.main.contrast}` : '-'} `
                + `trans=${i.trans ? `${i.trans.source}#${i.trans.rank + 1} conf=${i.trans.contrast} via=${i.trans.alignedTo}` : '-'} `
                + `notes=[${i.notes.join(',')}] ${i.ms}ms`);
            await Promise.all([
                setJson(resultKey(key), out, (out.srt ? RESULT_TTL_MS : FAILED_TTL_MS) / 1000),
                (async () => {
                    const list = (await getJson<RecentBuild[]>(`recent:${userKey}`)) || [];
                    list.unshift({ at: new Date().toISOString(), userKey, videoId: req.videoId, variant: req.variant, ok: Boolean(out.srt), info: out.info });
                    await setJson(`recent:${userKey}`, list.slice(0, RECENT_MAX), RECENT_TTL_S);
                })()
            ]);
            // Only now "done": another instance asking from here on finds it stored.
            job.final = out;
            job.latest = out.srt ? out : job.latest;
        } catch (e: any) {
            console.error(`[build] ${req.videoId} crashed:`, e?.stack || e);
            job.final = {
                srt: null,
                info: {
                    stage: 'final', tier: 'none', file: { known: false }, notes: [`crash: ${e?.message || e}`],
                    candidates: { main: 0, trans: 0, loadedMain: 0, loadedTrans: 0, sources: {} }, ms: Date.now() - job.startedAt
                }
            };
        } finally {
            job.finishedAt = Date.now();
            notify(job);
        }
    })();

    jobs.set(key, job);
    keepAlive(job.done);
    if (jobs.size > MAX_JOBS) {
        for (const [k, j] of jobs) {
            if (j.finishedAt) {
                jobs.delete(k);
                if (jobs.size <= MAX_JOBS) break;
            }
        }
    }
    return job;
}

/**
 * The best result within `waitMs`: the final one if the build finishes in
 * time, else the latest stage (null if not even the quick stage is ready).
 */
export function waitForJob(job: Job, waitMs: number): Promise<{ out: BuildOutput | null; final: boolean }> {
    if (job.final) return Promise.resolve({ out: job.final.srt ? job.final : job.latest || job.final, final: true });
    return new Promise(resolve => {
        const finish = () => {
            clearTimeout(timer);
            job.listeners.delete(onChange);
            resolve(job.final
                ? { out: job.final.srt ? job.final : job.latest || job.final, final: true }
                : { out: job.latest || null, final: false });
        };
        const onChange = () => { if (job.final) finish(); };
        const timer = setTimeout(finish, waitMs);
        job.listeners.add(onChange);
    });
}

export async function recentBuilds(userKey: string): Promise<RecentBuild[]> {
    return (await getJson<RecentBuild[]>(`recent:${userKey}`)) || [];
}

/** Tests: forget this instance's in-memory jobs, as a fresh server instance would. */
export function forgetLocalJobs(): void {
    jobs.clear();
}
