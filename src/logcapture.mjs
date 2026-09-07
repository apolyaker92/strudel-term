// Strudel and superdough log to the console on import and while playing, and
// anything written to stdout while the alternate screen is up corrupts the
// display. Intercept console before those modules load (this must be the first
// import in cli.mjs) and keep the lines for the footer instead.
const RING = 40;
const lines = [];
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };

let capturing = true;

function record(level, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : String(a)))
    .join(' ')
    // strudel logs with %c and a CSS argument
    .replace(/%c/g, '')
    .replace(/background-color:[^]*$/, '')
    .trim();
  if (!text) return;
  // strudel reports query failures through console.log, so a plain log line
  // saying "error" still needs to reach the footer
  const effective = level === 'log' && /\berror\b|\bfailed\b|cannot /i.test(text) ? 'warn' : level;
  lines.push({ level: effective, text, at: Date.now() });
  if (lines.length > RING) lines.shift();
}

for (const level of ['log', 'warn', 'error', 'info']) {
  console[level] = (...args) => {
    if (capturing) record(level, args);
    else original[level](...args);
  };
}

export function recentLog(maxAgeMs = 4000) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (Date.now() - lines[i].at < maxAgeMs) return lines[i];
  }
  return null;
}

export function allLogs() {
  return lines.slice();
}

// Called on the way out, so a crash is readable once the screen is back.
export function releaseConsole() {
  capturing = false;
  Object.assign(console, original);
}
