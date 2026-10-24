import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getEntitlements: vi.fn() }));

vi.mock('../entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../entitlements')>();
  return { ...actual, getEntitlements: h.getEntitlements };
});

import { EntitlementResolutionError } from '../entitlements';
import { loadWispEntitlement } from './wispEntitlementLimits';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const PRO = { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 };

function resolved(wisp: { state: 'enabled' | 'disabled'; limits: unknown }) {
  const entry = (key: string, e: { state: string; limits: unknown }) => ({
    key, state: e.state, source: 'plan', limits: e.limits, expiresAt: null, graceUntil: null, reason: null,
  });
  return {
    plan: 'pro',
    entitlements: {
      onboarding_supervisor: entry('onboarding_supervisor', { state: 'enabled', limits: null }),
      verified_library: entry('verified_library', { state: 'enabled', limits: null }),
      wisp: entry('wisp', wisp),
    },
  };
}

beforeEach(() => {
  h.getEntitlements.mockReset();
});

describe('loadWispEntitlement (W01 → W02 seam)', () => {
  it('enabled with limits → the typed W01 limits, read once for the partner', async () => {
    h.getEntitlements.mockResolvedValue(resolved({ state: 'enabled', limits: PRO }));
    await expect(loadWispEntitlement(PARTNER)).resolves.toEqual({ enabled: true, limits: PRO });
    expect(h.getEntitlements).toHaveBeenCalledTimes(1);
    expect(h.getEntitlements).toHaveBeenCalledWith(PARTNER);
  });

  it('enabled with no limits (e.g. a manual grant on a plan with no wisp defaults) → limits null', async () => {
    h.getEntitlements.mockResolvedValue(resolved({ state: 'enabled', limits: null }));
    await expect(loadWispEntitlement(PARTNER)).resolves.toEqual({ enabled: true, limits: null });
  });

  it('disabled → not enabled, whatever limits the row carries', async () => {
    h.getEntitlements.mockResolvedValue(resolved({ state: 'disabled', limits: PRO }));
    await expect(loadWispEntitlement(PARTNER)).resolves.toEqual({ enabled: false });
  });

  it('an EntitlementResolutionError (cache past the stale ceiling) propagates as itself', async () => {
    const err = new EntitlementResolutionError(PARTNER, new Error('db down'));
    h.getEntitlements.mockRejectedValue(err);
    await expect(loadWispEntitlement(PARTNER)).rejects.toBe(err);
  });
});
