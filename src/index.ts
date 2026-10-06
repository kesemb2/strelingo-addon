import 'dotenv/config';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';

import landingTemplate, { type Manifest } from './landingTemplate.js';
import { browserLanguageMap, languageName, languageOptions } from './languages.js';
import { resolveKitsuToImdb } from './kitsuMapping.js';
import { OPTIONAL_PROVIDERS, WYZIE_SOURCES } from './providers.js';
import { encodeConfig, parseUserConfig, signingSource, signPayload, verifyPayload, type UserConfig } from './config.js';
import { fetchUpstreamStreams, type UpstreamStream } from './file/upstream.js';
import { latestPlay, playsShared, recordPlay } from './smart/plays.js';
import { keepAlive, recentBuilds, startJob, waitForJob } from './smart/jobs.js';
import { getStore } from './store.js';
import type { FileHint, SmartRequest } from './smart/pipeline.js';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const ADDON_ID = 'com.kesemb2.strelingo.smart';
const VERSION = '1.0.0';
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

function smartRequest(config: UserConfig, type: string, ids: VideoIds, file: FileHint, variant: 1 | 2): SmartRequest {
    return {
        type, videoId: ids.videoId, imdbId: ids.imdbId, season: ids.season, episode: ids.episode, butaId: ids.butaId,
        mainLang: config.mainLang, transLang: config.transLang, optional: config.optional,
        upstreamUrl: config.streamAddonUrl, file, variant
    };
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

/** The best knowledge of the playing file: a 🎓 play beats what the player said. */
async function resolveFile(config: UserConfig, videoId: string, said: FileCtx): Promise<FileHint> {
    const played = await latestPlay(config.userKey, videoId);
    if (played) return { ...played, hash: played.hash || said.h };
    if (said.f || said.s || said.h) return { filename: said.f, size: said.s, hash: said.h, via: 'request' };
    return {};
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// With a stream add-on configured, a 🎓 play may land a moment after the
// player asks for subtitles: give it a short chance before building blind.
async function resolveFileWaiting(config: UserConfig, videoId: string, said: FileCtx, waitMs: number): Promise<FileHint> {
    let file = await resolveFile(config, videoId, said);
    if (!config.streamAddonUrl || file.via === 'play') return file;
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
        await sleep(250);
        file = await resolveFile(config, videoId, said);
        if (file.via === 'play') break;
    }
    return file;
}

const NOTE_MESSAGES: Array<[string, string]> = [
    ['no_main_language_subtitles', 'no subtitles in the main language were found for this title'],
    ['main_language_downloads_failed', 'the main-language subtitles could not be downloaded right now'],
    ['crash', 'something went wrong while preparing the subtitles']
];

function explainSrt(notes: string[], mainLang: string): string {
    const hit = NOTE_MESSAGES.find(([k]) => notes.some(n => n.startsWith(k)));
    const reason = hit ? hit[1].replace('the main language', languageName(mainLang)).replace('main-language', languageName(mainLang))
        : 'the subtitles are not ready yet — choose this subtitle again in a few seconds';
    return `1\n00:00:01,000 --> 00:00:12,000\nStrelingo: ${reason}.\n`;
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

app.get('/', c => c.redirect('/configure'));

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
            startJob(smartRequest(config, payload.t, ids, file, 1), config.userKey);
        }
    }
    return c.redirect(payload.u, 302);
});

// --- Subtitles -------------------------------------------------------------

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
    const file = await resolveFile(config, ids.videoId, ctx);
    const knowsFile = Boolean(file.url || file.filename || file.size || file.hash);

    // Start preparing now so the subtitle is ready when it's picked.
    const kick = async () => {
        const f = file.via === 'play' ? file : await resolveFileWaiting(config, ids.videoId, ctx, PLAY_GRACE_LIST_MS);
        startJob(smartRequest(config, type, ids, f, 1), config.userKey);
        if (!(f.url || f.filename || f.size || f.hash)) startJob(smartRequest(config, type, ids, f, 2), config.userKey);
    };
    keepAlive(kick());

    const base = `${externalBase(c)}/${c.req.param('config')}`;
    const idSeg = encodeURIComponent(ids.videoId);
    const ctxSeg = encodeCtx(ctx);
    const pair = `${config.mainLang.slice(0, 2).toUpperCase()}+${config.transLang.slice(0, 2).toUpperCase()}`;
    const subtitles = [{
        id: `strelingo-${ids.videoId}-1`,
        url: `${base}/dual/1/${type}/${idSeg}/${ctxSeg}/strelingo.srt`,
        lang: config.mainLang,
        label: `${pair} ★`
    }];
    // Without anything about the file, the best guess can still be another
    // release's timing: offer the runner-up timing too.
    if (!knowsFile && !config.streamAddonUrl) {
        subtitles.push({
            id: `strelingo-${ids.videoId}-2`,
            url: `${base}/dual/2/${type}/${idSeg}/${ctxSeg}/strelingo-alt.srt`,
            lang: config.mainLang,
            label: `${pair} ↻`
        });
    }
    console.log(`[subtitles] ${type} ${ids.videoId} ${config.mainLang}+${config.transLang} file=${file.via || 'unknown'}`);
    return c.json({ subtitles, cacheMaxAge: 0 }, 200, { 'Cache-Control': 'no-store' });
}

app.get('/:config/subtitles/:type/:id/:extra', handleSubtitles);
app.get('/:config/subtitles/:type/:id', handleSubtitles);

// The merged subtitle. If it isn't ready yet, keep the connection alive with
// blank lines (SRT parsers skip them) instead of letting the player time out.
const SRT_WAIT_MS = Number(process.env.SRT_WAIT_MS || 30_000);
const FIRST_WAIT_MS = 7_000;
const KEEPALIVE_MS = 4_000;
const PLAY_GRACE_SRT_MS = 3_000;

app.get('/:config/dual/:variant/:type/:id/:ctx/:name', async c => {
    const config = parseUserConfig(c.req.param('config'));
    const type = c.req.param('type');
    const variant = c.req.param('variant') === '2' ? 2 : 1;
    const ids = parseVideoId(type, c.req.param('id'));
    if (!config || !ids) return c.text('invalid subtitle link', 400);

    const t0 = Date.now();
    const file = await resolveFileWaiting(config, ids.videoId, decodeCtx(c.req.param('ctx')), PLAY_GRACE_SRT_MS);
    const job = startJob(smartRequest(config, type, ids, file, variant), config.userKey);
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

    // Most builds finish in a few seconds: answer plainly within the players'
    // read timeout (8–10 s) before falling back to keep-alive lines.
    const quick = await waitForJob(job, FIRST_WAIT_MS);
    if (quick.final) {
        const srt = quick.out?.srt ?? explainSrt(quick.out?.info.notes || [], config.mainLang);
        return c.body(srt, 200, headers);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const deadline = t0 + SRT_WAIT_MS;
            let result = quick;
            while (!result.final && Date.now() < deadline) {
                controller.enqueue(encoder.encode('\n'));
                result = await waitForJob(job, Math.min(KEEPALIVE_MS, Math.max(0, deadline - Date.now())));
            }
            const srt = result.out?.srt ?? explainSrt(result.out?.info.notes || [], config.mainLang);
            if (!result.final) console.warn(`[srt] ${ids.videoId}: served stage "${result.out?.info.stage || 'none'}" after ${Date.now() - t0}ms`);
            controller.enqueue(encoder.encode(srt));
            controller.close();
        }
    });
    return c.body(stream, 200, headers);
});

// What happened with your recent subtitles: tier (file / hash / consensus),
// which subtitles were picked, how they were fitted, and why not better.
app.get('/:config/status', async c => {
    const config = parseUserConfig(c.req.param('config'));
    if (!config) return c.json({ error: 'invalid configuration' }, 400);
    return c.json({
        languages: `${config.mainLang}+${config.transLang}`,
        streamAddon: Boolean(config.streamAddonUrl),
        sharedState: playsShared() ? getStore().kind : 'memory (this server only)',
        builds: await recentBuilds(config.userKey)
    });
});

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
