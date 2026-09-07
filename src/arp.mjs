// Replacement for arp(), broken in @strudel/core 1.2.6: arpWith's innerJoin
// yields haps with an undefined value, and strudel catches the resulting throw
// internally, so arp silently produces nothing. collect() and squeezeBind both
// work, so it is rebuilt on those and re-registered over the original.

export const ARP_MODES = {
  up: (v) => v,
  down: (v) => [...v].reverse(),
  updown: (v) => [...v, ...[...v].reverse().slice(1, -1)],
  downup: (v) => [...[...v].reverse(), ...v.slice(1, -1)],
  upanddown: (v) => [...v, ...[...v].reverse()],
  downandup: (v) => [...[...v].reverse(), ...v],
  thumbup: (v) => v.slice(1).flatMap((x) => [v[0], x]),
  pinkyup: (v) => v.slice(0, -1).flatMap((x) => [x, v[v.length - 1]]),
};

export const ARP_MODE_NAMES = Object.keys(ARP_MODES);

export function installArp(core) {
  // arpWith takes a function over the collected haps of each chord
  core.register('arpWith', (fn, pat) =>
    pat.collect().squeezeBind((haps) => {
      const chosen = fn(haps) ?? [];
      const values = chosen.map((h) => (h && typeof h === 'object' && 'value' in h ? h.value : h));
      if (!values.length) return core.silence;
      return core.sequence(...values.map((v) => core.pure(v)));
    }),
  );

  // arp takes a mode name, defaulting to up for anything unrecognised
  core.register('arp', (mode, pat) =>
    pat.collect().squeezeBind((haps) => {
      const values = haps.map((h) => h.value);
      if (!values.length) return core.silence;
      const order = (ARP_MODES[mode] ?? ARP_MODES.up)(values);
      return core.sequence(...order.map((v) => core.pure(v)));
    }),
  );
}
