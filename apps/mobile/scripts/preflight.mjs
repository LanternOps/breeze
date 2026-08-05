#!/usr/bin/env node
/**
 * Pre-archive check for release builds of the Breeze RMM mobile app.
 *
 * Everything this guards is a SILENT failure: the app boots fine, passes review,
 * and only misbehaves in ways nobody can see from a TestFlight install.
 *
 *   - No Sentry DSN  → zero crash/error telemetry, and the app's many
 *     `captureMessage` calls for otherwise-invisible failures go nowhere.
 *   - localhost API  → every request fails on a real device.
 *
 * The Sentry auth token is the exception: a missing one is NOT silent, it fails
 * the Xcode Archive from inside a build phase. It is checked here anyway so the
 * problem surfaces in a terminal with a fixable message, rather than 10 minutes
 * into an archive as `error: sentry-cli`.
 *
 * Run before `expo prebuild` / Xcode Archive:  pnpm --filter breeze-mobile preflight
 *
 * Checks run only for release builds. Pass `--dev` (or set BREEZE_MOBILE_DEV=1)
 * to downgrade failures to warnings for a local build.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isDev = process.argv.includes('--dev') || process.env.BREEZE_MOBILE_DEV === '1';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal `KEY=value` reader. Enough for our own files; not a dotenv clone. */
function readDotenv(name) {
  const path = resolve(projectRoot, name);
  if (!existsSync(path)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Read the same files the real build reads, rather than requiring the caller to
 * source them first. Neither is loaded from the shell in a real build: Expo
 * loads `.env` when it bundles, and `sentry-xcode.sh` loads
 * `.env.sentry-build-plugin` itself — Xcode build phases do not inherit an
 * interactive shell's environment. A preflight that only looked at `process.env`
 * would report failures for a perfectly configured machine, which trains people
 * to ignore it.
 *
 * Real environment variables still win, so CI can override either file.
 */
const fileEnv = { ...readDotenv('.env'), ...readDotenv('.env.sentry-build-plugin') };
const env = (name) => process.env[name] || fileEnv[name];

const uploadDisabled =
  env('SENTRY_DISABLE_AUTO_UPLOAD') === 'true' || env('SENTRY_ALLOW_FAILURE') === 'true';

/** @type {{ name: string, value: string | undefined, problem: (v: string | undefined) => string | null }[]} */
const checks = [
  {
    name: 'EXPO_PUBLIC_SENTRY_DSN',
    value: env('EXPO_PUBLIC_SENTRY_DSN'),
    problem: (v) =>
      !v
        ? 'not set — the build will ship with crash and error reporting disabled, silently'
        : null,
  },
  {
    name: 'EXPO_PUBLIC_API_URL',
    value: env('EXPO_PUBLIC_API_URL'),
    problem: (v) => {
      if (!v) return 'not set — the app falls back to http://localhost:3001 until a server is picked';
      if (/localhost|127\.0\.0\.1/.test(v)) return `points at ${v}, which no device can reach`;
      if (v.startsWith('http://')) return `uses plaintext http (${v}); iOS ATS will block it`;
      return null;
    },
  },
  {
    name: 'SENTRY_AUTH_TOKEN',
    value: env('SENTRY_AUTH_TOKEN'),
    problem: (v) => {
      if (v) return null;
      if (uploadDisabled) return null; // upload deliberately turned off
      return (
        'not found in the environment or .env.sentry-build-plugin — the Xcode ' +
        'Archive will fail in the "Bundle React Native code and images" phase. ' +
        'Copy .env.sentry-build-plugin.example and fill it in, or set ' +
        'SENTRY_DISABLE_AUTO_UPLOAD=true to build without symbolication'
      );
    },
  },
];

const failures = [];
for (const check of checks) {
  const problem = check.problem(check.value);
  if (problem) failures.push(`${check.name} ${problem}`);
}

if (failures.length === 0) {
  console.log('preflight: OK');
  process.exit(0);
}

const label = isDev ? 'warning' : 'ERROR';
for (const f of failures) console.error(`preflight ${label}: ${f}`);

if (isDev) {
  console.error('\npreflight: continuing anyway (--dev).');
  process.exit(0);
}

console.error(
  '\npreflight: refusing to build. Set the variables above (see .env.example), ' +
    'or pass --dev for a local build you do not intend to ship.'
);
process.exit(1);
