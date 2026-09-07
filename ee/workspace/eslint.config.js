import sqlstateGuard from '../../scripts/eslint/no-direct-sqlstate.mjs';
import tsParser from '@typescript-eslint/parser';

// Flat config (ESLint v9+), mirroring packages/shared and apps/api: TS
// parser, latest ESM, and the shared SQLSTATE guard. `ee/` was previously unmatched by
// `pnpm lint` (turbo only runs a package's `lint` script if it defines one,
// and this package didn't) — this file plus the `lint` script below give it
// the same coverage as the rest of the workspace.
export default [
  sqlstateGuard,
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    // Match the prior .eslintrc behavior (flat config defaults this to 'warn').
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {},
  },
];
