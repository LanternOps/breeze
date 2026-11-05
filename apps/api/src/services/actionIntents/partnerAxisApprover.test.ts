import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Array<Record<string, unknown>>>,
  throwOnRead: false,
  reads: 0,
  partnerApprovers: [] as string[],
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            h.reads += 1;
            if (h.throwOnRead) throw new Error('db down');
            return h.rows.shift() ?? [];
          },
        }),
      }),
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../usersWithPermission', () => ({
  resolvePartnerUsersWithPermission: vi.fn(async () => h.partnerApprovers),
}));

import { captureException } from '../sentry';
import { resolvePartnerUsersWithPermission } from '../usersWithPermission';
import { isPartnerAxisApprover, intentRequiresPartnerAxisApprover, resolvePartnerAxisApprovers } from './partnerAxisApprover';
import { mayHavePartnerWideEffect } from './partnerWideEffect';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a3';
const PARTNER = '00000000-0000-4000-8000-0000000000a2';
const SCHEDULE = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000c1';

function scheduleDelete(...id: [unknown?]) {
  return {
    actionName: 'manage_ai_agent_schedules',
    arguments: { action: 'delete', scheduleId: id.length > 0 ? id[0] : SCHEDULE } as Record<string, unknown>,
    orgId: ORG,
  };
}

beforeEach(() => {
  h.rows = [];
  h.throwOnRead = false;
  h.reads = 0;
  h.partnerApprovers = [];
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('mayHavePartnerWideEffect', () => {
  it('names a schedule delete, and no other schedule action', () => {
    expect(mayHavePartnerWideEffect('manage_ai_agent_schedules', { action: 'delete' })).toBe(true);
    expect(mayHavePartnerWideEffect('manage_ai_agent_schedules', { action: 'create' })).toBe(false);
    expect(mayHavePartnerWideEffect('manage_ai_agent_schedules', { action: 'update' })).toBe(false);
    expect(mayHavePartnerWideEffect('manage_ai_agent_schedules', null)).toBe(false);
  });

  it('leaves actions whose effect stays in one org alone', () => {
    expect(mayHavePartnerWideEffect('manage_org_portal_settings', { action: 'set_sensitive_access' })).toBe(false);
    expect(mayHavePartnerWideEffect('manage_fleet_designs', { action: 'apply' })).toBe(false);
    expect(mayHavePartnerWideEffect('run_script', {})).toBe(false);
  });
});

describe('intentRequiresPartnerAxisApprover', () => {
  it('requires the partner axis for a partner baseline', async () => {
    h.rows = [[{ orgId: null, partnerId: PARTNER }]];
    await expect(intentRequiresPartnerAxisApprover(scheduleDelete())).resolves.toBe(true);
  });

  it("keeps today's rule for an override in the intent's own org", async () => {
    h.rows = [[{ orgId: ORG, partnerId: null }]];
    await expect(intentRequiresPartnerAxisApprover(scheduleDelete())).resolves.toBe(false);
  });

  it("requires the partner axis for an override in another org: the intent's approvers do not cover it", async () => {
    h.rows = [[{ orgId: OTHER_ORG, partnerId: null }]];
    await expect(intentRequiresPartnerAxisApprover(scheduleDelete())).resolves.toBe(true);
  });

  it('requires the partner axis when the row is gone: its scope cannot be determined', async () => {
    h.rows = [[]];
    await expect(intentRequiresPartnerAxisApprover(scheduleDelete())).resolves.toBe(true);
  });

  it('requires the partner axis when the read fails, and reports the failure', async () => {
    h.throwOnRead = true;
    await expect(intentRequiresPartnerAxisApprover(scheduleDelete())).resolves.toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it.each([['malformed', 'nope'], ['missing', undefined], ['not a string', 7]])(
    'requires the partner axis for a %s id, with no read',
    async (_label, id) => {
      await expect(intentRequiresPartnerAxisApprover(scheduleDelete(id))).resolves.toBe(true);
      expect(h.reads).toBe(0);
    },
  );

  it('reads nothing for an action outside the registry', async () => {
    await expect(intentRequiresPartnerAxisApprover({ actionName: 'run_script', arguments: {}, orgId: ORG })).resolves.toBe(false);
    expect(h.reads).toBe(0);
  });
});

describe('resolvePartnerAxisApprovers', () => {
  it("resolves approvals:decide holders with full access on the org's own partner", async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [USER];
    await expect(resolvePartnerAxisApprovers(ORG)).resolves.toEqual([USER]);
    // No orgId argument: the resolver then counts orgAccess 'all' only, never 'selected'.
    expect(resolvePartnerUsersWithPermission).toHaveBeenCalledWith(PARTNER, { resource: 'approvals', action: 'decide' });
  });

  it('is empty when the org has no partner', async () => {
    h.rows = [[]];
    await expect(resolvePartnerAxisApprovers(ORG)).resolves.toEqual([]);
    expect(resolvePartnerUsersWithPermission).not.toHaveBeenCalled();
  });
});

describe('isPartnerAxisApprover', () => {
  const session = (over: Record<string, unknown> = {}) => ({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', ...over }) as never;

  it('admits a full-partner member on a partner session', async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [USER];
    await expect(isPartnerAxisApprover(USER, ORG, session())).resolves.toBe(true);
  });

  it('refuses an org-axis user: they are not a partner approver', async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = ['someone-else'];
    await expect(isPartnerAxisApprover(USER, ORG, session())).resolves.toBe(false);
  });

  it('refuses a full-partner member deciding from an org-only session', async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [USER];
    await expect(isPartnerAxisApprover(USER, ORG, session({ scope: 'organization', partnerOrgAccess: null }))).resolves.toBe(false);
  });

  it('refuses a partner session with selected access', async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [USER];
    await expect(isPartnerAxisApprover(USER, ORG, session({ partnerOrgAccess: 'selected' }))).resolves.toBe(false);
  });

  it('refuses a partner session on another partner', async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [USER];
    await expect(isPartnerAxisApprover(USER, ORG, session({ partnerId: 'another-partner' }))).resolves.toBe(false);
  });

  it('admits a system session only with the same live membership', async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [USER];
    await expect(isPartnerAxisApprover(USER, ORG, session({ scope: 'system', partnerId: null, partnerOrgAccess: null }))).resolves.toBe(true);
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [];
    await expect(isPartnerAxisApprover(USER, ORG, session({ scope: 'system', partnerId: null, partnerOrgAccess: null }))).resolves.toBe(false);
  });

  it('with no session (a worker release), the live membership decides', async () => {
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [USER];
    await expect(isPartnerAxisApprover(USER, ORG)).resolves.toBe(true);
    h.rows = [[{ partnerId: PARTNER }]];
    h.partnerApprovers = [];
    await expect(isPartnerAxisApprover(USER, ORG)).resolves.toBe(false);
  });
});
