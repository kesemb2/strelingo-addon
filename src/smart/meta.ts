// Title and poster for the activity page, from Stremio's Cinemeta (cached).

import { getJson, setJson } from '../store.js';

export interface VideoMeta {
    name: string;
    poster?: string;
    year?: string;
    episodeTitle?: string;
}

const CINEMETA = 'https://v3-cinemeta.strem.io/meta';
const META_TTL_S = 30 * 24 * 3600;
const MISS_TTL_S = 24 * 3600;

export async function videoMeta(type: string, videoId: string, fetchImpl: typeof fetch = fetch): Promise<VideoMeta | null> {
    const [imdb, season, episode] = videoId.split(':');
    if (!/^tt\d+$/.test(imdb)) return null;
    const key = `meta:${videoId}`;
    const cached = await getJson<VideoMeta | { miss: true }>(key);
    if (cached) return 'miss' in cached ? null : cached;
    try {
        const res = await fetchImpl(`${CINEMETA}/${type === 'series' ? 'series' : 'movie'}/${imdb}.json`, { signal: AbortSignal.timeout(5_000) });
        const meta: any = res.ok ? (await res.json())?.meta : null;
        if (!meta?.name) {
            await setJson(key, { miss: true }, MISS_TTL_S);
            return null;
        }
        const ep = season && Array.isArray(meta.videos)
            ? meta.videos.find((v: any) => String(v.season) === season && String(v.episode ?? v.number) === episode)
            : null;
        const out: VideoMeta = {
            name: String(meta.name),
            poster: typeof meta.poster === 'string' ? meta.poster : undefined,
            year: meta.releaseInfo ? String(meta.releaseInfo) : meta.year ? String(meta.year) : undefined,
            episodeTitle: ep ? String(ep.name || ep.title || '') || undefined : undefined
        };
        await setJson(key, out, META_TTL_S);
        return out;
    } catch {
        return null;
    }
}
