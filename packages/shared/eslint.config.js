import tsParser from '@typescript-eslint/parser';

// Flat config (ESLint v9+). Mirrors the previous .eslintrc.cjs: TS parser,
// latest ESM, no custom rules yet.
export default [
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
