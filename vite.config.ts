import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  root: '.',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  base: './',
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // never inline assets as data: URIs; everything is served from 'self'
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    modulePreload: { polyfill: false },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // the page served by the dev server uses the relay of `npm run relay`
    proxy: { '/wisp/': { target: 'ws://127.0.0.1:8745', ws: true } },
  },
});
