// Per orbit flanger inserts for .flanger(), shared by the terminal audio layer
// and its browser twin. Nothing here is node or browser specific: it is the
// same Web Audio graph surgery either way, and keeping one copy is why. The
// twin drifted once already and cost a silent browser.

import { createInsert, BUS_PRESETS } from './buseffects.mjs';

// Whatever superdough currently has feeding the orbit's output. Normally that
// is the summing node; a pattern using .djf() gets a worklet spliced in on
// first use, and getDjf() calls summingNode.disconnect() to do it. An insert
// hung off the summing node is silently cut by that call, measured as exactly
// zero signal at the insert afterwards, so the tail is looked up every time
// rather than assumed once.
const outputSourceOf = (bus) => bus.djfNode ?? bus.summingNode;

/**
 * @param getContext  the live AudioContext, or null before audio starts
 * @param getDough    the superdough module, or null
 */
export function createOrbitInserts({ getContext, getDough }) {
  const inserts = new Map();
  let mixes = new Map();

  return {
    setFlangers(specs) {
      mixes = new Map(specs.map(({ orbit, mix }) => [orbit, mix]));
      for (const [orbit, hung] of inserts) {
        // an orbit no longer asked for goes dry rather than being torn out of
        // a graph that superdough still owns
        hung.insert.setMix(mixes.get(orbit) ?? 0);
      }
    },

    // An orbit only exists once something has played on it, so this runs from
    // trigger() rather than when the code is evaluated.
    ensure(orbit) {
      if (orbit == null || !mixes.has(orbit)) return;
      const ctx = getContext();
      const bus = getDough()?.getSuperdoughAudioController?.()?.getOrbit?.(orbit, [0, 1]);
      if (!ctx || !bus?.summingNode || !bus?.output) return;
      const source = outputSourceOf(bus);
      const hung = inserts.get(orbit);
      if (hung?.source === source) return;
      try {
        // reuse the insert when only the node in front of it changed, so a
        // .djf() appearing mid pattern does not restart the flanger's LFO
        const insert = hung?.insert ?? createInsert(ctx, BUS_PRESETS.flanger);
        source.disconnect();
        source.connect(insert.input);
        insert.output.disconnect();
        insert.output.connect(bus.output);
        insert.setMix(mixes.get(orbit));
        inserts.set(orbit, { insert, source });
      } catch {
        // superdough owns this graph; if its shape has changed, leave it alone
      }
    },
  };
}
