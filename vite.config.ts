import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  // Every browser the pilot supports has native modulepreload: no polyfill to ship.
  plugins: [svelte({ compilerOptions: { discloseVersion: false } })],
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: {
    outDir: 'dist',
    modulePreload: { polyfill: false },
    // The CSP has no font-src data: and img-src is the only data: exception.
    assetsInlineLimit: 0,
    rollupOptions: {
      // Tiny shared files cost more in gzip overhead than they save in splitting.
      output: {
        experimentalMinChunkSize: 5000,
        // src/server/http.ts serves only /assets/*.js and *.css. Fonts keep their
        // bytes under an extension it accepts; browsers ignore the MIME of a font.
        // See docs/DESIGN_SYSTEM.md before changing this.
        assetFileNames: (asset) =>
          asset.names[0]?.endsWith('.woff2')
            ? 'assets/[name]-[hash].woff2.css'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
