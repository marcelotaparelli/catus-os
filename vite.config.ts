import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  // Every browser the pilot supports has native modulepreload: no polyfill to ship.
  plugins: [svelte({ compilerOptions: { discloseVersion: false } })],
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: {
    outDir: 'dist',
    modulePreload: { polyfill: false },
    // Tiny shared files cost more in gzip overhead than they save in splitting.
    rollupOptions: { output: { experimentalMinChunkSize: 5000 } },
  },
});
