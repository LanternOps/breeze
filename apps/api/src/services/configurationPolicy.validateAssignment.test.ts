import { describe, it, expect, vi, beforeEach } from 'vitest';

// validateAssignmentTarget gates which (level, target) pairs are legal for a
// given policy ownership. We only need the pure ownership branches here, so the
// db is mocked; the org-owned + partner rejection must short-circuit BEFORE any
// query runs.
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: selectMock },
}));

import { validateAssignmentTarget } from './configurationPolicy';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  selectMock.mockReset();
});

describe('validateAssignmentTarget — ownership gating', () => {
  it('rejects an org-owned policy assigned at the Partner level (footgun) without querying', async () => {
    const result = await validateAssignmentTarget(
      { orgId: ORG_ID, partnerId: null },
      'partner',
      PARTNER_ID
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Only partner-wide policies can be assigned at the Partner level/i);
    // Pure early return — no DB lookup for this illegal combination.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects a partner-owned policy assigned below the Partner level', async () => {
    const result = await validateAssignmentTarget(
      { orgId: null, partnerId: PARTNER_ID },
      'organization',
      ORG_ID
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/can only be assigned at the Partner level/i);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('accepts a partner-owned policy targeting its own partner', async () => {
    const result = await validateAssignmentTarget(
      { orgId: null, partnerId: PARTNER_ID },
      'partner',
      PARTNER_ID
    );
    expect(result.valid).toBe(true);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects a partner-owned policy targeting a different partner', async () => {
    const result = await validateAssignmentTarget(
      { orgId: null, partnerId: PARTNER_ID },
      'partner',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/can only target its own partner/i);
  });
});
