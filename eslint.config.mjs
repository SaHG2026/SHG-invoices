import next from 'eslint-config-next';

/**
 * ESLint, in flat config.
 *
 * ---------------------------------------------------------------------------
 * Why this file appeared during the Next 16 upgrade
 *
 * `next lint` was REMOVED in 16, and the `eslint` option in `next.config` went
 * with it. `npm run lint` would simply have failed.
 *
 * There was never an `.eslintrc` here — `next lint` creates one on first run
 * and nobody had run it — so nothing was migrated. This is the smallest config
 * that keeps the capability rather than letting a security upgrade quietly
 * delete one, which is the sort of thing that is only noticed much later.
 *
 * Flat config rather than the legacy format because `@next/eslint-plugin-next`
 * now defaults to it, and ESLint 10 drops legacy support entirely.
 * ---------------------------------------------------------------------------
 *
 * Note what this is NOT: the check that guards this project. That is
 * `tsc --noEmit` and 987 tests under three timezones (HANDOFF §3). Lint is a
 * second opinion, not the gate.
 */
export default [
  ...next,

  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'public/sw.js',
      /*
       * Build output and generated artefacts only. Nothing in `app/`,
       * `components/`, `lib/` or `test/` is excluded — an ignore list that
       * grows to cover the code is a linter that has been switched off one
       * directory at a time.
       */
    ],
  },
];
