/**
 * Execution plane W04 (#5715) — the frozen-device-set narrowing for a
 * device-LESS analysis run.
 *
 * The gap this closes: every fleet-wide read tool narrows on the SITE axis,
 * and `buildAgentAuthContext` gives an analysis run `allowedDeviceIds` with no
 * site scope at all. Before this helper, such a run read the whole org —
 * `analysisMaxInputDevicesPerRun`, the frozen `staged_inputs.deviceIds` and
 * `workspace_stage`'s handle allowlist were all satisfied while the artifact
 * being staged had been built org-wide.
 */
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import { runFrozenDeviceIds } from './aiToolsSiteScope';

function auth(over: Partial<AuthContext>): AuthContext {
  return { orgId: 'org-1', ...over } as unknown as AuthContext;
}

describe('runFrozenDeviceIds', () => {
  it('returns the frozen set for a device-less run (no site axis)', () => {
    expect(runFrozenDeviceIds(auth({ allowedDeviceIds: ['d1', 'd2'] }))).toEqual(['d1', 'd2']);
  });

  it('returns null for an unrestricted caller', () => {
    expect(runFrozenDeviceIds(auth({}))).toBeNull();
  });

  it('retains the exact device scope when a site axis is present', () => {
    expect(runFrozenDeviceIds(auth({ allowedDeviceIds: ['d1'], allowedSiteIds: ['s1'] }))).toEqual(['d1']);
  });

  it('returns an empty set for a caller allowed no devices', () => {
    expect(runFrozenDeviceIds(auth({ allowedDeviceIds: [] }))).toEqual([]);
  });

  it('copies the array, so a caller cannot mutate the AuthContext through it', () => {
    const ctx = auth({ allowedDeviceIds: ['d1'] });
    const out = runFrozenDeviceIds(ctx)!;
    out.push('d2');
    expect(ctx.allowedDeviceIds).toEqual(['d1']);
  });
});
