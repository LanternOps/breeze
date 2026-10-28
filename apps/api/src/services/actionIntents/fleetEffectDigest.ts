/**
 * Tool Catalog W06 (#5221) Task A6 — the effect material of a
 * `run_script_on_targets` approval intent: everything that decides what runs
 * where. The script half is `runScriptDigestMaterial` over the snapshot built
 * for the frozen device set (content, run context, parameter definitions, the
 * device orgs and every tenant-variable REFERENCE — never a value); on top of
 * it the canonical parameters, the effective run context, the offline policy
 * and the sorted frozen device ids. A `v: 1, lane: 'fleet'` envelope, so it can
 * never compare equal to a core `run_script` digest.
 *
 * Pure; the resolver in effectDigest.ts builds the snapshot.
 */
import { createHash } from 'node:crypto';
import { canonicalizeArguments } from './canonicalize';
import { runScriptDigestMaterial, type RunScriptSnapshot } from './runScriptSnapshot';

export interface FleetEffectInput {
  snapshot: RunScriptSnapshot;
  parameters: unknown;
  /** The EFFECTIVE run context (explicit, else the script's saved one). */
  runAs: string;
  offlinePolicy: string;
  deviceIds: readonly string[];
}

export function fleetEffectMaterial(i: FleetEffectInput): string {
  return JSON.stringify({
    v: 1,
    lane: 'fleet',
    script: runScriptDigestMaterial(i.snapshot),
    parameters: canonicalizeArguments((i.parameters ?? {}) as Record<string, unknown>),
    runAs: i.runAs,
    offlinePolicy: i.offlinePolicy,
    deviceIds: [...new Set(i.deviceIds)].sort(),
  });
}

export function fleetEffectDigest(i: FleetEffectInput): string {
  return createHash('sha256').update(fleetEffectMaterial(i)).digest('hex');
}
