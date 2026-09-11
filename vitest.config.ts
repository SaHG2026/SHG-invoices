import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],

    /*
     * ---------------------------------------------------------------------
     * The intermittent failure, finally diagnosed. HANDOFF §7 item 8.
     *
     * For a year this was recorded as a timezone problem, then disproved as
     * one, and left as "timing under load, never captured". It is captured:
     * **every failure is `Test timed out in 5000ms` and never once an
     * assertion.**
     *
     * The evidence, all of it pointing the same way:
     *
     *   * the failing tests take 5-11 SECONDS in the suite and milliseconds
     *     on their own
     *   * `mark-paid`, `week-view`, `pending` and `dashboard` are hit hardest,
     *     and they are the four files that render 40-60 invoice rows
     *   * which tests fail changes between runs, on the same commit
     *   * the machine is idle and has 16 cores — the suite saturates itself,
     *     spawning one jsdom per file across every worker at once
     *
     * So 5000ms is not a budget anybody chose for this suite. It is Vitest's
     * generic default for a unit test, and these are full React trees with a
     * QueryClient and sixty rows, sixteen at a time.
     *
     * **This hides nothing.** A timeout is not an assertion, every one of
     * these passes alone, and not a single expectation has been relaxed — if
     * the code under test breaks, the assertion still fails and no timeout
     * saves it. What changes is that losing a scheduling race is no longer
     * reported as a broken payment run.
     *
     * Generous rather than tight on purpose: the number exists to absorb
     * contention, and a slower machine than this one should not have to
     * rediscover the whole investigation.
     *
     * `vmThreads` was tried first, as Vitest's own hint suggests. It creates
     * one environment per worker instead of per file, and it broke
     * `pin-storage.test.ts` outright — a `node:vm` context does not carry the
     * real `localStorage` and `crypto` those tests are about. Rejected.
     * ---------------------------------------------------------------------
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
