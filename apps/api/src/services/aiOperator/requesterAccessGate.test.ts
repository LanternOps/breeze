import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissions: vi.fn(),
  canAccessOrg: vi.fn(),
  canAccessSite: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: shared.selectMock },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema/users', () => ({
  users: { id: 'users.id', partnerId: 'users.partnerId', status: 'users.status' },
}));

vi.mock('../../db/schema/devices', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
}));

vi.mock('../permissions', () => ({
  getUserPermissions: shared.getUserPermissions,
  canAccessOrg: shared.canAccessOrg,
  canAccessSite: shared.canAccessSite,
}));

import { requesterAccessLost } from './requesterAccessGate';

const ORG_ID = 'org-1';
const DEVICE_ID = 'device-1';
const USER_ID = 'user-1';

/** One `db.select(...).from(...).where(...).limit(1)` call resolving to `rows`. */
function queueSelect(rows: unknown[]) {
  shared.selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.canAccessOrg.mockReturnValue(true);
  shared.canAccessSite.mockReturnValue(true);
});

describe('requesterAccessLost', () => {
  it('has nothing to check for a task with no requester (automatic origin)', async () => {
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: null }, DEVICE_ID);
    expect(result).toEqual({ lost: false, detail: null });
    expect(shared.selectMock).not.toHaveBeenCalled();
    expect(shared.getUserPermissions).not.toHaveBeenCalled();
  });

  it('is lost when the requester account no longer exists', async () => {
    queueSelect([]);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer active/);
  });

  it('is lost when the requester account is no longer active', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'disabled' }]);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer active/);
  });

  it('is lost when live permissions no longer resolve for the org', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(null);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer has access to organization/);
    expect(shared.getUserPermissions).toHaveBeenCalledWith(
      USER_ID,
      { partnerId: 'p1', orgId: ORG_ID },
      { bypassCache: true },
    );
  });

  it('is lost when canAccessOrg rejects the live permission set', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID });
    shared.canAccessOrg.mockReturnValue(false);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/no longer has access to organization/);
  });

  it('is lost when the target device no longer resolves in this org', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID });
    queueSelect([]); // device lookup
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/target device is no longer/);
  });

  it('is lost when the requester is site-restricted away from the device', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID, allowedSiteIds: ['site-A'] });
    queueSelect([{ id: DEVICE_ID, siteId: 'site-B' }]);
    shared.canAccessSite.mockReturnValue(false);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/site/);
  });

  it('is NOT lost when org, org-access and site all still resolve live', async () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'organization', orgId: ORG_ID, allowedSiteIds: ['site-A'] });
    queueSelect([{ id: DEVICE_ID, siteId: 'site-A' }]);
    const result = await requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID);
    expect(result).toEqual({ lost: false, detail: null });
  });
});

// ---------------------------------------------------------------------------
// R1a-0 Task 1f — requesterAccessLostForTargets. Appended; the device-keyed
// cases above are unchanged. `and` / `eq` / `isNull` are recorded as plain
// objects (hoisted mock; the device cases above never inspect them) so every
// read below can assert its explicit `org_id` predicate: the gate runs in
// SYSTEM scope, so those predicates ARE the tenant isolation.
// ---------------------------------------------------------------------------
import { aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { organizations } from '../../db/schema/orgs';
import { contacts } from '../../db/schema/contacts';
import { tickets } from '../../db/schema/portal';
import { devices } from '../../db/schema/devices';
import * as gate from './requesterAccessGate';

vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));

type Cond = { op: 'eq'; col: unknown; val: unknown } | { op: 'isNull'; col: unknown } | { op: 'and'; parts: Cond[] };
const reads: Array<{ table: unknown; where: Cond }> = [];
/** One select resolving to `rows`, recording its table and WHERE. */
function queueRead(rows: unknown[]) {
  shared.selectMock.mockReturnValueOnce({
    from: (table: unknown) => ({
      where: (where: Cond) => {
        reads.push({ table, where });
        return { limit: () => Promise.resolve(rows) };
      },
    }),
  } as never);
}
function eqs(where: Cond): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>();
  const walk = (c: Cond) => {
    if (c.op === 'eq') out.set(c.col, c.val);
    else if (c.op === 'and') c.parts.forEach(walk);
  };
  walk(where);
  return out;
}
function nulls(where: Cond): unknown[] {
  const out: unknown[] = [];
  const walk = (c: Cond) => {
    if (c.op === 'isNull') out.push(c.col);
    else if (c.op === 'and') c.parts.forEach(walk);
  };
  walk(where);
  return out;
}

const TASK = { id: 'task-1', orgId: ORG_ID, requesterUserId: USER_ID };
const lostForTargets = (task: { id: string; orgId: string; requesterUserId: string | null } = TASK) =>
  (gate as unknown as { requesterAccessLostForTargets: (t: typeof task) => Promise<{ lost: boolean; detail: string | null }> })
    .requesterAccessLostForTargets(task);
const orgUser = (over: Record<string, unknown> = {}) => ({ scope: 'organization', orgId: ORG_ID, ...over });
const target = (kind: string, over: Record<string, unknown> = {}) => ({
  id: `t-${kind}`, targetKind: kind, deviceId: null, ticketId: null, contactId: null,
  ...(kind === 'device' ? { deviceId: DEVICE_ID } : {}),
  ...(kind === 'contact' ? { contactId: 'contact-1' } : {}),
  ...(kind === 'ticket' ? { ticketId: 'ticket-1' } : {}),
  ...over,
});
function expectTargetsRead(i: number) {
  expect(reads[i]!.table).toBe(aiOperatorTaskTargets);
  const p = eqs(reads[i]!.where);
  expect(p.get(aiOperatorTaskTargets.orgId)).toBe(ORG_ID);
  expect(p.get(aiOperatorTaskTargets.taskId)).toBe('task-1');
  // Detached rows are READ (and refused), never filtered out of the read.
  expect(nulls(reads[i]!.where)).not.toContain(aiOperatorTaskTargets.detachedAt);
}

describe('requesterAccessLostForTargets (R1a-0 Task 1f)', () => {
  // mockReset, not just clear: a failed case must not leave queued reads for the next one.
  beforeEach(() => { reads.length = 0; shared.selectMock.mockReset(); });

  it('1: no requester → access OK, nothing read', async () => {
    await expect(lostForTargets({ ...TASK, requesterUserId: null })).resolves.toEqual({ lost: false, detail: null });
    expect(shared.selectMock).not.toHaveBeenCalled();
  });

  it('2: an inactive requester is lost', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'disabled' }]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/no longer active/) });
  });

  it('3: live permissions that no longer reach the org (cache bypassed) are lost', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser());
    shared.canAccessOrg.mockReturnValue(false);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/organization/) });
    expect(shared.getUserPermissions).toHaveBeenCalledWith(USER_ID, { partnerId: 'p1', orgId: ORG_ID }, { bypassCache: true });
  });

  it("4: a partner requester with orgAccess 'all' and a FOREIGN-partner org is lost (explicit partner binding)", async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'partner', partnerId: 'p1', orgAccess: 'all' });
    queueRead([{ partnerId: 'p-other' }]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/partner/) });
    expect(reads[1]!.table).toBe(organizations);
    expect(eqs(reads[1]!.where).get(organizations.id)).toBe(ORG_ID);
  });

  it('4: a partner requester whose org row is gone is lost', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'partner', partnerId: 'p1', orgAccess: 'all' });
    queueRead([]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true });
  });

  it('5: a task with no target rows at all is lost; the read is scoped by org and task', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/no live target/) });
    expectTargetsRead(1);
  });

  it('6 device: in-org device on an accessible site is OK; the device read carries org_id', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser({ allowedSiteIds: ['site-A'] }));
    queueRead([target('device')]);
    queueRead([{ id: DEVICE_ID, siteId: 'site-A' }]);
    await expect(lostForTargets()).resolves.toEqual({ lost: false, detail: null });
    const p = eqs(reads[2]!.where);
    expect(reads[2]!.table).toBe(devices);
    expect(p.get(devices.id)).toBe(DEVICE_ID);
    expect(p.get(devices.orgId)).toBe(ORG_ID);
  });

  it('6 device: a device no longer in the org, or on a site the requester lost, is lost', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('device')]);
    queueRead([]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/device/) });

    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    queueRead([target('device')]);
    queueRead([{ id: DEVICE_ID, siteId: 'site-B' }]);
    shared.canAccessSite.mockReturnValue(false);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/site/) });
  });

  it('6 contact: an unrestricted requester on an in-org contact is OK; the contact read carries org_id', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('contact')]);
    queueRead([{ id: 'contact-1' }]);
    await expect(lostForTargets()).resolves.toEqual({ lost: false, detail: null });
    const p = eqs(reads[2]!.where);
    expect(reads[2]!.table).toBe(contacts);
    expect(p.get(contacts.id)).toBe('contact-1');
    expect(p.get(contacts.orgId)).toBe(ORG_ID);
  });

  it('6 contact: a SITE-RESTRICTED requester is lost on a contact target (a directory account has no site slice)', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser({ allowedSiteIds: ['site-A'] }));
    queueRead([target('contact')]);
    queueRead([{ id: 'contact-1' }]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/site-restricted/) });
  });

  it('6 contact: an empty site list, or an underivable (malformed) ceiling, is restricted → lost', async () => {
    for (const allowedSiteIds of [[], null, 'site-A']) {
      queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
      shared.getUserPermissions.mockResolvedValue(orgUser({ allowedSiteIds }));
      queueRead([target('contact')]);
      queueRead([{ id: 'contact-1' }]);
      await expect(lostForTargets()).resolves.toMatchObject({ lost: true });
    }
  });

  it('6 contact: a contact no longer in this org is lost', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('contact')]);
    queueRead([]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/contact/) });
  });

  it('6 ticket: an in-org ticket is OK and its read carries org_id; a missing one is lost', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('ticket')]);
    queueRead([{ id: 'ticket-1' }]);
    await expect(lostForTargets()).resolves.toEqual({ lost: false, detail: null });
    const p = eqs(reads[2]!.where);
    expect(reads[2]!.table).toBe(tickets);
    expect(p.get(tickets.id)).toBe('ticket-1');
    expect(p.get(tickets.orgId)).toBe(ORG_ID);

    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    queueRead([target('ticket')]);
    queueRead([]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/ticket/) });
  });

  it('6: a target whose kind or pointer does not resolve is lost', async () => {
    for (const t of [target('contact', { contactId: null }), target('device', { deviceId: null }), target('ticket', { ticketId: null }), target('mailbox')]) {
      queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
      shared.getUserPermissions.mockResolvedValue(orgUser());
      queueRead([t]);
      await expect(lostForTargets()).resolves.toMatchObject({ lost: true });
    }
  });

  it('a same-partner partner requester on device + contact + ticket targets is OK', async () => {
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'partner', partnerId: 'p1', orgAccess: 'selected', allowedOrgIds: [ORG_ID] });
    queueRead([{ partnerId: 'p1' }]);
    queueRead([target('device'), target('contact'), target('ticket')]);
    queueRead([{ id: DEVICE_ID, siteId: 'site-A' }]);
    queueRead([{ id: 'contact-1' }]);
    queueRead([{ id: 'ticket-1' }]);
    await expect(lostForTargets()).resolves.toEqual({ lost: false, detail: null });
    expectTargetsRead(2);
  });

  it('the device-keyed gate is still exported unchanged alongside it', () => {
    expect(gate.requesterAccessLost).toBe(requesterAccessLost);
  });
});

describe('requesterAccessLostForTargets — ticket parity with the request-path ticket scope (R1a-0 Task 1f)', () => {
  // mockReset, not just clear: a failed case must not leave queued reads for the next one.
  beforeEach(() => { reads.length = 0; shared.selectMock.mockReset(); });
  const user = () => queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);

  it('a soft-deleted ticket is lost (getScopedTicketOr404 hides it)', async () => {
    user();
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('ticket')]);
    queueRead([{ id: 'ticket-1', deviceId: null, deletedAt: new Date('2026-10-01T00:00:00Z') }]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/ticket/) });
  });

  it('a device-bound ticket on a device outside the requester\'s sites is lost; the device read carries org_id', async () => {
    user();
    shared.getUserPermissions.mockResolvedValue(orgUser({ allowedSiteIds: ['site-A'] }));
    queueRead([target('ticket')]);
    queueRead([{ id: 'ticket-1', deviceId: DEVICE_ID, deletedAt: null }]);
    queueRead([{ id: DEVICE_ID, siteId: 'site-B' }]);
    shared.canAccessSite.mockReturnValue(false);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/site/) });
    expect(reads[3]!.table).toBe(devices);
    expect(eqs(reads[3]!.where).get(devices.orgId)).toBe(ORG_ID);
    expect(eqs(reads[3]!.where).get(devices.id)).toBe(DEVICE_ID);
  });

  it('a device-bound ticket whose device does not resolve in this org is lost', async () => {
    user();
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('ticket')]);
    queueRead([{ id: 'ticket-1', deviceId: DEVICE_ID, deletedAt: null }]);
    queueRead([]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true });
  });

  it('a device-bound ticket on an accessible site, and a deviceless ticket for a site-restricted requester, are OK', async () => {
    user();
    shared.getUserPermissions.mockResolvedValue(orgUser({ allowedSiteIds: ['site-A'] }));
    queueRead([target('ticket')]);
    queueRead([{ id: 'ticket-1', deviceId: DEVICE_ID, deletedAt: null }]);
    queueRead([{ id: DEVICE_ID, siteId: 'site-A' }]);
    await expect(lostForTargets()).resolves.toEqual({ lost: false, detail: null });

    user();
    queueRead([target('ticket')]);
    queueRead([{ id: 'ticket-1', deviceId: null, deletedAt: null }]);
    await expect(lostForTargets()).resolves.toEqual({ lost: false, detail: null });
  });
});

// ---------------------------------------------------------------------------
// R1a-0 review round (Opus): appended regression cases.
// ---------------------------------------------------------------------------
describe('requesterAccessLostForTargets — review-round fixes (R1a-0)', () => {
  beforeEach(() => { reads.length = 0; shared.selectMock.mockReset(); });
  const user = () => queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);

  it('a DETACHED target alongside a live one is lost: the sealed plan may still act on the detached target', async () => {
    user();
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('ticket'), target('contact', { contactId: null, detachedAt: new Date('2026-10-20T00:00:00Z') })]);
    queueRead([{ id: 'ticket-1', deviceId: null, deletedAt: null }]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/detached/) });
  });

  it('the target read is scoped by org_id and task_id and reads detached rows too (to refuse them)', async () => {
    user();
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('contact', { contactId: null, detachedAt: new Date() })]);
    await expect(lostForTargets()).resolves.toMatchObject({ lost: true, detail: expect.stringMatching(/detached/) });
    expect(reads[1]!.table).toBe(aiOperatorTaskTargets);
    const p = eqs(reads[1]!.where);
    expect(p.get(aiOperatorTaskTargets.orgId)).toBe(ORG_ID);
    expect(p.get(aiOperatorTaskTargets.taskId)).toBe('task-1');
  });

  it('device and ticket-device site checks are made against the device\'s own site', async () => {
    user();
    const perms = orgUser({ allowedSiteIds: ['site-A'] });
    shared.getUserPermissions.mockResolvedValue(perms);
    queueRead([target('device'), target('ticket')]);
    queueRead([{ id: DEVICE_ID, siteId: 'site-A' }]);
    queueRead([{ id: 'ticket-1', deviceId: 'device-2', deletedAt: null }]);
    queueRead([{ id: 'device-2', siteId: 'site-C' }]);
    await expect(lostForTargets()).resolves.toEqual({ lost: false, detail: null });
    expect(shared.canAccessSite.mock.calls).toEqual([[perms, 'site-A'], [perms, 'site-C']]);
  });
});

// ---------------------------------------------------------------------------
// Wisp W02 — a task launched under a delegation grant re-checks the pinned
// ceiling WITH the effect's permission (Wisp design §4.3: "permissions, not
// only access"). Appended; nothing above changes.
// ---------------------------------------------------------------------------
const grantGate = vi.hoisted(() => ({ resolveGrantCeiling: vi.fn(), assertWithinCeiling: vi.fn() }));
vi.mock('../wisp/grantAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wisp/grantAuthority')>();
  grantGate.assertWithinCeiling.mockImplementation(actual.assertWithinCeiling);
  return { ...actual, resolveGrantCeiling: grantGate.resolveGrantCeiling, assertWithinCeiling: grantGate.assertWithinCeiling };
});

describe('requesterAccessLost — delegation grant (Wisp W02)', () => {
  const grantCeiling = (o: Record<string, unknown> = {}) => ({
    grantId: 'g1', revisionId: 'r1', partnerId: 'p1', grantorUserId: USER_ID, scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['devices:execute']), toolAllowlist: null,
    deniedTools: new Set<string>(), orgTerms: new Map(), status: 'active', ...o,
  });
  const grantTask = { orgId: ORG_ID, requesterUserId: USER_ID, grantId: 'g1', grantRevisionId: 'r1' };
  const primeAccessOk = () => {
    queueSelect([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue({ scope: 'partner', partnerId: 'p1' });
    queueSelect([{ id: DEVICE_ID, siteId: 'site-A' }]);
  };

  beforeEach(() => {
    grantGate.resolveGrantCeiling.mockReset();
    grantGate.assertWithinCeiling.mockClear();
  });

  it('a task without a grant never resolves a ceiling (unchanged behaviour)', async () => {
    primeAccessOk();
    await expect(requesterAccessLost({ orgId: ORG_ID, requesterUserId: USER_ID }, DEVICE_ID, { permission: 'devices:execute' }))
      .resolves.toEqual({ lost: false, detail: null });
    expect(grantGate.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('a task with a grant whose ceiling lacks devices:execute is lost with a ceiling detail', async () => {
    primeAccessOk();
    grantGate.resolveGrantCeiling.mockResolvedValue(grantCeiling({ permissionKeys: new Set(['devices:read']) }));
    const result = await requesterAccessLost(grantTask, DEVICE_ID, { permission: 'devices:execute' });
    expect(result.lost).toBe(true);
    expect(result.detail).toMatch(/delegation ceiling \(permission\)/);
  });

  it('GrantInactiveError reads as lost: "the delegation grant is no longer active"', async () => {
    const { GrantInactiveError } = await import('../wisp/grantAuthority');
    primeAccessOk();
    grantGate.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g1', 'paused'));
    await expect(requesterAccessLost(grantTask, DEVICE_ID, { permission: 'devices:execute' }))
      .resolves.toEqual({ lost: true, detail: 'the delegation grant is no longer active' });
  });

  it('the ceiling check receives the device site, not null', async () => {
    primeAccessOk();
    grantGate.resolveGrantCeiling.mockResolvedValue(grantCeiling());
    await expect(requesterAccessLost(grantTask, DEVICE_ID, { permission: 'devices:execute' }))
      .resolves.toEqual({ lost: false, detail: null });
    expect(grantGate.resolveGrantCeiling).toHaveBeenCalledWith('g1', 'r1');
    expect(grantGate.assertWithinCeiling).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'g1' }),
      { orgId: ORG_ID, siteId: 'site-A', permission: 'devices:execute' },
    );
  });

  it('without an explicit effect the device-keyed gate checks devices:execute (the device command it guards)', async () => {
    primeAccessOk();
    grantGate.resolveGrantCeiling.mockResolvedValue(grantCeiling({ permissionKeys: new Set(['devices:read']) }));
    await expect(requesterAccessLost(grantTask, DEVICE_ID)).resolves.toMatchObject({
      lost: true, detail: expect.stringMatching(/\(permission\)/),
    });
    expect(grantGate.assertWithinCeiling).toHaveBeenCalledWith(
      expect.anything(), { orgId: ORG_ID, siteId: 'site-A', permission: 'devices:execute' },
    );
  });

  it('a task whose requester is not the grantor is lost (no running on someone else\'s grant)', async () => {
    primeAccessOk();
    grantGate.resolveGrantCeiling.mockResolvedValue(grantCeiling({ grantorUserId: 'someone-else' }));
    await expect(requesterAccessLost(grantTask, DEVICE_ID)).resolves.toMatchObject({
      lost: true, detail: expect.stringMatching(/not the delegation grant's grantor/),
    });
  });

  it('a grant-bearing task with no requester is lost (a grant is always a person\'s)', async () => {
    await expect(requesterAccessLost({ ...grantTask, requesterUserId: null }, DEVICE_ID, { permission: 'devices:execute' }))
      .resolves.toMatchObject({ lost: true });
  });

  it('requesterAccessLostForTargets also checks the ceiling (org + each target device site)', async () => {
    const forTargets = (gate as unknown as {
      requesterAccessLostForTargets: (t: Record<string, unknown>) => Promise<{ lost: boolean; detail: string | null }>;
    }).requesterAccessLostForTargets;
    queueRead([{ id: USER_ID, partnerId: 'p1', status: 'active' }]);
    shared.getUserPermissions.mockResolvedValue(orgUser());
    queueRead([target('device')]);
    queueRead([{ id: DEVICE_ID, siteId: 'site-A' }]);
    grantGate.resolveGrantCeiling.mockResolvedValue(grantCeiling({ orgIds: new Set(['another-org']) }));
    const result = await forTargets({ ...TASK, grantId: 'g1', grantRevisionId: 'r1' });
    expect(result).toMatchObject({ lost: true, detail: expect.stringMatching(/delegation ceiling \(org\)/) });
    expect(grantGate.assertWithinCeiling).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_ID, siteId: 'site-A' });
  });
});
