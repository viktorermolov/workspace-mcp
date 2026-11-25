import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// The interface is served by the same process as the API; everything is bundled locally (no CDN).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    // `npm run dev:ui` proxies the API to a locally running service.
    proxy: { '/api': 'http://127.0.0.1:8080', '/.well-known': 'http://127.0.0.1:8080', '/mcp': 'http://127.0.0.1:8080' },
  },
});
