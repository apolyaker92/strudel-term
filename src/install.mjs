// Everything we add to strudel's vocabulary, in one place.
//
// These were installed separately by engine.mjs, smoke.mjs and bounce.mjs, and
// each new one had to be remembered in three files. Adding .visualizer() to the
// shipped examples broke the smoke test and the bounce for exactly that reason.

import { installArp } from './arp.mjs';
import { installTransposeAliases } from './aliases.mjs';
import { installVisualizer } from './visualizers.mjs';

export function installExtensions(core) {
  // replaces core's arp, which throws inside the query in 1.2.6
  installArp(core);
  // and the two transposes, which are inert controls in this version
  installTransposeAliases(core);
  // .visualizer() has to exist for the code to evaluate; it returns the
  // pattern untouched and the drawing is worked out from the source
  installVisualizer(core);
}
