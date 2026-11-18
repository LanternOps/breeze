import { describe, expect, it } from 'vitest';
import { fleetEffectDigest, fleetEffectMaterial } from './fleetEffectDigest';
import type { RunScriptSnapshot } from './runScriptSnapshot';

/**
 * Tool Catalog W06 (#5221) Task A6 — the effect digest of a parked
 * `run_script_on_targets` approval: the script snapshot, the canonical
 * parameters, the effective run context, the offline policy and the FROZEN
 * device list. Mandatory (pinnedEffectPolicy), so an approval can never be
 * released against a different script or device set than the approver saw.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const D1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const D2 = 'aaaaaaaa-0000-4000-8000-000000000002';

const snapshot: RunScriptSnapshot = {
  script: { id: 's', orgId: ORG, language: 'bash', content: 'echo', timeoutSeconds: 300, runAs: 'system' },
  parameterDefinitions: '[]',
  deviceOrgIds: [ORG],
  variableReferences: [],
};
const base = { snapshot, parameters: { a: 1 }, runAs: 'system', offlinePolicy: 'queue', deviceIds: [D1, D2] };

describe('fleetEffectDigest', () => {
  it('is sha256 hex and stable for the same effect (device order and parameter key order ignored)', () => {
    const d = fleetEffectDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(fleetEffectDigest({ ...base, deviceIds: [D2, D1] })).toBe(d);
    expect(fleetEffectDigest({ ...base, parameters: { a: 1 } })).toBe(d);
  });

  it('digest changes with any device id', () => {
    const d = fleetEffectDigest(base);
    expect(fleetEffectDigest({ ...base, deviceIds: [D1] })).not.toBe(d);
    expect(fleetEffectDigest({ ...base, deviceIds: [D1, 'aaaaaaaa-0000-4000-8000-000000000003'] })).not.toBe(d);
  });

  it('digest changes with the script, parameters, run context or offline policy', () => {
    const d = fleetEffectDigest(base);
    expect(fleetEffectDigest({ ...base, snapshot: { ...snapshot, script: { ...snapshot.script, content: 'rm' } } })).not.toBe(d);
    expect(fleetEffectDigest({ ...base, parameters: { a: 2 } })).not.toBe(d);
    expect(fleetEffectDigest({ ...base, runAs: 'user' })).not.toBe(d);
    expect(fleetEffectDigest({ ...base, offlinePolicy: 'skip' })).not.toBe(d);
  });

  it('zero devices has a defined digest', () => {
    const d = fleetEffectDigest({ ...base, deviceIds: [] });
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).not.toBe(fleetEffectDigest(base));
  });

  it('the material is a versioned fleet envelope, never comparable to a run_script digest', () => {
    expect(JSON.parse(fleetEffectMaterial(base))).toMatchObject({ v: 1, lane: 'fleet', deviceIds: [D1, D2] });
  });
});
