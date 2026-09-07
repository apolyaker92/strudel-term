// Superdough touches browser globals at module scope, so this has to be
// imported before it. The audio classes are the real thing from
// node-web-audio-api; everything else is an inert stub that exists only so
// module-level feature checks (`typeof window < 'u' && window.addEventListener`)
// don't throw on the way in.
import * as webAudio from 'node-web-audio-api';

for (const [name, value] of Object.entries(webAudio)) {
  if (name !== 'default' && !(name in globalThis)) globalThis[name] = value;
}

const noop = () => {};

globalThis.addEventListener ??= noop;
globalThis.removeEventListener ??= noop;
globalThis.dispatchEvent ??= () => true;
globalThis.postMessage ??= noop;
globalThis.location ??= { href: 'file:///', origin: 'file://', protocol: 'file:' };
globalThis.navigator ??= { userAgent: 'strudel-term' };
globalThis.document ??= {
  createElement: () => ({ style: {} }),
  addEventListener: noop,
  removeEventListener: noop,
  // strudel core dispatches a CustomEvent on every log line; Node 26 defines
  // CustomEvent globally, so the guard passes and this has to be callable
  dispatchEvent: () => true,
  body: { appendChild: noop },
};

// last, so `window` picks up everything assigned above
globalThis.window ??= globalThis;
