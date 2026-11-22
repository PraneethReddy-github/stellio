import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { buildCsp, CSP_NONCE_TOKEN } from './src/shared/csp';

const alias = {
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src'),
};

// Injects the Content-Security-Policy meta tag: strict in production, relaxed for Vite HMR in dev.
function cspPlugin(): Plugin {
  let dev = false;
  return {
    name: 'stellio-csp',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml(html) {
      return html
        .replace('%STELLIO_CSP%', buildCsp(dev))
        .replace('%STELLIO_NONCE%', dev ? '' : CSP_NONCE_TOKEN);
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
    // Sandboxed preloads cannot require node_modules, so everything is bundled.
    build: { externalizeDeps: false },
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), cspPlugin()],
  },
});
