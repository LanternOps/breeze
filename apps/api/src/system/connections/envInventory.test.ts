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
import { describe, expect, it } from 'vitest';
import { ENV_SCHEMA_KEYS } from '../../config/validate';
import { BUILTINS } from '../../extensions/builtinRegistry';
import { SCAN_NOISE, scanApiEnvNames } from './envScan';
import { INTERNAL_ENV_VARS } from './internalEnvVars';
import { CONNECTION_REGISTRY } from './registry';

// The scan itself (shapes, noise tokens, file walk) lives in ./envScan so the
// compose coverage guard (config/envReadComposeCoverage.test.ts, #7470) reads
// the exact same inventory instead of a second, drifting copy.
const scanned = scanApiEnvNames();
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
