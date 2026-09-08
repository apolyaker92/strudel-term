import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const browserTwin = fileURLToPath(new URL('./web/audio-browser.mjs', import.meta.url));

// src/audio.mjs is the terminal backend. It imports node-web-audio-api, a
// native addon that cannot load in a browser and which drags node-fetch in
// behind it, so everything importing it gets the browser twin instead. That
// leaves engine.mjs and tui.mjs untouched.
//
// enforce: 'pre' matters. Without it Vite's own resolver answers './audio.mjs'
// first, this never runs, and the terminal backend ends up in the bundle: the
// build still succeeds and the page dies at runtime on `fs.promises` being
// undefined, which is a long way from the cause.
const browserAudio = {
  name: 'browser-audio',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer) return null;
    if (source === './audio.mjs' && importer.includes('/src/')) return browserTwin;
    // belt and braces: nothing in a browser build should reach the native addon
    if (source === 'node-web-audio-api') return browserTwin;
    return null;
  },
};

export default defineConfig({
  root: 'web',
  // Served from a subdirectory of the site rather than a domain root, so asset
  // URLs have to be relative to it or every chunk 404s.
  base: './',
  plugins: [browserAudio],
  build: { outDir: '../web-dist', emptyOutDir: true },
});
