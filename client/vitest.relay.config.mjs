/**
 * Vitest configuration for the ysync relay's server-side unit tests
 * (scripts/__tests__/, audit A2 iteration 30).
 *
 * Lives in client/ because the relay resolves yjs / vitest from
 * client/node_modules via createRequire (same anchoring as
 * scripts/ysync-server.mjs itself), while the test glob points at the
 * ../scripts/__tests__ directory next to the relay source.
 *
 * Run: cd client && npx vitest run --config vitest.relay.config.mjs
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['../scripts/__tests__/**/*.test.mjs'],
  },
});
