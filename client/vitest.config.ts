/**
 * Vitest configuration for the presentation client's unit suite.
 *
 * Scope: the deterministic pure modules (character math, XP-budget math,
 * broadcast viewport framing, atmosphere normalization) living in
 * src/api, src/render and src/theme. Everything lives under a __tests__
 * directory next to the code it covers; the node environment is enough
 * because none of these modules touch the DOM or WebGL.
 *
 * The Vite app config (vite.config.ts) is deliberately NOT reused: the unit
 * suite must not inherit React/Pixi plugin machinery for pure-math tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Pure functions only — keep the suite fast and side-effect free.
    passWithNoTests: false,
  },
});
