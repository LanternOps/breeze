import { describe, expect, it } from 'vitest';
import { resolveIntentTargetDevice, effectiveTargetDeviceId, assertArgsMatchScope } from './intentTargetScope';

const D = '22222222-2222-4222-8222-222222222222';

describe('resolveIntentTargetDevice', () => {
  it('falls back to the run device when no scope is set', () => {
    expect(resolveIntentTargetDevice({ scopeKind: null, scopeDeviceId: null }, { deviceId: D })).toEqual({ kind: 'run', deviceId: D });
    expect(resolveIntentTargetDevice({ scopeKind: null, scopeDeviceId: null }, { deviceId: null })).toEqual({ kind: 'run', deviceId: null });
  });
  it('prefers the explicit scope over the run device', () => {
    expect(resolveIntentTargetDevice({ scopeKind: 'device', scopeDeviceId: D }, { deviceId: 'other' })).toEqual({ kind: 'scope', deviceId: D });
  });
  it('reports a tombstone when the scoped device was deleted', () => {
    const t = resolveIntentTargetDevice({ scopeKind: 'device', scopeDeviceId: null }, { deviceId: D });
    expect(t).toEqual({ kind: 'tombstone' });
    expect(effectiveTargetDeviceId(t)).toBeNull();
  });
});

describe('assertArgsMatchScope', () => {
  it('accepts matching deviceId / deviceIds and absent device args', () => {
    expect(() => assertArgsMatchScope('manage_services', { action: 'restart', deviceId: D }, D)).not.toThrow();
    expect(() => assertArgsMatchScope('manage_patches', { deviceIds: [D] }, D)).not.toThrow();
    expect(() => assertArgsMatchScope('remediate_vulnerability', { deviceVulnerabilityIds: [D] }, D)).not.toThrow();
  });
  it('rejects a divergent deviceId or an extra deviceIds member', () => {
    expect(() => assertArgsMatchScope('manage_services', { deviceId: 'x' }, D)).toThrow(/scope_argument_mismatch/);
    expect(() => assertArgsMatchScope('manage_patches', { deviceIds: [D, 'x'] }, D)).toThrow(/scope_argument_mismatch/);
  });
});
