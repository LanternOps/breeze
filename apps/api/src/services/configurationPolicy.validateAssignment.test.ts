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

// Build a drizzle-style select chain that resolves to `rows`. Covers both the
// no-join org lookup and the innerJoin site/group/device lookups — every branch
// ends in `.limit(1)` returning an array.
function mockSelectResolving(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  selectMock.mockReturnValue(chain);
}

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
    if (!result.valid) expect(result.error).toMatch(/Only partner-wide policies can be assigned at the Partner level/i);
    // Pure early return — no DB lookup for this illegal combination.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('accepts a partner-owned policy assigned to an in-partner organization', async () => {
    mockSelectResolving([{ id: ORG_ID }]);
    const result = await validateAssignmentTarget(
      { orgId: null, partnerId: PARTNER_ID },
      'organization',
      ORG_ID
    );
    expect(result.valid).toBe(true);
    expect(selectMock).toHaveBeenCalled();
  });

  it('rejects a partner-owned policy assigned to an out-of-partner organization', async () => {
    mockSelectResolving([]); // org exists but not under this partner → no row
    const result = await validateAssignmentTarget(
      { orgId: null, partnerId: PARTNER_ID },
      'organization',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/not in this partner/i);
  });

  it('accepts a partner-owned policy assigned to an in-partner device', async () => {
    mockSelectResolving([{ id: '33333333-3333-3333-3333-333333333333' }]);
    const result = await validateAssignmentTarget(
      { orgId: null, partnerId: PARTNER_ID },
      'device',
      '33333333-3333-3333-3333-333333333333'
    );
    expect(result.valid).toBe(true);
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
    if (!result.valid) expect(result.error).toMatch(/can only target its own partner/i);
  });
});
