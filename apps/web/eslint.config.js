import sqlstateGuard from '../../scripts/eslint/no-direct-sqlstate.mjs';
import tsParser from '@typescript-eslint/parser';

// Flat config (ESLint v9+). Mirrors the previous .eslintrc.cjs: TS parser
// with JSX, latest ESM, and the shared SQLSTATE guard.
export default [
  sqlstateGuard,
  { ignores: ['dist/**', '.astro/**', 'node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    // Match the prior .eslintrc behavior (flat config defaults this to 'warn').
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {},
  },
];
