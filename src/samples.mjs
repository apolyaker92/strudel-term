import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { writeAtomic } from './atomic.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_BANK = 'github:tidalcycles/dirt-samples';
export const CACHE_DIR =
  process.env.STRUDEL_TERM_CACHE ?? join(homedir(), '.cache', 'strudel-term');

// Every sample is a separate GitHub request, 40 to 200ms each, and superdough
// fetches them lazily on first trigger. Waiting for that mid-performance is
// exactly what you do not want, so cache the bytes on disk: the second run is
// local and works with no network at all.
// The cache only grows: every sample ever heard stays. That is the point, but
// it should be inspectable and clearable rather than a mystery directory.
export function cacheSize(dir = CACHE_DIR) {
  let bytes = 0;
  let files = 0;
  // skip state/, so this number matches what --clear-cache would free
  const skip = join(dir, 'state');
  const walk = (path) => {
    if (path === skip) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          bytes += statSync(full).size;
          files += 1;
        } catch {
          // vanished between listing and stat; not worth failing over
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

export function clearCache(dir = CACHE_DIR) {
  let bytes = 0;
  let files = 0;
  try {
    // the saved slider and track positions live under state/ and are not
    // samples, so they survive, and they are not counted as freed either
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      rmSync(full, { force: true });
      bytes += size;
      files += 1;
    }
  } catch {
    // nothing to clear
  }
  return { bytes, files };
}

export function installFetchCache(dir = CACHE_DIR) {
  const realFetch = globalThis.fetch;
  if (!realFetch || realFetch.strudelTermCached) return { hits: 0, misses: 0 };

  const stats = { hits: 0, misses: 0 };
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return stats; // no cache dir, fall back to plain fetch
  }

  const cachedFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    const method = init?.method ?? (typeof input === 'object' ? input?.method : 'GET') ?? 'GET';
    if (!url || method !== 'GET') return realFetch(input, init);

    const file = join(dir, createHash('sha256').update(url).digest('hex'));
    if (existsSync(file)) {
      stats.hits++;
      return new Response(readFileSync(file));
    }

    const response = await realFetch(input, init);
    if (!response.ok) return response;

    const body = Buffer.from(await response.clone().arrayBuffer());
    stats.misses++;
    try {
      // atomic: a half-written cache entry would be served as a corrupt sample
      // for every later run, since nothing revalidates what is already there
      writeAtomic(file, body);
    } catch {
      // cache is best effort
    }
    return new Response(body, { status: response.status });
  };

  cachedFetch.strudelTermCached = true;
  globalThis.fetch = cachedFetch;
  return stats;
}
