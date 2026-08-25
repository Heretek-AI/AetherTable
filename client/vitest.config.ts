/**
 * Vitest configuration for the presentation client's unit suite.
 *
 * Scope: the deterministic pure modules (character math, XP-budget math,
 * broadcast viewport framing, atmosphere normalization) living in
 * src/api, src/render and src/theme. Everything lives under a __tests__
 * directory next to the code it covers; the node environment is enough
 * because none of these modules touch the DOM or WebGL.
 *
 * Iteration 68: component-contract tests (StreamerView) render through
 * happy-dom. Vitest 4 removed `environmentMatchGlobs`, so a file opts in
 * per-file with the `@vitest-environment happy-dom` docblock; every other file
 * stays on the fast node environment.
 *
 * The Vite app config (vite.config.ts) is deliberately NOT reused: the unit
 * suite must not inherit React/Pixi plugin machinery for pure-math tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `**/*.tsx` fails to match under tinyglobby here, so the DOM suite is
    // pinned explicitly by its `.dom.tsx` suffix.
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/*.test.dom.tsx'],
    // Pure functions only — keep the suite fast and side-effect free.
    passWithNoTests: false,
  },
});
