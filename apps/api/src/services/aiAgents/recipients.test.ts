import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  inArray: (column: unknown, values: unknown) => ({ inArray: [column, values] }),
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  organizationUsers: {
    userId: 'organizationUsers.userId',
    orgId: 'organizationUsers.orgId',
    roleId: 'organizationUsers.roleId',
  },
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    roleId: 'partnerUsers.roleId',
    orgAccess: 'partnerUsers.orgAccess',
    orgIds: 'partnerUsers.orgIds',
  },
  users: { id: 'users.id', status: 'users.status' },
  roles: {
    id: 'roles.id',
    partnerId: 'roles.partnerId',
    orgId: 'roles.orgId',
    isSystem: 'roles.isSystem',
  },
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  // Pass-throughs — the tests assert BOTH wrappers were entered, because a bare
  // withSystemDbAccessContext inside an ambient request context is a no-op
  // (db/index.ts): the runOutsideDbContext wrapper is load-bearing.
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  InvalidAgentRecipientsError,
  hasResolvableAgentRecipient,
  resolveRecipientUserIds,
  validateAgentRecipients,
} from './recipients';

/**
 * Queue one select's result rows, in issue order. The returned capture object
 * records the bound `from` table and `where` predicate so tests can pin the
 * query shape (active-status gate, id filters) instead of only the JS logic.
 */
function queueSelect(rows: unknown[]) {
  const capture: { from?: unknown; where?: unknown } = {};
  vi.mocked(db.select).mockImplementationOnce(() => {
    const chain = {
      from: (table: unknown) => {
        capture.from = table;
        return chain;
      },
      innerJoin: () => chain,
      where: (condition: unknown) => {
        capture.where = condition;
        return Object.assign(Promise.resolve(rows), { limit: async () => rows });
      },
    };
    return chain as never;
  });
  return capture;
}

async function expectInvalid(
  promise: Promise<void>,
): Promise<InvalidAgentRecipientsError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidAgentRecipientsError);
    return err as InvalidAgentRecipientsError;
  }
  throw new Error('expected InvalidAgentRecipientsError, resolved instead');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
});

describe('validateAgentRecipients', () => {
  it('accepts active org members for an org-owned agent', async () => {
    queueSelect([{ partnerId: 'p1' }]); // organizations → owning partner
    const orgMembers = queueSelect([{ userId: 'u1' }, { userId: 'u2' }]);
    queueSelect([]); // partner members — none needed

    await expect(
      validateAgentRecipients(
        { orgId: 'o1', partnerId: null },
        { userIds: ['u1', 'u2'], roleIds: [] },
      ),
    ).resolves.toBeUndefined();

    // The membership read must be the active-member join, keyed by the org and
    // the exact candidate ids — not an unfiltered table scan.
    const bound = JSON.stringify(orgMembers.where);
    expect(orgMembers.from).toMatchObject({ orgId: 'organizationUsers.orgId' });
    expect(bound).toContain('"organizationUsers.orgId","o1"');
    expect(bound).toContain('"users.status","active"');
    expect(bound).toContain('u1');
    expect(bound).toContain('u2');

    // System context, with the load-bearing outside-context escape.
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('rejects a userId from a different org (lists it in invalidUserIds)', async () => {
    queueSelect([{ partnerId: 'p1' }]);
    queueSelect([{ userId: 'u1' }]); // only u1 is a member of o1
    queueSelect([]); // not a partner user either

    const err = await expectInvalid(
      validateAgentRecipients(
        { orgId: 'o1', partnerId: null },
        { userIds: ['u1', 'u-other-org'], roleIds: [] },
      ),
    );
    expect(err.invalidUserIds).toEqual(['u-other-org']);
    expect(err.invalidRoleIds).toEqual([]);
    expect(err.code).toBe('invalid_recipients');
  });

  it('rejects an inactive user', async () => {
    queueSelect([{ partnerId: 'p1' }]);
    // The queries join users and gate on status='active', so a disabled or
    // still-invited member simply does not come back.
    const orgMembers = queueSelect([]);
    const partnerMembers = queueSelect([]);

    const err = await expectInvalid(
      validateAgentRecipients(
        { orgId: 'o1', partnerId: null },
        { userIds: ['u-disabled'], roleIds: [] },
      ),
    );
    expect(err.invalidUserIds).toEqual(['u-disabled']);
    expect(JSON.stringify(orgMembers.where)).toContain('"users.status","active"');
    expect(JSON.stringify(partnerMembers.where)).toContain('"users.status","active"');
  });

  it('rejects a roleId belonging to another tenant', async () => {
    queueSelect([{ partnerId: 'p1' }]);
    queueSelect([
      { id: 'r-mine', partnerId: null, orgId: 'o1', isSystem: false },
      { id: 'r-foreign', partnerId: null, orgId: 'o-other', isSystem: false },
      { id: 'r-foreign-partner', partnerId: 'p-other', orgId: null, isSystem: false },
    ]); // roles lookup — r-missing has no row at all

    const err = await expectInvalid(
      validateAgentRecipients(
        { orgId: 'o1', partnerId: null },
        { userIds: [], roleIds: ['r-mine', 'r-foreign', 'r-foreign-partner', 'r-missing'] },
      ),
    );
    expect(err.invalidUserIds).toEqual([]);
    expect(err.invalidRoleIds).toEqual(['r-foreign', 'r-foreign-partner', 'r-missing']);
  });

  it('accepts a partner user with orgAccess=selected covering the org', async () => {
    queueSelect([{ partnerId: 'p1' }]);
    queueSelect([]); // no direct org membership
    queueSelect([
      { userId: 'u-partner', orgAccess: 'selected', orgIds: ['o1', 'o9'] },
    ]);

    await expect(
      validateAgentRecipients(
        { orgId: 'o1', partnerId: null },
        { userIds: ['u-partner'], roleIds: [] },
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a partner user whose orgAccess=selected does NOT cover the org', async () => {
    queueSelect([{ partnerId: 'p1' }]);
    queueSelect([]);
    queueSelect([
      { userId: 'u-partner', orgAccess: 'selected', orgIds: ['o-other'] },
    ]);

    const err = await expectInvalid(
      validateAgentRecipients(
        { orgId: 'o1', partnerId: null },
        { userIds: ['u-partner'], roleIds: [] },
      ),
    );
    expect(err.invalidUserIds).toEqual(['u-partner']);
  });

  it('accepts the owning partner tenancy for a partner-owned agent (members, roles, system roles)', async () => {
    // Partner-owned agent: no organizations lookup — the owner IS the tenant.
    const partnerMembers = queueSelect([{ userId: 'u-tech' }]);
    queueSelect([
      { id: 'r-partner', partnerId: 'p1', orgId: null, isSystem: false },
      { id: 'r-system', partnerId: null, orgId: null, isSystem: true },
    ]);

    await expect(
      validateAgentRecipients(
        { orgId: null, partnerId: 'p1' },
        { userIds: ['u-tech'], roleIds: ['r-partner', 'r-system'] },
      ),
    ).resolves.toBeUndefined();

    expect(partnerMembers.from).toMatchObject({ partnerId: 'partnerUsers.partnerId' });
    const bound = JSON.stringify(partnerMembers.where);
    expect(bound).toContain('"partnerUsers.partnerId","p1"');
    expect(bound).toContain('"users.status","active"');
  });

  it('issues no queries when there is nothing to validate', async () => {
    await expect(
      validateAgentRecipients({ orgId: 'o1', partnerId: null }, {}),
    ).resolves.toBeUndefined();
    await expect(
      validateAgentRecipients({ orgId: 'o1', partnerId: null }, { userIds: [], roleIds: [] }),
    ).resolves.toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('resolveRecipientUserIds', () => {
  it('expands roleIds to current holders with access to the run org', async () => {
    queueSelect([{ partnerId: 'p1' }]); // organizations → run org's partner
    // userIds is empty, so the two explicit-userIds selects are skipped.
    const orgHolders = queueSelect([{ userId: 'u-org-holder' }]);
    queueSelect([
      { userId: 'u-partner-all', orgAccess: 'all', orgIds: null },
      { userId: 'u-partner-covered', orgAccess: 'selected', orgIds: ['o1'] },
      { userId: 'u-partner-uncovered', orgAccess: 'selected', orgIds: ['o-other'] },
      { userId: 'u-partner-none', orgAccess: 'none', orgIds: null },
    ]);

    const result = await resolveRecipientUserIds(
      { orgId: null, partnerId: 'p1', recipients: { userIds: [], roleIds: ['r1'] } },
      'o1',
    );

    expect([...result].sort()).toEqual(['u-org-holder', 'u-partner-all', 'u-partner-covered']);
    // Role expansion is keyed on role membership in the RUN org, not the
    // agent's owner: the where binds the run org and the role ids.
    const bound = JSON.stringify(orgHolders.where);
    expect(bound).toContain('"organizationUsers.orgId","o1"');
    expect(bound).toContain('"organizationUsers.roleId"');
    expect(bound).toContain('r1');
    expect(bound).toContain('"users.status","active"');
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('drops a userId whose membership was since revoked', async () => {
    queueSelect([{ partnerId: 'p1' }]);
    queueSelect([{ userId: 'u-still-member' }]); // u-gone no longer comes back
    queueSelect([]); // not a covering partner user either

    const result = await resolveRecipientUserIds(
      {
        orgId: 'o1',
        partnerId: null,
        recipients: { userIds: ['u-still-member', 'u-gone'], roleIds: [] },
      },
      'o1',
    );

    expect(result).toEqual(['u-still-member']);
  });

  it('dedupes a user matched by both userIds and roleIds', async () => {
    queueSelect([{ partnerId: 'p1' }]);
    queueSelect([{ userId: 'u1' }]); // explicit userIds — org member
    queueSelect([]); // explicit userIds — partner arm
    queueSelect([{ userId: 'u1' }]); // role holders — same user again
    queueSelect([]); // role holders — partner arm

    const result = await resolveRecipientUserIds(
      { orgId: 'o1', partnerId: null, recipients: { userIds: ['u1'], roleIds: ['r1'] } },
      'o1',
    );

    expect(result).toEqual(['u1']);
  });

  it('returns [] without querying when the recipients are empty', async () => {
    await expect(
      resolveRecipientUserIds({ orgId: 'o1', partnerId: null, recipients: {} }, 'o1'),
    ).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('hasResolvableAgentRecipient — Task 6 (#3826) act-mode activation prerequisite', () => {
  it('returns false without querying when recipients are empty', async () => {
    await expect(
      hasResolvableAgentRecipient({ orgId: 'o1', partnerId: null }, {}),
    ).resolves.toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('org-owned agent: true when resolveRecipientUserIds finds a live member', async () => {
    queueSelect([{ partnerId: 'p1' }]); // organizations → run org's partner
    queueSelect([{ userId: 'u1' }]); // org member match
    queueSelect([]); // partner arm — no coverage needed, already matched

    await expect(
      hasResolvableAgentRecipient({ orgId: 'o1', partnerId: null }, { userIds: ['u1'] }),
    ).resolves.toBe(true);
  });

  it('org-owned agent: false when nobody currently resolves (e.g. a role nobody holds)', async () => {
    queueSelect([{ partnerId: 'p1' }]); // organizations
    queueSelect([]); // no org holders of the role
    queueSelect([]); // no covering partner holders either

    await expect(
      hasResolvableAgentRecipient({ orgId: 'o1', partnerId: null }, { roleIds: ['r-empty'] }),
    ).resolves.toBe(false);
  });

  it('partner-owned agent: true on an active partner member matched by userIds', async () => {
    queueSelect([{ userId: 'u1', orgAccess: 'all', orgIds: null }]);

    await expect(
      hasResolvableAgentRecipient({ orgId: null, partnerId: 'p1' }, { userIds: ['u1'] }),
    ).resolves.toBe(true);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('partner-owned agent: falls through to roleIds when userIds resolves nothing', async () => {
    queueSelect([]); // userIds arm — nobody
    const roleHolders = queueSelect([{ userId: 'u2', orgAccess: 'all', orgIds: null }]);

    await expect(
      hasResolvableAgentRecipient({ orgId: null, partnerId: 'p1' }, { userIds: ['u-gone'], roleIds: ['r1'] }),
    ).resolves.toBe(true);
    const bound = JSON.stringify(roleHolders.where);
    expect(bound).toContain('"partnerUsers.partnerId","p1"');
    expect(bound).toContain('"partnerUsers.roleId"');
  });

  it('partner-owned agent: false when neither userIds nor roleIds currently resolve', async () => {
    queueSelect([]);
    queueSelect([]);

    await expect(
      hasResolvableAgentRecipient({ orgId: null, partnerId: 'p1' }, { userIds: ['u-gone'], roleIds: ['r-empty'] }),
    ).resolves.toBe(false);
  });

  it('an owner with neither orgId nor partnerId resolves nothing (defensive)', async () => {
    await expect(
      hasResolvableAgentRecipient({ orgId: null, partnerId: null }, { userIds: ['u1'] }),
    ).resolves.toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });
});
