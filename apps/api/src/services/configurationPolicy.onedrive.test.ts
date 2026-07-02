import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withDbAccessContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));

import { validateFeaturePolicyExists } from './configurationPolicy';

describe('onedrive_helper feature type', () => {
  it('rejects a featurePolicyId (inline-only feature)', async () => {
    const res = await validateFeaturePolicyExists('onedrive_helper', 'some-id', { orgId: 'org-1', partnerId: null });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('accepts inline-only (no featurePolicyId)', async () => {
    const res = await validateFeaturePolicyExists('onedrive_helper', null, { orgId: 'org-1', partnerId: null });
    expect(res.valid).toBe(true);
  });
});
