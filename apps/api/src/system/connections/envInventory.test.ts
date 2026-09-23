/**
 * Invariant 1 — coverage ratchet. Every env name the API source reads must be
 * classified: in CONNECTION_REGISTRY (shown on the System page) or in
 * INTERNAL_ENV_VARS (deliberately not shown). Fails on unclassified names, on
 * stale names no longer read anywhere, and on names classified twice.
 *
 * Scan: every .ts file under apps/api/src except *.test.ts, src/__tests__/ and this
 * feature's own directory (its status code names env vars on purpose and
 * would otherwise keep stale names alive). Plus every ENV_SCHEMA_KEYS key and
 * every builtin extension enableEnvVar, enumerated from the source of truth.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_SCHEMA_KEYS } from '../../config/validate';
import { BUILTINS } from '../../extensions/builtinRegistry';
import { INTERNAL_ENV_VARS } from './internalEnvVars';
import { CONNECTION_REGISTRY } from './registry';

const SRC_DIR = join(__dirname, '..', '..');
const SELF_DIR = relative(SRC_DIR, __dirname).split(sep).join('/');

const NAME = String.raw`([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])`;

/**
 * Every env read shape the codebase uses. Each regex captures the name in
 * group 1 or 2. Spec invariant 1 lists the first two shapes; the rest were
 * found by the W01 inventory (see the plan's "Ratchet scan shapes" table).
 */
const SCAN_SHAPES: Readonly<Record<string, RegExp>> = {
  // process.env.X, process.env['X'], process.env["X"]
  processEnv: new RegExp(String.raw`\bprocess\.env(?:\.${NAME}|\[\s*['"]${NAME}['"]\s*\])`, 'g'),
  // Literal first (or second, after a prefix/label arg) argument to any helper whose name contains
  // Env/env/Knob/TimeoutMs: envFlag, envInt, envStr, envFloat, getEnvString, positiveIntEnv,
  // cronFromEnv, envString, envHours, parsePositiveIntEnv(LOG_PREFIX, 'X'), resolveMsKnob,
  // parseTransportTimeoutMs, platformEnv, positiveIntFromEnv, readPositiveIntEnv, ...
  envHelper: new RegExp(
    String.raw`(?<![\w$])[\w$]*(?:[Ee]nv|Knob|TimeoutMs)[\w$]*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?['"]${NAME}['"]`,
    'g',
  ),
  // An env object passed around as `env` or `source`: env.X, source.X, env['X'], source?.X
  envAlias: new RegExp(String.raw`(?<![\w$])(?:env|source)(?:\??\.${NAME}|\[\s*['"]${NAME}['"]\s*\])`, 'g'),
  // Helpers that take the env object first: required(source, 'X'), requiredEnum(source, 'X', ...)
  envObjectArg: new RegExp(String.raw`(?<![\w$])[A-Za-z_$][\w$]*\(\s*(?:process\.env|env|source)\s*,\s*['"]${NAME}['"]`, 'g'),
  // Named constants holding an env name: const MAX_ATTEMPTS_ENV = 'X', UNSAFE_DB_ROLE_OPT_OUT_ENV = 'X'
  envNameConst: new RegExp(String.raw`\b[A-Z0-9_]*ENV[A-Z0-9_]*\s*(?::\s*string\s*)?=\s*['"]${NAME}['"]`, 'g'),
};

/**
 * Tokens the scan produces that are not env names. Each must still be produced
 * by the scan (checked below), so this list cannot rot either.
 */
const SCAN_NOISE: Readonly<Record<string, string>> = {
  BUCKET: "suffix in envFor(region, 'BUCKET') (services/artifacts/blobStorage.ts); real names ARTIFACT_S3_BUCKET_{US,EU} are schema keys",
  ENDPOINT: "suffix in envFor(region, 'ENDPOINT') (services/artifacts/blobStorage.ts); real names are schema keys",
  REGION: "suffix in envFor(region, 'REGION') (services/artifacts/blobStorage.ts); real names are schema keys",
  KEY: 'docblock text `env.KEY` in config/validate.ts (ENV_SCHEMA_KEYS comment)',
  X: 'docblock example `process.env.X` (utils/envFloat.ts, routes/installer.ts, ...)',
  SOME_TTL_MINUTES: 'docblock anti-example `process.env.SOME_TTL_MINUTES` in utils/envInt.ts',
};

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    const rel = relative(SRC_DIR, absolute).split(sep).join('/');
    if (entry.isDirectory()) {
      if (rel === '__tests__' || rel === SELF_DIR) return [];
      return productionSourceFiles(absolute);
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

function scanEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const shape of Object.values(SCAN_SHAPES)) {
      for (const match of source.matchAll(shape)) {
        const name = match[1] ?? match[2];
        if (name) names.add(name);
      }
    }
  }
  for (const key of ENV_SCHEMA_KEYS) names.add(key);
  for (const builtin of BUILTINS) names.add(builtin.enableEnvVar);
  return names;
}

const scanned = scanEnvNames();
const registryNames = CONNECTION_REGISTRY.flatMap((entry) => entry.vars.map((v) => v.name));
const registrySet = new Set(registryNames);
const internalNames = Object.keys(INTERNAL_ENV_VARS);

describe('invariant 1: env coverage ratchet', () => {
  it('finds a realistic inventory (guards a broken scan that finds nothing)', () => {
    expect(scanned.size).toBeGreaterThan(500);
    expect(scanned.has('DATABASE_URL')).toBe(true); // process.env.X
    expect(scanned.has('ENABLE_REGISTRATION')).toBe(true); // envFlag('X')
    expect(scanned.has('M365_COMMS_EXECUTOR_URL')).toBe(true); // required(source, 'X')
    expect(scanned.has('AGENT_LOG_RETENTION_BATCH_SIZE')).toBe(true); // parsePositiveIntEnv(PREFIX, 'X')
    expect(scanned.has('BREEZE_WORKSPACE_ENABLED')).toBe(true); // builtin enableEnvVar
  });

  it('includes every ENV_SCHEMA_KEYS key and every builtin enableEnvVar', () => {
    expect(ENV_SCHEMA_KEYS.length).toBeGreaterThan(90);
    expect(BUILTINS.length).toBeGreaterThan(0);
    for (const key of ENV_SCHEMA_KEYS) expect(scanned.has(key), key).toBe(true);
    for (const builtin of BUILTINS) expect(scanned.has(builtin.enableEnvVar), builtin.enableEnvVar).toBe(true);
  });

  it('every env name the API reads is in the registry or INTERNAL_ENV_VARS', () => {
    const unclassified = [...scanned]
      .filter((name) => !registrySet.has(name) && !(name in INTERNAL_ENV_VARS) && !(name in SCAN_NOISE))
      .sort();
    // To fix: add the name to CONNECTION_REGISTRY (operator-facing, secret by
    // default) or to INTERNAL_ENV_VARS with a one-phrase reason.
    expect(unclassified).toEqual([]);
  });

  it('has no stale registry vars (named in the registry but read nowhere)', () => {
    expect(registryNames.filter((name) => !scanned.has(name)).sort()).toEqual([]);
  });

  it('has no stale INTERNAL_ENV_VARS entries', () => {
    expect(internalNames.filter((name) => !scanned.has(name)).sort()).toEqual([]);
  });

  it('classifies no name twice', () => {
    expect(internalNames.filter((name) => registrySet.has(name)).sort()).toEqual([]);
    expect(registryNames.filter((name, i) => registryNames.indexOf(name) !== i)).toEqual([]);
  });

  it('every internal entry carries a reason', () => {
    for (const [name, reason] of Object.entries(INTERNAL_ENV_VARS)) {
      expect(reason.trim().length, name).toBeGreaterThan(3);
    }
  });

  it('SCAN_NOISE tokens are still produced by the scan and are not classified', () => {
    for (const token of Object.keys(SCAN_NOISE)) {
      expect(scanned.has(token), `${token} no longer appears; drop it from SCAN_NOISE`).toBe(true);
      expect(registrySet.has(token) || token in INTERNAL_ENV_VARS, token).toBe(false);
    }
  });
});
