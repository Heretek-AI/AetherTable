import { existsSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * @3d-dice/dice-box lazily does `import('./world.offscreen.js')` for its
 * offscreen rendering worker. That dist file is a *prebuilt*, self-contained
 * bundle (~1.4 MB: three.js plus an embedded base64 worker payload) and a
 * single Rollup module, so it cannot be split by `manualChunks`. We mark it
 * external so Rollup emits the dynamic import verbatim instead of hashing it
 * into a >900 kB chunk, and copy the pristine (already-minified) file into
 * `dist/assets/` so the runtime-relative import keeps resolving.
 */
const DICE_OFFSCREEN_BASENAME = 'world.offscreen.js';
// Root-absolute URL path: immune to Rollup re-relativizing specifiers
// against the importing chunk's directory (dist/assets/).
const DICE_OFFSCREEN_SPECIFIER = `/assets/${DICE_OFFSCREEN_BASENAME}`;
const isDiceOffscreenWorker = (id: string): boolean => id.endsWith(`/${DICE_OFFSCREEN_BASENAME}`);

/**
 * Copies dice-box's prebuilt offscreen worker into the build output.
 * The emitted specifier is relative to the importing chunk (`/assets/`),
 * which is exactly where this hook drops the file.
 */
function copyDiceOffscreenWorker(): Plugin {
  return {
    name: 'copy-dice-offscreen-worker',
    closeBundle() {
      const src = join(rootDir, 'node_modules/@3d-dice/dice-box/dist/world.offscreen.min.js');
      const dest = resolve(rootDir, 'dist/assets/world.offscreen.js');
      if (existsSync(src)) {
        cpSync(src, dest);
      } else {
        throw new Error(
          `[copy-dice-offscreen-worker] missing ${src}; check the @3d-dice/dice-box install`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    copyDiceOffscreenWorker(),
  ],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api/v1': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8088',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      external: isDiceOffscreenWorker,
      output: {
        // Pin the emitted specifier for the externalized worker so it stays
        // relative to the importing chunk in dist/assets/ (Rollup otherwise
        // re-relativizes externals back into node_modules/, which will not
        // exist in a deployed bundle).
        paths(id: string): string {
          return isDiceOffscreenWorker(id) ? DICE_OFFSCREEN_SPECIFIER : id;
        },
        // Split heavy vendors into cacheable chunks so application code and
        // vendor code evolve independently. dice-box is intentionally NOT
        // assigned here: it already loads through dynamic import() chunks.
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          if (/[/\\]node_modules[/\\](pixi\.js|@pixi[/\\])/.test(id)) return 'vendor-pixi';
          if (/[/\\]node_modules[/\\](yjs|y-websocket|y-indexeddb|lib0)[/\\]/.test(id)) {
            return 'vendor-yjs';
          }
          if (/[/\\]node_modules[/\\](react|react-dom|scheduler|lucide-react)[/\\]/.test(id)) {
            return 'vendor-react';
          }
          // Opt-in on-device speech-to-text (iteration-39): transformers.js +
          // ONNX Runtime Web load lazily behind VITE_ENABLE_BROWSER_STT; keep
          // them out of the chunks every page load fetches.
          if (
            /[/\\]node_modules[/\\](@huggingface[/\\]|onnxruntime[^/\\]*)/.test(id)
          ) {
            return 'vendor-stt';
          }
          return undefined;
        },
      },
    },
  },
});
