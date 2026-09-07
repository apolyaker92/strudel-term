// ctranspose and mtranspose are controls here rather than transforms: they set
// a value superdough never reads, so they appear to do nothing. Tidal treats
// them as chromatic and modal transpose, which strudel has as transpose() and
// scaleTranspose(), so they are aliased to those. Diverges from upstream, but
// replaces two inert controls and loses no behaviour.

export function installTransposeAliases(core) {
  core.register('ctranspose', (amount, pat) => pat.transpose(amount));
  core.register('mtranspose', (amount, pat) => pat.scaleTranspose(amount));
}
