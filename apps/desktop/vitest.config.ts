import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// The renderer suite lives entirely under `src/`. The repo also carries
// `electron/**/*.test.cjs`, `scripts/**/*.test.cjs`, Playwright specs under
// `e2e/`, and node-pty's own tests inside `build/` + `release/` artifacts.
// Vitest's default include glob picks all of them up, which made `npm run
// test:ui` report 46 permanently-failing files that can never pass here and
// buried the real regressions. Narrow discovery to the renderer.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['./src/test-setup.ts'],
      // 167 jsdom files run in parallel; async UI (settings panels, stores that
      // import half the app) routinely needs more than the 5s default on a
      // loaded machine/CI runner. A too-tight default produced false failures
      // (test timed out) that looked like product bugs.
      hookTimeout: 20_000,
      testTimeout: 20_000
    }
  })
)
