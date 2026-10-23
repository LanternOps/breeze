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
  expect(nulls(reads[i]!.where)).toContain(aiOperatorTaskTargets.detachedAt);
}

describe('requesterAccessLostForTargets (R1a-0 Task 1f)', () => {
  beforeEach(() => { reads.length = 0; });

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

  it('5: a task whose only target is detached (no live target) is lost; the read filters org, task and detached_at', async () => {
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
