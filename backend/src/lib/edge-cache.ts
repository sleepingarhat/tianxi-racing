/**
 * Small read-through cache for public, aggregate-only JSON GET endpoints.
 *
 * Layers (each optional, failures fall through to compute):
 *   1. per-isolate memory  — works on workers.dev too (where the Cache API is a no-op)
 *   2. caches.default      — per-colo edge cache on the custom domain routes
 *
 * Freshness is tracked by our own x-tx-stored-at header so we can do real
 * stale-while-revalidate: within `freshMs` serve as-is; between `freshMs` and
 * `staleMs` serve the stored copy immediately and refresh in the background.
 * Conditional requests (If-None-Match) get a 304 when the ETag matches.
 */
export type CacheableJson = {
  body: string;
  etag: string;
  /** Cache-Control sent to browsers / downstream caches. */
  cacheControl: string;
  /** false → never stored (e.g. contains a transient read error). */
  cacheable: boolean;
  freshMs: number;
  staleMs: number;
};

type MemoryEntry = CacheableJson & { storedAt: number };
const memory = new Map<string, MemoryEntry>();
const inflight = new Map<string, Promise<CacheableJson>>();
const MEMORY_MAX = 64;

function edgeCache(): Cache | null {
  try {
    const c = (globalThis as any).caches?.default as Cache | undefined;
    return c ?? null;
  } catch {
    return null;
  }
}

export async function jsonEtag(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(hash)).slice(0, 16).map((n) => n.toString(16).padStart(2, '0')).join('');
  return `W/"${hex}"`;
}

const stripWeak = (t: string) => t.trim().replace(/^W\//, '');
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => stripWeak(t) === stripWeak(etag));
}

function respond(request: Request, entry: CacheableJson, state: string): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': entry.cacheControl,
    ETag: entry.etag,
    'X-Tx-Cache': state,
  });
  if (etagMatches(request.headers.get('If-None-Match'), entry.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(entry.body, { status: 200, headers });
}

function remember(key: string, entry: CacheableJson, now: number) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
  memory.set(key, { ...entry, storedAt: now });
}

async function storeEdge(cacheKey: Request, entry: CacheableJson, now: number) {
  const cache = edgeCache();
  if (!cache) return;
  try {
    const stored = new Response(entry.body, {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        // Keep the edge copy for the whole stale window; freshness is decided by x-tx-stored-at.
        'Cache-Control': `public, s-maxage=${Math.max(1, Math.floor(entry.staleMs / 1000))}`,
        ETag: entry.etag,
        'X-Tx-Stored-At': String(now),
        'X-Tx-Client-Cache-Control': entry.cacheControl,
        'X-Tx-Fresh-Ms': String(entry.freshMs),
        'X-Tx-Stale-Ms': String(entry.staleMs),
      },
    });
    await cache.put(cacheKey, stored);
  } catch { /* cache is best-effort */ }
}

async function readEdge(cacheKey: Request): Promise<MemoryEntry | null> {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheKey);
    if (!hit) return null;
    const storedAt = Number(hit.headers.get('X-Tx-Stored-At'));
    if (!Number.isFinite(storedAt)) return null;
    return {
      body: await hit.text(),
      etag: hit.headers.get('ETag') ?? '',
      cacheControl: hit.headers.get('X-Tx-Client-Cache-Control') ?? 'public, max-age=60',
      cacheable: true,
      freshMs: Number(hit.headers.get('X-Tx-Fresh-Ms')) || 0,
      staleMs: Number(hit.headers.get('X-Tx-Stale-Ms')) || 0,
      storedAt,
    };
  } catch {
    return null;
  }
}

export async function cachedJson(opts: {
  request: Request;
  /** Normalised cache identity (path + canonical query). */
  key: string;
  compute: () => Promise<CacheableJson>;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Bypass reads (still refreshes the stored copy). */
  bypass?: boolean;
  now?: number;
}): Promise<Response> {
  const now = opts.now ?? Date.now();
  const origin = (() => { try { return new URL(opts.request.url).origin; } catch { return 'https://cache.invalid'; } })();
  const cacheKey = new Request(`${origin}/__tx_cache/${encodeURIComponent(opts.key)}`, { method: 'GET' });
  const defer = (p: Promise<unknown>) => {
    const safe = p.catch(() => {});
    if (opts.waitUntil) opts.waitUntil(safe);
  };

  const refresh = (): Promise<CacheableJson> => {
    const running = inflight.get(opts.key);
    if (running) return running;
    const p = (async () => {
      const fresh = await opts.compute();
      if (fresh.cacheable) {
        const t = Date.now();
        remember(opts.key, fresh, t);
        await storeEdge(cacheKey, fresh, t);
      } else {
        memory.delete(opts.key);
      }
      return fresh;
    })().finally(() => inflight.delete(opts.key));
    inflight.set(opts.key, p);
    return p;
  };

  if (!opts.bypass) {
    const mem = memory.get(opts.key);
    const candidate = mem ?? (await readEdge(cacheKey));
    if (candidate) {
      const age = now - candidate.storedAt;
      if (age >= 0 && age < candidate.freshMs) {
        if (!mem) remember(opts.key, candidate, candidate.storedAt);
        return respond(opts.request, candidate, mem ? 'HIT-MEMORY' : 'HIT-EDGE');
      }
      if (age >= 0 && age < candidate.staleMs) {
        defer(refresh());
        return respond(opts.request, candidate, 'STALE');
      }
    }
  }
  const fresh = await refresh();
  return respond(opts.request, fresh, 'MISS');
}

/** Test hook. */
export function clearMemoryCache() { memory.clear(); inflight.clear(); }
