// Slider positions, sends and tempo, remembered per file. Keyed by absolute
// path in the cache directory rather than a sidecar, so a jam folder stays
// clean; renaming a file loses its positions. Each entry records the path it
// came from, without which the directory is unprunable hashes that only grow.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { writeAtomic } from './atomic.mjs';
import { join } from 'node:path';
import { CACHE_DIR } from './samples.mjs';

const STATE_DIR = join(CACHE_DIR, 'state');

// A pattern whose file is missing might be on a volume that is merely
// unmounted, so give it a grace period before assuming it is gone for good.
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Files written before the path wrapper cannot be attributed to a pattern, so
// there is no way to tell a dead one from a jam that has not been opened in a
// while. Deleting those on the orphan schedule would quietly throw away the
// slider positions of anything untouched for a week, so they get a much longer
// rope. Opening a pattern rewrites its entry in the tagged format, so this pile
// drains on its own as files get used.
const UNTAGGED_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

export function stateFileFor(path) {
  return join(STATE_DIR, `${createHash('sha256').update(path).digest('hex')}.json`);
}

export function load(path) {
  try {
    const file = stateFileFor(path);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    // Files written before the wrapper existed are the bare state object.
    if (parsed.state && typeof parsed.state === 'object') return parsed.state;
    return parsed;
  } catch {
    // a corrupt or unreadable state file is not worth interrupting startup for
    return null;
  }
}

export function save(path, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeAtomic(stateFileFor(path), JSON.stringify({ path, state }, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Drop entries for patterns that no longer exist. Untagged files predate the
// wrapper and cannot be attributed to anything, so they go once they are old
// enough that nothing is likely to still want them.
export function prune(dir = STATE_DIR, now = Date.now()) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const full = join(dir, entry.name);
    try {
      const age = now - statSync(full).mtimeMs;
      if (age < ORPHAN_GRACE_MS) continue;
      const parsed = JSON.parse(readFileSync(full, 'utf8'));
      const source = parsed && typeof parsed === 'object' ? parsed.path : null;
      if (typeof source !== 'string') {
        if (age < UNTAGGED_GRACE_MS) continue;
      } else if (existsSync(source)) {
        continue;
      }
      rmSync(full, { force: true });
      removed += 1;
    } catch {
      // unreadable or vanished; leave it rather than guessing
    }
  }
  return removed;
}
