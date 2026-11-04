import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  // Every browser the pilot supports has native modulepreload: no polyfill to ship.
  plugins: [svelte({ compilerOptions: { discloseVersion: false } })],
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: {
    outDir: 'dist',
    // About 7 kB less gzip than esbuild on this code, for the same behaviour.
    minify: 'terser',
    terserOptions: {
      ecma: 2020,
      module: true,
      compress: { passes: 2, keep_fargs: false },
      format: { comments: false },
    },
    modulePreload: { polyfill: false },
    // The CSP has no font-src data: and img-src is the only data: exception.
    assetsInlineLimit: 0,
    rollupOptions: {
      // Tiny shared files cost more in gzip overhead than they save in splitting.
      output: {
        experimentalMinChunkSize: 5000,
      },
    },
  },
});
