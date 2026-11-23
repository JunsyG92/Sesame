import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Strict Content-Security-Policy injected in both HTML pages. The development
 * server needs inline scripts (React refresh) and a websocket (HMR); production
 * builds get the strict policy only.
 */
function contentSecurityPolicy(): Plugin {
  const strict = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ');
  const dev = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws:",
  ].join('; ');
  let serving = false;
  return {
    name: 'sesame-csp',
    configResolved(config) {
      serving = config.command === 'serve';
    },
    transformIndexHtml(html) {
      return html.replace('%CSP%', serving ? dev : strict);
    },
  };
}

export default defineConfig({
  main: {
    build: { outDir: 'out/main' },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // A sandboxed preload cannot `require` node_modules: bundle everything.
      externalizeDeps: false,
      rolldownOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    build: {
      outDir: 'out/renderer',
      rolldownOptions: {
        input: {
          launcher: path.resolve('src/renderer/launcher/index.html'),
          manager: path.resolve('src/renderer/manager/index.html'),
        },
      },
    },
  },
});
