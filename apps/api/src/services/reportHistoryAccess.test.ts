import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const result = state.rows.shift() ?? [];
      const promise = Promise.resolve(result);
      const chain: any = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: promise.then.bind(promise),
      };
      return chain;
    }),
  },
  withSystemDbAccessContext: vi.fn((callback: () => unknown) => callback()),
}));

vi.mock('./roleInheritance', () => ({
  getRoleGrantRows: vi.fn(async () => []),
}));

import { computeReportHistoryReach } from './reportHistoryAccess';
import { getRoleGrantRows } from './roleInheritance';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER = '99999999-9999-4999-8999-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';
const ORG = '22222222-2222-4222-8222-222222222222';
const ROLE = '77777777-7777-4777-8777-777777777777';

const partnerMembership = {
  userStatus: 'active',
  userPartnerId: PARTNER,
  partnerStatus: 'active',
  partnerDeletedAt: null,
  orgAccess: 'all',
  orgIds: null,
  roleId: ROLE,
};

const readRow = (overrides: Record<string, unknown> = {}) => ({
  roleId: ROLE,
  resource: 'reports',
  action: 'read',
  roleScope: 'partner',
  roleIsSystem: false,
  roleOrgId: null,
  rolePartnerId: PARTNER,
  ...overrides,
});

function queue() {
  // partner membership, candidate history orgs, org memberships (none)
  state.rows.push([partnerMembership], [{ id: ORG }], []);
}

describe('computeReportHistoryReach role grants (#11702)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
  });

  it('honours a reports:read grant the partner role holds only through inheritance', async () => {
    queue();
    // The db never returns a grant row: only the resolver knows the grant.
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([readRow()]);

    const reach = await computeReportHistoryReach({ partnerId: PARTNER, userId: USER });

    expect(reach.orgIds).toEqual([ORG]);
    expect(getRoleGrantRows).toHaveBeenCalledWith([ROLE]);
  });

  it('honours a wildcard grant resolved through inheritance', async () => {
    queue();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([readRow({ resource: '*', action: '*' })]);

    const reach = await computeReportHistoryReach({ partnerId: PARTNER, userId: USER });
    expect(reach.orgIds).toEqual([ORG]);
  });

  it('refuses when the resolved grants lack reports:read', async () => {
    queue();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([readRow({ resource: 'tickets' })]);

    const reach = await computeReportHistoryReach({ partnerId: PARTNER, userId: USER });
    expect(reach.orgIds).toEqual([]);
  });

  it('refuses when the base role is owned by another partner', async () => {
    queue();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([readRow({ rolePartnerId: OTHER_PARTNER })]);

    const reach = await computeReportHistoryReach({ partnerId: PARTNER, userId: USER });
    expect(reach.orgIds).toEqual([]);
  });
});
