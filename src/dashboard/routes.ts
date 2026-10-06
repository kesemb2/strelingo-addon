// The activity page: what happened with every subtitle (Smart-Hebrew-Subtitles
// style), and buttons to teach the add-on from there too.
//
//   /  or  /status            everyone's activity on this server; locked with
//                             ADMIN_PASSWORD when it is set
//   /<config>/status          one user's activity (the config in the link is
//                             the key, like the add-on link itself)
//
// Each page reads its JSON from <base>/api/status and <base>/api/activity.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { parseUserConfig, signingSecret, type UserConfig } from '../config.js';
import { hebrewLanguageName, languageMap } from '../languages.js';
import { logEvent, readEvents, type ActivityEvent } from '../smart/activity.js';
import { REPORT_KINDS, applyReport, reportsFor, undoReport, type Report, type ReportKind } from '../smart/feedback.js';
import { videoMeta } from '../smart/meta.js';
import { getStore } from '../store.js';
import { PAGE_HTML } from './page.js';

const COOKIE = 'strelingo_admin';
const MAX_VIDEOS = 30;
const EVENTS_READ = 400;
const EVENTS_PER_VIDEO = 60;
// Build details are the heavy part of an event: keep them on the newest few.
const DETAILED_PER_VIDEO = 8;
const REPORTS_FOR = 12;

function adminToken(): string | null {
    const pw = process.env.ADMIN_PASSWORD;
    return pw ? createHmac('sha256', signingSecret()).update(`admin:${pw}`).digest('base64url') : null;
}

function same(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function isAdmin(c: Context): boolean {
    const token = adminToken();
    return !token || same(getCookie(c, COOKIE) || '', token);
}

interface Scope {
    /** null = everyone's activity */
    user: string | null;
    config?: UserConfig;
}

/** The scope a request may see, or null when it needs to log in first. */
function scopeOf(c: Context): Scope | null {
    const seg = c.req.param('config');
    if (seg !== undefined) {
        const config = parseUserConfig(seg);
        return config ? { user: config.userKey, config } : null;
    }
    return isAdmin(c) ? { user: null } : null;
}

const hebrewNames = Object.fromEntries(Object.keys(languageMap).map(code => [code, hebrewLanguageName(code)]));

function page(c: Context, apiBase: string, configureUrl: string, scope: 'all' | 'user') {
    const boot = JSON.stringify({ apiBase, configureUrl, scope, languages: hebrewNames }).replace(/</g, '\\u003c');
    return c.html(PAGE_HTML.replace('__STRELINGO_BOOT__', boot), 200, { 'Cache-Control': 'no-store' });
}

interface VideoCard {
    user: string;
    pair: string;
    type: string;
    videoId: string;
    lastAt: number;
    title?: string;
    poster?: string;
    year?: string;
    episodeTitle?: string;
    file?: ActivityEvent['file'];
    events: ActivityEvent[];
    reports: Report[];
}

export async function activity(user: string | null): Promise<{ videos: VideoCard[] }> {
    const events = await readEvents(user, EVENTS_READ);
    const groups = new Map<string, VideoCard & { detailed: number }>();
    for (const e of events) {
        const key = `${e.user}|${e.videoId}`;
        let g = groups.get(key);
        if (!g) {
            if (groups.size >= MAX_VIDEOS) continue;
            g = { user: e.user, pair: e.pair, type: e.type, videoId: e.videoId, lastAt: e.at, events: [], reports: [], detailed: 0 };
            groups.set(key, g);
        }
        if (g.events.length >= EVENTS_PER_VIDEO) continue;
        const slim: ActivityEvent = { ...e };
        delete slim.entries;
        if (slim.info && g.detailed++ >= DETAILED_PER_VIDEO) {
            const { tier, pair, ms, notes, refBan } = slim.info;
            slim.info = { ...slim.info, tier, pair, ms, notes, refBan, evaluated: undefined, references: undefined };
        }
        g.events.push(slim);
        if (!g.file && e.file?.filename) g.file = e.file;
    }
    const cards = [...groups.values()];
    await Promise.all(cards.map(async (g, i) => {
        const [meta, reports] = await Promise.all([
            videoMeta(g.type, g.videoId),
            i < REPORTS_FOR ? reportsFor(g.user, g.videoId) : Promise.resolve([] as Report[])
        ]);
        if (meta) Object.assign(g, { title: meta.name, poster: meta.poster, year: meta.year, episodeTitle: meta.episodeTitle });
        g.reports = reports;
    }));
    return { videos: cards.map(({ detailed: _d, ...card }) => card) };
}

function status(scope: Scope, version: string) {
    const base = {
        version,
        sharedState: getStore().kind,
        vercel: process.env.VERCEL === '1',
        scope: scope.user ? 'user' : 'all',
        protected: Boolean(process.env.ADMIN_PASSWORD)
    };
    return scope.config
        ? { ...base, pair: `${scope.config.mainLang}+${scope.config.transLang}`, streamAddon: Boolean(scope.config.streamAddonUrl) }
        : base;
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
    try {
        const body = await c.req.json();
        return body && typeof body === 'object' ? body : {};
    } catch {
        return {};
    }
}

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : '');

export function registerDashboard(app: Hono, version: string): void {
    app.get('/', c => page(c, '', '/configure', 'all'));
    app.get('/status', c => page(c, '', '/configure', 'all'));

    app.post('/api/login', async c => {
        const token = adminToken();
        const body = await readBody(c);
        const password = str(body.password, 500);
        if (!token || !process.env.ADMIN_PASSWORD || !same(password, process.env.ADMIN_PASSWORD)) {
            return c.json({ ok: false }, 401);
        }
        setCookie(c, COOKIE, token, {
            httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 90 * 24 * 3600,
            secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
        });
        return c.json({ ok: true });
    });

    const handlers = {
        status: (c: Context) => {
            const scope = scopeOf(c);
            if (!scope) return c.json({ error: 'login' }, 401);
            return c.json(status(scope, version), 200, { 'Cache-Control': 'no-store' });
        },
        activity: async (c: Context) => {
            const scope = scopeOf(c);
            if (!scope) return c.json({ error: 'login' }, 401);
            return c.json(await activity(scope.user), 200, { 'Cache-Control': 'no-store' });
        },
        // "Bad sync" etc. from the page: no 15-second rule (a deliberate click).
        feedback: async (c: Context) => {
            const scope = scopeOf(c);
            if (!scope) return c.json({ error: 'login' }, 401);
            const body = await readBody(c);
            const user = scope.user || str(body.user, 64);
            const videoId = str(body.videoId);
            const kind = str(body.kind) as ReportKind;
            if (!user || !videoId || !REPORT_KINDS.includes(kind)) return c.json({ error: 'bad request' }, 400);
            const r = await applyReport(user, videoId, kind, 'page');
            await logEvent({
                kind: 'report', user, pair: str(body.pair, 20), type: str(body.type, 20) || 'movie', videoId, entry: kind,
                report: { kind, outcome: r.outcome, id: r.report?.id, bans: r.report?.bans, from: 'page' }
            });
            return c.json({ outcome: r.outcome, report: r.report });
        },
        undo: async (c: Context) => {
            const scope = scopeOf(c);
            if (!scope) return c.json({ error: 'login' }, 401);
            const body = await readBody(c);
            const user = scope.user || str(body.user, 64);
            const videoId = str(body.videoId);
            const id = str(body.id, 64);
            if (!user || !videoId || !id) return c.json({ error: 'bad request' }, 400);
            const ok = await undoReport(user, videoId, id);
            if (ok) {
                await logEvent({
                    kind: 'undo', user, pair: str(body.pair, 20), type: str(body.type, 20) || 'movie', videoId,
                    entry: str(body.kind, 20) || undefined
                });
            }
            return c.json({ ok });
        }
    };

    // Everyone's activity (registered before the per-user routes: "api" is not a config).
    app.get('/api/status', handlers.status);
    app.get('/api/activity', handlers.activity);
    app.post('/api/feedback', handlers.feedback);
    app.post('/api/feedback/undo', handlers.undo);

    // One user's activity.
    app.get('/:config/status', c => {
        const seg = c.req.param('config');
        if (!parseUserConfig(seg)) return c.notFound();
        return page(c, `/${seg}`, `/${seg}/configure`, 'user');
    });
    app.get('/:config/api/status', handlers.status);
    app.get('/:config/api/activity', handlers.activity);
    app.post('/:config/api/feedback', handlers.feedback);
    app.post('/:config/api/feedback/undo', handlers.undo);
}
