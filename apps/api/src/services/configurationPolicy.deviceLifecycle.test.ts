import { describe, it, expect, vi } from 'vitest';

// `device_lifecycle` is inline-only, so a correct implementation never reaches
// the database at all. The db double deliberately returns a MATCHING
// configuration-policy row for the whole-policy-linking lookup: that is the
// exact shape that used to make a stray featurePolicyId pass validation and
// then blow up as a 500 on the
// `config_policy_feature_links_reference_integrity` trigger. If the guard is
// removed, this mock lets the fall-through succeed rather than crash, so the
// test fails on the assertion instead of on an incidental TypeError.
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'cfg-policy-1' }],
        }),
      }),
    }),
  },
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
}));

import { validateFeaturePolicyExists } from './configurationPolicy';

describe('device_lifecycle feature type', () => {
  it('rejects a featurePolicyId with a 400-shaped result instead of letting the DB trigger 500', async () => {
    const res = await validateFeaturePolicyExists('device_lifecycle', 'cfg-policy-1', {
      orgId: 'org-1',
      partnerId: null,
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('rejects it for a partner-wide policy too', async () => {
    const res = await validateFeaturePolicyExists('device_lifecycle', 'cfg-policy-1', {
      orgId: null,
      partnerId: 'partner-1',
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('accepts inline-only (no featurePolicyId)', async () => {
    const res = await validateFeaturePolicyExists('device_lifecycle', null, {
      orgId: 'org-1',
      partnerId: null,
    });

    expect(res.valid).toBe(true);
  });
});
