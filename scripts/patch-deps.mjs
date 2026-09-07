// @strudel/core does `import { SalatRepl } from '@kabelsalat/web'`, but that
// package's "main" points at a Vite bundle with no ESM exports, so Node picks
// it and the import throws "does not provide an export named 'SalatRepl'".
// The sibling dist/index.mjs is a real ES module and loads fine. Repoint it.
//
// Upstream bug, not ours. Delete this once @kabelsalat/web ships an exports map.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Node's own resolution first, so a hoisted install is found wherever it landed,
// then the sibling directory for the ordinary nested layout.
function locate() {
  try {
    return createRequire(import.meta.url).resolve('@kabelsalat/web/package.json');
  } catch {
    const nested = fileURLToPath(
      new URL('../node_modules/@kabelsalat/web/package.json', import.meta.url),
    );
    return existsSync(nested) ? nested : null;
  }
}

const pkgPath = locate();

if (!pkgPath) {
  console.log('[patch-deps] @kabelsalat/web not installed, nothing to do');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.main === 'dist/index.mjs' && pkg.exports) {
  console.log('[patch-deps] @kabelsalat/web already patched');
  process.exit(0);
}

pkg.main = 'dist/index.mjs';
// ./package.json stays reachable, or the resolve above cannot find this file
// again once an exports map is in place and the patch stops being idempotent
pkg.exports = {
  '.': { import: './dist/index.mjs', default: './dist/index.mjs' },
  './package.json': './package.json',
};
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('[patch-deps] repointed @kabelsalat/web at its ESM build');
