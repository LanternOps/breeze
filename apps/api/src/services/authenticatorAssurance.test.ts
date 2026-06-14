import { describe, it, expect } from 'vitest';
import { resolveApprovalAssurance, resolveElevationAssurance } from './authenticatorAssurance';

describe('resolveApprovalAssurance (Phase 1: resolve-only, never blocks)', () => {
  it('reports the would-be required level scaled to risk tier', () => {
    expect(resolveApprovalAssurance('low').requiredLevel).toBe(1);
    expect(resolveApprovalAssurance('medium').requiredLevel).toBe(2);
    expect(resolveApprovalAssurance('high').requiredLevel).toBe(3);
    expect(resolveApprovalAssurance('critical').requiredLevel).toBe(4);
  });

  it('records every decision as a session tap at level 1 (no behavior change yet)', () => {
    for (const tier of ['low', 'medium', 'high', 'critical'] as const) {
      const d = resolveApprovalAssurance(tier);
      expect(d.decidedVia).toBe('session_tap');
      expect(d.decidedAssuranceLevel).toBe(1);
      expect(d.authenticatorDeviceId).toBeNull();
      expect(d.pinVerified).toBe(false);
    }
  });
});

describe('resolveElevationAssurance', () => {
  it('maps the elevation smallint tier through to the resolver', () => {
    expect(resolveElevationAssurance(4).requiredLevel).toBe(4);
    expect(resolveElevationAssurance(1).requiredLevel).toBe(1);
    expect(resolveElevationAssurance(null).requiredLevel).toBe(2); // null → medium
  });
});
