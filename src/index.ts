import 'dotenv/config';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';

import landingTemplate, { type Manifest } from './landingTemplate.js';
import { browserLanguageMap, languageOptions } from './languages.js';
import { resolveKitsuToImdb } from './kitsuMapping.js';
import { OPTIONAL_PROVIDERS, WYZIE_SOURCES } from './providers.js';
import { encodeConfig, parseUserConfig, signingSource, signPayload, verifyPayload, type UserConfig } from './config.js';
import { fetchUpstreamStreams, normName, type UpstreamStream } from './file/upstream.js';
import { latestPlay, recordPlay, usesPlayLinks } from './smart/plays.js';
import { keepAlive, peekResult, startJob, waitForJob, type JobContext } from './smart/jobs.js';
import { logEvent, type ActivityEvent } from './smart/activity.js';
import { REPORT_KINDS, applyReport, bansFor, recordServed, type ReportKind } from './smart/feedback.js';
import { getStore } from './store.js';
import type { Bans, BuildOutput, FileHint, SmartRequest } from './smart/pipeline.js';
import { hebrewLanguageName } from './languages.js';
import { registerDashboard } from './dashboard/routes.js';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const ADDON_ID = 'com.kesemb2.strelingo.smart';
const VERSION = '1.1.0';

// Vercel: let a subtitle request wait for its build (and the build finish
// after the response) instead of the 10 s default of older projects.
export const config = { maxDuration: 60 };
const DEFAULT_NAME = 'Strelingo Smart';

function addonName(): string {
    return process.env.ADDON_NAME || DEFAULT_NAME;
}

function getManifest(config?: UserConfig | null): Manifest {
    const resources: string[] = ['subtitles'];
    if (config?.streamAddonUrl) resources.push('stream');
    const pair = config ? ` (${config.mainLang.toUpperCase()}+${config.transLang.toUpperCase()})` : '';
    return {
        id: ADDON_ID,
        version: VERSION,
        name: `${addonName()}${pair}`,
        description: 'Two subtitle lines at once — the film\'s language and yours — synced to the very file you play. '
            + 'Paste your AIOStreams link below and play a 🎓 stream for exact sync, in Stremio and Nuvio alike.',
        githubUrl: 'https://github.com/kesemb2/strelingo-addon',
        resources,
        subtitleExtra: ['videoHash', 'videoSize', 'filename'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'kitsu'],
        logo: 'https://raw.githubusercontent.com/Serkali-sudo/strelingo-addon/refs/heads/main/assets/strelingo_icon.jpg',
        background: 'https://raw.githubusercontent.com/Serkali-sudo/strelingo-addon/refs/heads/main/assets/strelingo_back.jpg',
        catalogs: [],
        behaviorHints: { configurable: true, configurationRequired: !config },
        config: [
            {
                key: 'mainLang', type: 'select', title: 'Main Language (the film\'s audio)',
                options: languageOptions, required: true, default: 'French [fre]'
            },
            {
                key: 'transLang', type: 'select', title: 'Translation Language (yours)',
                options: languageOptions, required: true, default: 'English [eng]'
            },
            {
                key: 'streamAddonUrl', type: 'text',
                title: '🎓 Your AIOStreams link — for exact sync (recommended)',
                description: 'Paste the manifest URL of your AIOStreams (or any stream add-on), exactly as installed. '
                    + 'The add-on then lists its streams marked 🎓 — play one of those, and both subtitle lines are '
                    + 'synced to that exact file. Nuvio\'s phone app tells subtitle add-ons nothing about the file, '
                    + 'so this is the only way to get exact sync there.'
            },
            {
                key: OPTIONAL_PROVIDERS.wyzie.key, type: 'password', title: OPTIONAL_PROVIDERS.wyzie.title,
                description: OPTIONAL_PROVIDERS.wyzie.help, section: 'Optional Providers (API key required)',
                link: { label: 'Get key', url: OPTIONAL_PROVIDERS.wyzie.getKeyUrl }
            },
            {
                key: OPTIONAL_PROVIDERS.wyzie.sourcesKey, type: 'multiselect', title: OPTIONAL_PROVIDERS.wyzie.sourcesTitle,
                description: OPTIONAL_PROVIDERS.wyzie.sourcesHelp, options: WYZIE_SOURCES.map(s => ({ ...s }))
            },
            {
                key: OPTIONAL_PROVIDERS.subsource.key, type: 'password', title: OPTIONAL_PROVIDERS.subsource.title,
                description: OPTIONAL_PROVIDERS.subsource.help,
                link: { label: 'Get key', url: OPTIONAL_PROVIDERS.subsource.getKeyUrl }
            },
            {
                key: OPTIONAL_PROVIDERS.mode.key, type: 'select', title: OPTIONAL_PROVIDERS.mode.title,
                options: [...OPTIONAL_PROVIDERS.mode.options], description: OPTIONAL_PROVIDERS.mode.help,
                default: OPTIONAL_PROVIDERS.mode.options[0]
            }
        ]
    };
}

// Stremio's manifest schema knows only text/number/password/checkbox/select;
// the configure page renders the rich version.
function toStremioSafeConfig(config?: Manifest['config']): Manifest['config'] {
    if (!config) return config;
    return config.map(item => {
        const { description, section, link, browserDetect, ...rest } = item as any;
        const safe: any = { ...rest };
        if (safe.type === 'multiselect') {
            safe.type = 'text';
            delete safe.options;
        } else if (Array.isArray(safe.options)) {
            safe.options = safe.options.map((o: any) => (typeof o === 'string' ? o : o.value));
        }
        return safe;
    });
}

function withUserDefaults(manifest: Manifest, config: UserConfig | null): Manifest {
    if (!manifest.config) return manifest;
    manifest.config = manifest.config.map(item => {
        const value = config?.raw[item.key];
        return value ? { ...item, default: String(value) } : item;
    });
    return manifest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function externalBase(c: Context): string {
    const configured = process.env.EXTERNAL_URL;
    if (configured) return configured.replace(/\/+$/, '');
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '');
    const host = c.req.header('x-forwarded-host')?.split(',')[0].trim() || c.req.header('host') || url.host;
    return `${proto}://${host}`;
}

function stripJson(s: string | undefined): string {
    return (s || '').replace(/\.json$/, '');
}

interface VideoIds {
    videoId: string;
    imdbId: string;
    season?: string;
    episode?: string;
    butaId?: string;
}

function parseVideoId(type: string, rawId: string): VideoIds | null {
    const videoId = decodeURIComponent(rawId);
    if (videoId.startsWith('kitsu:')) {
        const parts = videoId.split(':');
        const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
        const imdb = parts[1] ? resolveKitsuToImdb(parts[1], Number.isInteger(episode) ? episode : undefined) : null;
        if (!imdb) return null;
        return { videoId, imdbId: `tt${imdb.imdbid}`, season: imdb.season, episode: imdb.episode, butaId: videoId };
    }
    const parts = videoId.split(':');
    if (!/^tt\d+$/.test(parts[0])) return null;
    if (type === 'series' && parts.length >= 3) return { videoId, imdbId: parts[0], season: parts[1], episode: parts[2] };
    return { videoId, imdbId: parts[0] };
}

function parseExtra(extra: string | undefined): { filename?: string; size?: number; hash?: string } {
    const out: { filename?: string; size?: number; hash?: string } = {};
    for (const pair of stripJson(extra).split('&')) {
        const i = pair.indexOf('=');
        if (i < 0) continue;
        const key = pair.slice(0, i);
        let value = pair.slice(i + 1);
        try { value = decodeURIComponent(value); } catch { /* keep raw */ }
        if (key === 'filename' && value) out.filename = value;
        else if (key === 'videoSize' && /^\d+$/.test(value)) out.size = Number(value);
        else if (key === 'videoHash' && /^[0-9a-f]{16}$/i.test(value)) out.hash = value.toLowerCase();
    }
    return out;
}

function smartRequest(config: UserConfig, type: string, ids: VideoIds, file: FileHint, variant: 1 | 2, bans?: Bans): SmartRequest {
    return {
        type, videoId: ids.videoId, imdbId: ids.imdbId, season: ids.season, episode: ids.episode, butaId: ids.butaId,
        mainLang: config.mainLang, transLang: config.transLang, optional: config.optional,
        upstreamUrl: config.streamAddonUrl, file, variant, bans
    };
}

function jobContext(config: UserConfig): JobContext {
    return { userKey: config.userKey, pair: `${config.mainLang}+${config.transLang}` };
}

/** What the log keeps about a file: never its URL (debrid links carry tokens). */
function fileSummary(file: FileHint): ActivityEvent['file'] {
    return { via: file.via, filename: file.filename, size: file.size };
}

/** What the subtitle URL remembers about the file (never the stream URL itself). */
interface FileCtx {
    f?: string;
    s?: number;
    h?: string;
}

function encodeCtx(ctx: FileCtx): string {
    return ctx.f || ctx.s || ctx.h ? Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64url') : '-';
}

function decodeCtx(seg: string): FileCtx {
    if (!seg || seg === '-') return {};
    try {
        const v = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
        return {
            f: typeof v.f === 'string' ? v.f.slice(0, 500) : undefined,
            s: Number(v.s) > 0 ? Number(v.s) : undefined,
            h: typeof v.h === 'string' && /^[0-9a-f]{16}$/.test(v.h) ? v.h : undefined
        };
    } catch {
        return {};
    }
}

// A play record with nothing to check it against (Nuvio's phone app says
// nothing about the file) is trusted for about a film's length.
const UNCHECKED_PLAY_MAX_AGE_MS = 4 * 3600_000;

/**
 * The best knowledge of the playing file. A 🎓 play gives the file's URL, but
 * only counts while it is the file the player describes now: an older pick
 * must not override a different stream played since.
 */
async function resolveFile(config: UserConfig, videoId: string, said: FileCtx): Promise<FileHint> {
    const played = await latestPlay(config.userKey, videoId);
    if (played) {
        const p = played.file;
        const sameFile = said.s
            ? p.size === said.s
            : said.f
                ? normName(p.filename) === normName(said.f)
                : Date.now() - played.at < UNCHECKED_PLAY_MAX_AGE_MS;
        if (sameFile) return { ...p, hash: p.hash || said.h };
    }
    if (said.f || said.s || said.h) return { filename: said.f, size: said.s, hash: said.h, via: 'request' };
    return {};
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// With a stream add-on configured, a 🎓 play may land a moment after the
// player asks for subtitles: give it a short chance before building blind.
async function resolveFileWaiting(config: UserConfig, videoId: string, said: FileCtx, waitMs: number): Promise<FileHint> {
    let file = await resolveFile(config, videoId, said);
    // Nothing to wait for when the player named the file itself, or when
    // this user never plays 🎓 streams.
    if (!config.streamAddonUrl || file.via === 'play' || said.f || said.s) return file;
    if (!(await usesPlayLinks(config.userKey))) return file;
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
        await sleep(250);
        file = await resolveFile(config, videoId, said);
        if (file.via === 'play') break;
    }
    return file;
}

// A message as a subtitle, repeated through the whole film: the viewer may
// have started it anywhere.
function messageSrt(text: string): string {
    const p = (n: number, w: number) => String(n).padStart(w, '0');
    const ts = (ms: number) => `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
    const out: string[] = [];
    for (let i = 0, t = 1_000; t < 4 * 3600_000; i++, t += 30_000) {
        out.push(`${i + 1}\n${ts(t)} --> ${ts(t + 8_000)}\nStrelingo: ${text}\n`);
    }
    return out.join('\n');
}

function explainText(notes: string[], config: UserConfig): string {
    const main = hebrewLanguageName(config.mainLang);
    if (notes.includes('no_main_language_subtitles')) return `לא נמצאו כתוביות ב${main} לסרט הזה.`;
    if (notes.includes('main_language_downloads_failed')) return `לא הצלחתי להוריד כתוביות ב${main} כרגע. נסו שוב בעוד דקה.`;
    if (notes.some(n => n.startsWith('crash'))) return 'משהו השתבש בהכנת הכתוביות. הפרטים בדף הפעילות.';
    return 'הכתוביות עדיין בהכנה. בחרו את האפשרות שוב בעוד כמה שניות.';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const app = new Hono();
app.use('*', cors());

// sharedState "memory" on Vercel means 🎓 picks and builds don't reach other
// instances: connect Upstash or Turso (see README).
app.get('/health', c => c.json({
    ok: true,
    version: VERSION,
    sharedState: getStore().kind,
    signing: signingSource(),
    vercel: process.env.VERCEL === '1'
}));

app.get('/manifest.json', c => {
    const manifest = withUserDefaults(getManifest(null), null);
    manifest.config = toStremioSafeConfig(manifest.config);
    return c.json(manifest);
});

app.get('/configure', c => {
    const manifest = withUserDefaults(getManifest(null), null);
    return c.html(landingTemplate(manifest, { browserLangMap: browserLanguageMap }));
});

app.get('/:config/configure', c => {
    const config = parseUserConfig(c.req.param('config'));
    const manifest = withUserDefaults(getManifest(config), config);
    return c.html(landingTemplate(manifest, { browserLangMap: browserLanguageMap }));
});

app.get('/:config/manifest.json', c => {
    const config = parseUserConfig(c.req.param('config'));
    if (!config) return c.json({ error: 'invalid configuration' }, 400);
    const manifest = withUserDefaults(getManifest(config), config);
    manifest.config = toStremioSafeConfig(manifest.config);
    return c.json(manifest);
});

// --- Streams: the user's stream add-on, routed through /play -------------

interface PlayPayload {
    v: string;   // video id
    t: string;   // type
    u: string;   // stream URL
    f?: string;  // filename
    s?: number;  // size
    hd?: Record<string, string>; // request headers the stream needs
}

app.get('/:config/stream/:type/:id', async c => {
    const config = parseUserConfig(c.req.param('config'));
    const type = c.req.param('type');
    const id = decodeURIComponent(stripJson(c.req.param('id')));
    if (!config?.streamAddonUrl) return c.json({ streams: [] });

    let upstream: UpstreamStream[] = [];
    try {
        upstream = await fetchUpstreamStreams(config.streamAddonUrl, type, id);
    } catch (e: any) {
        console.warn(`[stream] stream add-on failed for ${id}: ${e.message}`);
        return c.json({ streams: [], cacheMaxAge: 0 });
    }

    const base = `${externalBase(c)}/${c.req.param('config')}`;
    const streams = upstream
        .filter(s => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
        .map(s => {
            const hints = s.behaviorHints || {};
            const token = signPayload({
                v: id, t: type, u: s.url as string,
                f: hints.filename || undefined,
                s: Number(hints.videoSize) || undefined,
                hd: hints.proxyHeaders?.request
            } satisfies PlayPayload);
            const name = typeof s.name === 'string' ? s.name : 'Stream';
            return { ...s, name: `🎓 ${name}`, url: `${base}/play/${token}` };
        });
    console.log(`[stream] ${type} ${id}: wrapped ${streams.length} of ${upstream.length} stream(s)`);
    return c.json({ streams, cacheMaxAge: 0 }, 200, { 'Cache-Control': 'no-store' });
});

// A 🎓 stream: note which file this user is playing, start preparing its
// subtitles, and hand the player the real URL. Players re-open the URL on
// every seek, so this stays a cheap redirect.
app.on(['GET', 'HEAD'], '/:config/play/:token', async c => {
    const config = parseUserConfig(c.req.param('config'));
    const payload = verifyPayload<PlayPayload>(c.req.param('token'));
    if (!config || !payload?.u || !/^https?:\/\//.test(payload.u)) return c.text('invalid link', 400);

    const file: FileHint = { url: payload.u, filename: payload.f, size: payload.s, headers: payload.hd, via: 'play' };
    if (await recordPlay(config.userKey, payload.v, file)) {
        const ids = parseVideoId(payload.t, payload.v);
        if (ids) {
            console.log(`[play] ${payload.v} ${payload.f || ''}`);
            const jctx = jobContext(config);
            keepAlive((async () => {
                const bans = await bansFor(config.userKey, ids.videoId);
                startJob(smartRequest(config, payload.t, ids, file, 1, bans), jctx);
                await logEvent({ kind: 'play', user: config.userKey, pair: jctx.pair, type: payload.t, videoId: ids.videoId, file: fileSummary(file) });
            })());
        }
    }
    return c.redirect(payload.u, 302);
});

// --- Subtitles -------------------------------------------------------------
//
// Smart-Hebrew-Subtitles style: one ★ entry that is always the best the add-on
// knows, alternatives that say what they are, and entries that teach it when
// something is wrong. Nuvio shows each entry's id under the language, so the
// id is the readable name; everything is listed under the translation
// language (the viewer's own, near the top of the list).

type EntryKind = 'star' | 'alt' | 'main' | 'trans' | ReportKind;
const ENTRY_KINDS: readonly EntryKind[] = ['star', 'alt', 'main', 'trans', ...REPORT_KINDS];
const isReport = (e: EntryKind): e is ReportKind => (REPORT_KINDS as readonly string[]).includes(e);

const TIER_BASIS: Record<string, string> = {
    file: 'מסונכרן לקובץ',
    hash: 'מסונכרן לקובץ (טביעת אצבע)',
    consensus: 'לפי רוב הכתוביות',
    guess: 'תזמון משוער'
};

function entryLabels(config: UserConfig, basis: string): Record<EntryKind, string> {
    const main = hebrewLanguageName(config.mainLang);
    const trans = hebrewLanguageName(config.transLang);
    return {
        star: `★ ${main}+${trans} · ${basis}`,
        alt: `↻ ${main}+${trans} · חלופה`,
        main: `${main} בלבד · מסונכרן`,
        trans: `${trans} בלבד · מסונכרן`,
        bad_sync: '⚠ הסנכרון לא טוב · החלף',
        bad_trans: `⚠ ה${trans} לא טובה · החלף`,
        bad_main: `⚠ ה${main} לא טובה · החלף`
    };
}

const PLAY_GRACE_LIST_MS = 2_500;

async function handleSubtitles(c: Context) {
    const config = parseUserConfig(c.req.param('config'));
    const type = c.req.param('type') || 'movie';
    const rawId = stripJson(c.req.param('id'));
    const extra = c.req.param('extra');
    if (!config) return c.json({ subtitles: [] });
    if (config.mainLang === config.transLang) return c.json({ subtitles: [] });

    const ids = parseVideoId(type, rawId);
    if (!ids) return c.json({ subtitles: [] });

    const said = parseExtra(extra);
    const ctx: FileCtx = { f: said.filename, s: said.size, h: said.hash };
    const [file, bans] = await Promise.all([resolveFile(config, ids.videoId, ctx), bansFor(config.userKey, ids.videoId)]);
    const knowsFile = Boolean(file.url || file.filename || file.size || file.hash);
    const jctx = jobContext(config);

    // Start preparing now so the subtitle is ready when it's picked; the
    // alternative right after, on the same downloads.
    const kick = async () => {
        const f = file.via === 'play' ? file : await resolveFileWaiting(config, ids.videoId, ctx, PLAY_GRACE_LIST_MS);
        const star = startJob(smartRequest(config, type, ids, f, 1, bans), jctx);
        await star.done;
        await startJob(smartRequest(config, type, ids, f, 2, bans), jctx).done;
    };
    keepAlive(kick());

    // What ★ is based on: the finished build if there is one, else what is
    // known about the file so far.
    const ready = await peekResult(smartRequest(config, type, ids, file, 1, bans));
    const basis = ready?.srt ? TIER_BASIS[ready.info.tier] || 'תזמון משוער'
        : knowsFile ? 'לפי הקובץ' : 'תזמון משוער';
    const labels = entryLabels(config, basis);

    const base = `${externalBase(c)}/${c.req.param('config')}`;
    const idSeg = encodeURIComponent(ids.videoId);
    const ctxSeg = encodeCtx(ctx);
    const subtitles = ENTRY_KINDS.map(kind => ({
        id: labels[kind],
        url: `${base}/sub/${kind}/${type}/${idSeg}/${ctxSeg}/strelingo-${kind}.srt`,
        lang: config.transLang,
        label: labels[kind]
    }));
    console.log(`[subtitles] ${type} ${ids.videoId} ${config.mainLang}+${config.transLang} file=${file.via || 'unknown'}`);
    keepAlive(logEvent({
        kind: 'list', user: config.userKey, pair: jctx.pair, type, videoId: ids.videoId,
        file: fileSummary(file), entries: subtitles.map(s => s.id), ok: Boolean(ready?.srt)
    }));
    return c.json({ subtitles, cacheMaxAge: 0 }, 200, { 'Cache-Control': 'no-store' });
}

app.get('/:config/subtitles/:type/:id/:extra', handleSubtitles);
app.get('/:config/subtitles/:type/:id', handleSubtitles);

// A subtitle entry. If the build isn't ready yet, keep the connection alive
// with blank lines (SRT parsers skip them) instead of letting the player
// time out; past the deadline, a message that says so (never an unsynced
// guess dressed up as ★).
const SRT_WAIT_MS = Number(process.env.SRT_WAIT_MS || 30_000);
const FIRST_WAIT_MS = 7_000;
const KEEPALIVE_MS = 4_000;
const PLAY_GRACE_SRT_MS = 3_000;

function entryText(out: BuildOutput | null, entry: EntryKind, config: UserConfig): { text: string; ok: boolean } {
    if (!out) return { text: messageSrt(explainText([], config)), ok: false };
    if (!out.srt) return { text: messageSrt(explainText(out.info.notes, config)), ok: false };
    if (entry === 'main') return { text: out.mainSrt || out.srt, ok: true };
    if (entry === 'trans') {
        return out.transSrt
            ? { text: out.transSrt, ok: true }
            : { text: messageSrt(`לא נמצאו כתוביות ב${hebrewLanguageName(config.transLang)} לסרט הזה.`), ok: false };
    }
    return { text: out.srt, ok: true };
}

async function serveEntry(c: Context, entry: EntryKind) {
    const config = parseUserConfig(c.req.param('config'));
    const type = c.req.param('type') || 'movie';
    const ids = parseVideoId(type, c.req.param('id') || '');
    if (!config || !ids) return c.text('invalid subtitle link', 400);

    const t0 = Date.now();
    const jctx = jobContext(config);
    const file = await resolveFileWaiting(config, ids.videoId, decodeCtx(c.req.param('ctx') || '-'), PLAY_GRACE_SRT_MS);

    // "⚠ ... · replace": learn from it, then serve the replacement right away.
    if (isReport(entry)) {
        const r = await applyReport(config.userKey, ids.videoId, entry, 'player');
        console.log(`[report] ${ids.videoId} ${entry}: ${r.outcome}`);
        keepAlive(logEvent({
            kind: 'report', user: config.userKey, pair: jctx.pair, type, videoId: ids.videoId, entry,
            file: fileSummary(file), report: { kind: entry, outcome: r.outcome, id: r.report?.id, bans: r.report?.bans }
        }));
    }
    const bans = await bansFor(config.userKey, ids.videoId);
    const job = startJob(smartRequest(config, type, ids, file, entry === 'alt' ? 2 : 1, bans), jctx);
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

    const finish = (out: BuildOutput | null): string => {
        const { text, ok } = entryText(out, entry, config);
        const waitedMs = Date.now() - t0;
        if (!ok) console.warn(`[srt] ${ids.videoId} ${entry}: nothing ready after ${waitedMs}ms`);
        keepAlive((async () => {
            if (ok && out) await recordServed(config.userKey, ids.videoId, entry, out.info);
            await logEvent({
                kind: 'serve', user: config.userKey, pair: jctx.pair, type, videoId: ids.videoId, entry,
                variant: entry === 'alt' ? 2 : 1, ok, waitedMs, origin: job.origin,
                file: fileSummary(file), info: out?.info, bans,
                message: ok ? undefined : text.split('\n')[2]
            });
        })());
        return text;
    };

    // Most builds finish in a few seconds: answer plainly within the players'
    // read timeout (8–10 s) before falling back to keep-alive lines.
    const quick = await waitForJob(job, FIRST_WAIT_MS);
    if (quick) return c.body(finish(quick), 200, headers);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const deadline = t0 + SRT_WAIT_MS;
            let result: BuildOutput | null = null;
            while (!result && Date.now() < deadline) {
                controller.enqueue(encoder.encode('\n'));
                result = await waitForJob(job, Math.min(KEEPALIVE_MS, Math.max(0, deadline - Date.now())));
            }
            controller.enqueue(encoder.encode(finish(result)));
            controller.close();
        }
    });
    return c.body(stream, 200, headers);
}

app.get('/:config/sub/:entry/:type/:id/:ctx/:name', c => {
    const entry = c.req.param('entry') as EntryKind;
    if (!ENTRY_KINDS.includes(entry)) return c.text('unknown subtitle entry', 404);
    return serveEntry(c, entry);
});

// Links handed out by version 1.0 (players may still hold them).
app.get('/:config/dual/:variant/:type/:id/:ctx/:name', c => serveEntry(c, c.req.param('variant') === '2' ? 'alt' : 'star'));

// --- Activity page ---------------------------------------------------------

registerDashboard(app, VERSION);

app.get('/:config', c => {
    const seg = c.req.param('config');
    if (!parseUserConfig(seg)) return c.notFound();
    return c.redirect(`/${seg}/configure`);
});

export default app;
export { encodeConfig };

if (typeof process !== 'undefined' && process.argv[1]?.includes('src/index')) {
    import('@hono/node-server').then(({ serve }) => {
        const port = parseInt(process.env.PORT || '7000', 10);
        serve({ fetch: app.fetch, port }, info => {
            console.log(`Strelingo Smart running at http://127.0.0.1:${info.port}/configure`);
        });
    }).catch(err => {
        console.error('Failed to start the server. Is @hono/node-server installed?', err);
        process.exit(1);
    });
}
