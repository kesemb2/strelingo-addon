// fetch() for URLs that come from user configuration or third parties (the
// stream add-on, the playing file). Redirects are followed by hand so every
// hop is checked: anyone can craft a config, and a public server could
// otherwise redirect the add-on into its own network (SSRF).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * False for localhost, private and link-local addresses — unless
 * ALLOW_PRIVATE_ADDRESSES=true (a self-hosted add-on next to a LAN AIOStreams).
 */
export function isPublicHost(hostname: string): boolean {
    if (process.env.ALLOW_PRIVATE_ADDRESSES === 'true') return true;
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
    }
    if (host.includes(':')) {
        return !(host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
            || host.startsWith('fe80:') || host.startsWith('::ffff:'));
    }
    return true;
}

const MAX_REDIRECTS = 8;

export class BlockedAddressError extends Error {
    readonly reason = 'private_address';
    constructor(host: string) {
        super(`refusing to fetch a private address (${host})`);
    }
}

type Resolver = (host: string) => Promise<Array<{ address: string }>>;
const systemResolver: Resolver = host => lookup(host, { all: true });

/** A public host name that also resolves only to public addresses. */
export async function assertPublic(url: URL, resolve: Resolver = systemResolver): Promise<void> {
    if (process.env.ALLOW_PRIVATE_ADDRESSES === 'true') return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!isPublicHost(host)) throw new BlockedAddressError(host);
    if (isIP(host)) return;
    let addresses: Array<{ address: string }> = [];
    try {
        addresses = await resolve(host);
    } catch {
        return; // unresolvable: the fetch itself will fail
    }
    for (const { address } of addresses) {
        if (!isPublicHost(address)) throw new BlockedAddressError(host);
    }
}

export async function safeFetch(
    input: string,
    init: RequestInit = {},
    fetchImpl: typeof fetch = fetch
): Promise<Response> {
    let url = new URL(input);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BlockedAddressError(url.protocol);
        await assertPublic(url);
        const res = await fetchImpl(url.toString(), { ...init, redirect: 'manual' });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
            await res.body?.cancel().catch(() => undefined);
            url = new URL(location, url);
            continue;
        }
        return res;
    }
    throw new Error('too many redirects');
}
