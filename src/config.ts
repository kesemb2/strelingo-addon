// The user's configuration lives in the add-on URL itself (Stremio style):
// https://host/<config>/manifest.json. New links carry it as base64url JSON;
// links from the original Strelingo (URI-encoded JSON) still work.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseLangCode } from './languages.js';
import { parseOptionalProviderConfig, type OptionalProviderConfig } from './providers.js';
import { addonBase } from './file/upstream.js';
import { storeCredential } from './store.js';

export interface UserConfig {
    raw: Record<string, any>;
    mainLang: string;
    transLang: string;
    optional: OptionalProviderConfig;
    /** The user's stream add-on manifest URL (AIOStreams), if given. */
    streamAddonUrl?: string;
    /** Stable, non-reversible id for this configuration (play records, status). */
    userKey: string;
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
        userKey: createHash('sha256').update(JSON.stringify(raw)).digest('base64url').slice(0, 16)
    };
}

// --- Signing ---------------------------------------------------------------
// /play links carry the real stream URL; they are signed so the add-on can't
// be used to redirect to, or probe, arbitrary URLs.

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
        console.warn(`[config] could not store a signing secret in ${dir} (${e.message}); /play links will break on restart. Set SECRET.`);
    }
    return (secretCache = generated);
}

function mac(data: string): string {
    return createHmac('sha256', signingSecret()).update(data).digest('base64url');
}

export function signPayload(payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${mac(body)}`;
}

export function verifyPayload<T>(token: string): T | null {
    const [body, sig, extra] = (token || '').split('.');
    if (!body || !sig || extra !== undefined || token.length > 16_384) return null;
    const expected = Buffer.from(mac(body));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    } catch {
        return null;
    }
}
