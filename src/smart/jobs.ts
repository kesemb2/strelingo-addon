// Background builds, so the merged subtitle is usually ready before the
// player asks for it (the Smart-Hebrew-Subtitles ★ approach). A build starts
// as soon as the add-on learns about a video — when a 🎓 stream is played, or
// when the player lists subtitles.
//
// Finished builds also go to the shared store (see ../store.ts): on Vercel the
// request that plays the stream and the one that fetches the subtitle may run
// on different instances. Only one instance builds a given subtitle (a lease
// in the store); the others wait for its result. waitUntil keeps a Vercel
// function alive for a build that outlives its response; elsewhere it does
// nothing.

import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

import { getJson, setJson, takeLease } from '../store.js';
import { logEvent } from './activity.js';
import { buildDual, type BuildOutput, type SmartRequest } from './pipeline.js';

interface Job {
    key: string;
    startedAt: number;
    finishedAt?: number;
    final?: BuildOutput;
    /** "built" here, "stored" by an earlier build, "waited" for another instance's. */
    origin?: 'built' | 'stored' | 'waited';
    done: Promise<void>;
    listeners: Set<() => void>;
}

const RESULT_TTL_MS = 6 * 3600_000;
const FAILED_TTL_MS = 10 * 60_000;
const LEASE_S = 50;
const LEASE_POLL_MS = 1_500;
const MAX_JOBS = 300;
const jobs = new Map<string, Job>();

/** Who asked, for the activity log. */
export interface JobContext {
    userKey: string;
    pair: string;
}

/** Keep a Vercel function alive until `work` settles (no-op elsewhere). */
export function keepAlive(work: Promise<unknown>): void {
    try {
        waitUntil(work.catch(() => undefined));
    } catch { /* not on Vercel */ }
}

const digest = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 32);
const resultKey = (key: string) => `result:${digest(key)}`;

export function jobKey(req: SmartRequest): string {
    const f = req.file;
    // Name + exact byte size is the same file whichever link serves it (debrid
    // links rotate their tokens, so the URL would defeat reuse). Without a
    // size, a name alone may be generic: then the link or hash identifies it.
    const fileId = f.size
        ? `f:${f.filename || ''}|${f.size}|${f.url ? 'u' : '-'}`
        : f.url ? `u:${f.url}` : f.hash ? `h:${f.hash}` : f.filename ? `n:${f.filename}` : 'none';
    const keys = `${req.optional.mode}|${req.optional.subsourceKey ? 's' : ''}${req.optional.wyzieKey ? 'w' : ''}`;
    const bans = req.bans && (req.bans.refs.length || req.bans.subs.length)
        ? `b:${digest([...req.bans.refs].sort().join(',') + '|' + [...req.bans.subs].sort().join(','))}`
        : 'b:-';
    return [req.videoId, req.mainLang, req.transLang, `v${req.variant}`, fileId, keys, bans].join('|');
}

function isFresh(job: Job): boolean {
    if (!job.finishedAt) return true;
    const ttl = job.final?.srt ? RESULT_TTL_MS : FAILED_TTL_MS;
    return Date.now() - job.finishedAt < ttl;
}

function notify(job: Job): void {
    for (const fn of job.listeners) fn();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function crashed(message: string, startedAt: number): BuildOutput {
    return {
        srt: null,
        info: {
            stage: 'final', tier: 'none', file: { known: false }, notes: [`crash: ${message}`],
            candidates: { main: 0, trans: 0, loadedMain: 0, loadedTrans: 0, sources: {} }, ms: Date.now() - startedAt
        }
    };
}

export function startJob(req: SmartRequest, ctx: JobContext): Job {
    const key = jobKey(req);
    const existing = jobs.get(key);
    if (existing && isFresh(existing)) return existing;

    const job: Job = { key, startedAt: Date.now(), listeners: new Set(), done: Promise.resolve() };
    job.done = (async () => {
        try {
            // Built already, maybe by another instance.
            const stored = await getJson<BuildOutput>(resultKey(key));
            if (stored?.info) {
                job.final = stored;
                job.origin = 'stored';
                return;
            }
            // Another instance is building it: wait for its result.
            if (!(await takeLease(`lease:${digest(key)}`, LEASE_S))) {
                const until = Date.now() + LEASE_S * 1000;
                while (Date.now() < until) {
                    await sleep(LEASE_POLL_MS);
                    const theirs = await getJson<BuildOutput>(resultKey(key));
                    if (theirs?.info) {
                        job.final = theirs;
                        job.origin = 'waited';
                        return;
                    }
                }
            }
            const out = await buildDual(req);
            const i = out.info;
            console.log(`[build] ${req.videoId} v${req.variant} ${out.srt ? 'ok' : 'FAILED'} tier=${i.tier} `
                + `file=${i.file.known ? i.file.via || 'yes' : 'unknown'} ref="${i.reference || '-'}" `
                + `main=${i.main ? `${i.main.source}#${i.main.rank + 1} ratio=${i.main.ratio} off=${i.main.offsetMs} cuts=${i.main.splits} conf=${i.main.contrast}` : '-'} `
                + `trans=${i.trans ? `${i.trans.source}#${i.trans.rank + 1} conf=${i.trans.contrast} via=${i.trans.alignedTo}` : '-'} `
                + `pair=${i.pair ?? '-'} notes=[${i.notes.join(',')}] ${i.ms}ms`);
            await Promise.all([
                setJson(resultKey(key), out, (out.srt ? RESULT_TTL_MS : FAILED_TTL_MS) / 1000),
                logEvent({
                    kind: 'build', user: ctx.userKey, pair: ctx.pair, type: req.type, videoId: req.videoId,
                    variant: req.variant, ok: Boolean(out.srt), info: out.info, bans: req.bans
                })
            ]);
            // Only now "done": another instance asking from here on finds it stored.
            job.final = out;
            job.origin = 'built';
        } catch (e: any) {
            console.error(`[build] ${req.videoId} crashed:`, e?.stack || e);
            job.final = crashed(e?.message || String(e), job.startedAt);
            job.origin = 'built';
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

/** The finished build if it is done within `waitMs`, else null. */
export function waitForJob(job: Job, waitMs: number): Promise<BuildOutput | null> {
    if (job.final) return Promise.resolve(job.final);
    return new Promise(resolve => {
        const finish = () => {
            clearTimeout(timer);
            job.listeners.delete(onChange);
            resolve(job.final || null);
        };
        const onChange = () => { if (job.final) finish(); };
        const timer = setTimeout(finish, waitMs);
        job.listeners.add(onChange);
    });
}

/** A finished result for this request, if one exists here or in the store (no build started). */
export async function peekResult(req: SmartRequest): Promise<BuildOutput | null> {
    const key = jobKey(req);
    const local = jobs.get(key);
    if (local?.final && isFresh(local)) return local.final;
    return getJson<BuildOutput>(resultKey(key));
}

/** Tests: forget this instance's in-memory jobs, as a fresh server instance would. */
export function forgetLocalJobs(): void {
    jobs.clear();
}
