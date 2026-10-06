// Background builds, so the merged subtitle is usually ready before the
// player asks for it (the Smart-Hebrew-Subtitles ★ approach). A build starts
// as soon as the add-on learns about a video — when a 🎓 stream is played, or
// when the player lists subtitles — and every stage it reaches is kept, so a
// request that can't wait any longer still gets the best result so far.

import { buildDual, type BuildInfo, type BuildOutput, type SmartRequest } from './pipeline';

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
const recent: RecentBuild[] = [];

export function jobKey(req: SmartRequest): string {
    const f = req.file;
    const fileId = f.filename || f.size
        ? `f:${f.filename || ''}|${f.size || ''}|${f.url ? 'u' : '-'}`
        : f.url ? `u:${f.url}` : f.hash ? `h:${f.hash}` : 'none';
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
            const out = await buildDual(req, partial => {
                if (job.final) return;
                job.latest = partial;
                notify(job);
            });
            job.final = out;
            job.latest = out.srt ? out : job.latest;
            const i = out.info;
            console.log(`[build] ${req.videoId} v${req.variant} ${out.srt ? 'ok' : 'FAILED'} tier=${i.tier} `
                + `file=${i.file.known ? i.file.via || 'yes' : 'unknown'} ref="${i.reference || '-'}" `
                + `main=${i.main ? `${i.main.source}#${i.main.rank + 1} ratio=${i.main.ratio} off=${i.main.offsetMs} cuts=${i.main.splits} conf=${i.main.contrast}` : '-'} `
                + `trans=${i.trans ? `${i.trans.source}#${i.trans.rank + 1} conf=${i.trans.contrast} via=${i.trans.alignedTo}` : '-'} `
                + `notes=[${i.notes.join(',')}] ${i.ms}ms`);
            recent.unshift({ at: new Date().toISOString(), userKey, videoId: req.videoId, variant: req.variant, ok: Boolean(out.srt), info: out.info });
            recent.length = Math.min(recent.length, 100);
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

export function recentBuilds(userKey: string): RecentBuild[] {
    return recent.filter(r => r.userKey === userKey);
}
