// Write a file without ever leaving a half-written one behind. writeFileSync
// truncates and then fills, so an interruption shortens the file: lost work for
// a source file, and silent corruption for a cached sample, which nothing
// revalidates. Writing beside the target and renaming is atomic on the same
// filesystem.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

export function writeAtomic(path, data) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, path);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      // the temp file may not exist; the original error is what matters
    }
    throw err;
  }
}

/**
 * Does the file still hold what we last read or wrote? Decides whether writing
 * would overwrite someone else's work. Unreadable or missing counts as a match:
 * there is nothing to preserve, and the write reports its own failure.
 */
export function diskMatches(path, expected) {
  try {
    return readFileSync(path, 'utf8') === expected;
  } catch {
    return true;
  }
}
