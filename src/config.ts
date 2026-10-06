// The user's configuration lives in the add-on URL itself (Stremio style):
// https://host/<config>/manifest.json. New links carry it as base64url JSON;
// links from the original Strelingo (URI-encoded JSON) still work.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseLangCode } from './languages.js';
import { parseOptionalProviderConfig, type OptionalProviderConfig } from './providers.js';
import { addonBase } from './file/upstream.js';
import { storeCredential } from './store.js';
import { DEFAULT_MAIN_COLOR, DEFAULT_TRANS_COLOR, parseColor, type LineColors } from './subs/style.js';

export interface UserConfig {
    raw: Record<string, any>;
    mainLang: string;
    transLang: string;
    optional: OptionalProviderConfig;
    /** The user's stream add-on manifest URL (AIOStreams), if given. */
    streamAddonUrl?: string;
    /** Stable, non-reversible id for this configuration (play records, status). */
    userKey: string;
    /** A color per language line (undefined = the player's own). */
    colors: LineColors;
}

export function encodeConfig(obj: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function decodeConfigSegment(segment: string | undefined): Record<string, any> | null {
    if (!segment) return null;
    const s = segment.trim();
    if (/^[A-Za-z0-9_-]+$/.test(s)) {
        try {
            const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
            if (obj && typeof obj === 'object') return obj;
        } catch { /* not base64url JSON */ }
    }
    try {
        const obj = JSON.parse(decodeURIComponent(s));
        if (obj && typeof obj === 'object') return obj;
    } catch { /* not JSON either */ }
    return null;
}

export function parseUserConfig(segment: string | undefined, fallbackTransLang = 'eng'): UserConfig | null {
    const raw = decodeConfigSegment(segment);
    if (!raw) return null;
    const mainLang = parseLangCode(raw.mainLang) || 'eng';
    const transLang = parseLangCode(raw.transLang) || fallbackTransLang;
    const streamAddonUrl = typeof raw.streamAddonUrl === 'string' && addonBase(raw.streamAddonUrl)
        ? raw.streamAddonUrl.trim()
        : undefined;
    return {
        raw,
        mainLang,
        transLang,
        optional: parseOptionalProviderConfig(raw),
        streamAddonUrl,
        userKey: createHash('sha256').update(JSON.stringify(raw)).digest('base64url').slice(0, 16),
        colors: {
            main: parseColor(raw.mainColor, DEFAULT_MAIN_COLOR),
            trans: parseColor(raw.transColor, DEFAULT_TRANS_COLOR)
        }
    };
}

// --- Signing ---------------------------------------------------------------
// A secret every server instance shares: it signs the activity page's login
// cookie.

let secretCache: string | null = null;

export function signingSource(): 'env' | 'store' | 'local' {
    const fromEnv = process.env.SECRET || process.env.SUBTITLE_PAYLOAD_SECRET;
    if (fromEnv && fromEnv.length >= 16) return 'env';
    return storeCredential() ? 'store' : 'local';
}

export function signingSecret(): string {
    if (secretCache) return secretCache;
    const fromEnv = process.env.SECRET || process.env.SUBTITLE_PAYLOAD_SECRET;
    if (fromEnv && fromEnv.length >= 16) return (secretCache = fromEnv);
    // Every instance must sign alike (Vercel runs many): derive the key from
    // the shared store's token, which they all have.
    const credential = storeCredential();
    if (credential) {
        return (secretCache = createHmac('sha256', 'strelingo-play-links').update(credential).digest('base64url'));
    }
    // A single server without a store: keep a random secret in the data
    // directory so links survive restarts where the disk does.
    const dir = process.env.DATA_DIR || './data';
    const file = path.join(dir, 'secret');
    try {
        const existing = readFileSync(file, 'utf8').trim();
        if (existing.length >= 32) return (secretCache = existing);
    } catch { /* first run */ }
    const generated = randomBytes(32).toString('base64url');
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, generated, { mode: 0o600 });
    } catch (e: any) {
        console.warn(`[config] could not store a signing secret in ${dir} (${e.message}); activity-page logins will end on restart. Set SECRET.`);
    }
    return (secretCache = generated);
}
