import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const pwaFiles = [
  'sw.js',
  'manifest.json',
  'js/core.js',
  'js/db.js',
  'js/repository.js',
  'js/supabase.js',
  'js/vendor/supabase.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png'
];

/** Keep the service worker and manifest at stable root URLs in production. */
function emitPwaFiles() {
  return {
    name: 'spendly-pwa-files',
    apply: 'build',
    generateBundle() {
      for (const fileName of pwaFiles) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: readFileSync(path.join(root, fileName))
        });
      }
    }
  };
}

export default defineConfig({
  // Keep the existing source tree and relative app paths; the build plugin
  // emits files that need stable names for the PWA shell.
  base: './',
  publicDir: false,
  plugins: [emitPwaFiles()],
  build: {
    rollupOptions: {
      output: {
        // The HTML module is the sole JS entry; keep its public URL stable so
        // the service worker's source and built app shells use the same path.
        entryFileNames: 'js/app.js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: asset => asset.name?.endsWith('.css')
          ? 'css/app.css'
          : 'assets/[name]-[hash][extname]'
      }
    }
  }
});
