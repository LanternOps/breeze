/**
 * Contact resolution for contact-targeted admission (Recipe Library §8, D-R1-6;
 * W06 R1a Task 9).
 *
 * Everything here runs in system scope, so the explicit `org_id` predicate on
 * every read IS the tenancy boundary — each read's predicate is asserted by
 * rendering the drizzle SQL. A free-text hint never creates a contact (a
 * "Dana in accounting" row is junk); an email hint with no match is created
 * only inside the admission transaction, under the same per-address advisory
 * lock the inbound-email path takes, so the two can never both create it.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  wheres: [] as unknown[],
  executes: [] as unknown[],
  inserts: 0,
  m365Read: vi.fn(),
  resolveContextByOrg: vi.fn(),
  dir: null as any,
  createContact: vi.fn(),
  matchContactByEmail: vi.fn(),
  contexts: [] as unknown[],
}));

vi.mock('../../db', () => {
  const chain = () => {
    const c: any = {
      from: () => c, innerJoin: () => c, for: () => c,
      where: (w: unknown) => { h.wheres.push(w); return c; },
      limit: async () => h.selectQueue.shift() ?? [],
    };
    return c;
  };
  return {
    db: {
      select: () => chain(),
      insert: () => { h.inserts += 1; throw new Error('contactResolution must not insert directly'); },
      execute: async (q: unknown) => { h.executes.push(q); return []; },
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbAccessContext: async (ctx: unknown, fn: () => Promise<unknown>) => { h.contexts.push(ctx); return fn(); },
  };
});
vi.mock('../m365ControlPlane/readActionService', () => ({
  executeM365ReadActionByOrg: (...a: unknown[]) => h.m365Read(...a),
}));
vi.mock('../aiToolsGoogle', () => ({
  resolveContextByOrg: (...a: unknown[]) => h.resolveContextByOrg(...a),
  canonicalizeUserEmail: (raw: string) => (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null),
}));
vi.mock('../googleClient', () => ({ getDirectoryClient: () => h.dir }));
vi.mock('../contacts/crud', () => ({
  createContact: (...a: unknown[]) => h.createContact(...a),
  matchContactByEmail: (...a: unknown[]) => h.matchContactByEmail(...a),
  normalizeContactEmail: (e: string | null | undefined) => (e ? e.trim().toLowerCase() : null),
}));

import {
  createContactForTask,
  findLiveTaskForContact,
  identifyTaskPerson,
  lockContactForRecipe,
  pinContact,
  resolveProviderAccounts,
} from './contactResolution';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const C1 = '00000000-0000-4000-8000-000000000001';
const C2 = '00000000-0000-4000-8000-000000000002';
const dialect = new PgDialect();
const render = (w: unknown) => dialect.sqlToQuery(w as SQL);

function expectOrgPredicate(w: unknown): void {
  const q = render(w);
  expect(q.sql).toMatch(/"org_id" = \$\d/);
  expect(q.params).toContain(ORG);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue = [];
  h.wheres = [];
  h.executes = [];
  h.inserts = 0;
});

describe('identifyTaskPerson', () => {
  it('1. an explicit contactId in the org resolves, not created', async () => {
    h.selectQueue = [[{ id: C1, name: 'Dana Ruiz', email: 'dana@customer.example' }]];
    const r = await identifyTaskPerson(ORG, { contactId: C1, personHint: null });
    expect(r).toEqual({ ok: true, kind: 'existing', contactId: C1, label: 'Dana Ruiz', email: 'dana@customer.example' });
    expectOrgPredicate(h.wheres[0]);
    expect(render(h.wheres[0]).params).toContain(C1);
  });

  it('2. a contactId in ANOTHER org is contact_not_in_org, and the read carried the org predicate', async () => {
    h.selectQueue = [[]];
    const r = await identifyTaskPerson(ORG, { contactId: C2, personHint: null });
    expect(r).toMatchObject({ ok: false, reason: 'contact_not_in_org' });
    expectOrgPredicate(h.wheres[0]);
  });

  it('3. an email-shaped hint matching one contact resolves it', async () => {
    h.selectQueue = [[{ id: C1, name: null, email: 'dana@customer.example' }]];
    const r = await identifyTaskPerson(ORG, { contactId: null, personHint: 'Dana@Customer.example' });
    expect(r).toMatchObject({ ok: true, kind: 'existing', contactId: C1, label: 'dana@customer.example' });
    expectOrgPredicate(h.wheres[0]);
    expect(render(h.wheres[0]).params).toContain('dana@customer.example');
  });

  it('4. an email-shaped hint matching none is a NEW person — nothing is written yet', async () => {
    h.selectQueue = [[]];
    const r = await identifyTaskPerson(ORG, { contactId: null, personHint: 'new.person@customer.example' });
    expect(r).toEqual({ ok: true, kind: 'new', email: 'new.person@customer.example', label: 'new.person@customer.example' });
    expect(h.inserts).toBe(0);
    expect(h.createContact).not.toHaveBeenCalled();
  });

  it('5. a free-text hint resolves only on exactly one name match, and NEVER creates', async () => {
    h.selectQueue = [[{ id: C1, name: 'Dana Ruiz', email: null }]];
    expect(await identifyTaskPerson(ORG, { contactId: null, personHint: 'Dana Ruiz' }))
      .toMatchObject({ ok: true, kind: 'existing', contactId: C1 });
    expectOrgPredicate(h.wheres[0]);
    h.selectQueue = [[]];
    expect(await identifyTaskPerson(ORG, { contactId: null, personHint: 'Nobody Here' }))
      .toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(h.createContact).not.toHaveBeenCalled();
    expect(h.inserts).toBe(0);
  });

  it('6. a hint matching two contacts is ambiguous and creates no third', async () => {
    h.selectQueue = [[{ id: C1, name: 'Dana', email: 'x@y.example' }, { id: C2, name: 'Dana', email: 'x@y.example' }]];
    expect(await identifyTaskPerson(ORG, { contactId: null, personHint: 'x@y.example' }))
      .toMatchObject({ ok: false, reason: 'ambiguous' });
    h.selectQueue = [[{ id: C1, name: 'Dana A' }, { id: C2, name: 'Dana B' }]];
    expect(await identifyTaskPerson(ORG, { contactId: null, personHint: 'Dana' }))
      .toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(h.createContact).not.toHaveBeenCalled();
  });

  it('a free-text hint matches the WHOLE name exactly (case-insensitive), never a substring', async () => {
    h.selectQueue = [[]];
    await identifyTaskPerson(ORG, { contactId: null, personHint: 'Dana Ruiz' });
    const q = render(h.wheres[0]);
    expect(q.sql).toContain('lower(btrim(');
    expect(q.sql.toLowerCase()).not.toContain('ilike');
    expect(q.params).toContain('dana ruiz');
  });
});

describe('lockContactForRecipe (D-R1-6)', () => {
  it('7. takes a transaction-scoped advisory lock over (recipe, contact); a different recipe is a different key', async () => {
    await lockContactForRecipe(ORG, 'identity_offboarding', C1);
    await lockContactForRecipe(ORG, 'identity_onboarding', C1);
    const [a, b] = h.executes.map(render);
    expect(a!.sql).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(a!.params).toEqual([`ai_operator:identity_offboarding:${C1}`]);
    expect(b!.params).toEqual([`ai_operator:identity_onboarding:${C1}`]);
  });
});

describe('findLiveTaskForContact', () => {
  it('8. filters to the org, the recipe, the contact target, and NON-terminal states', async () => {
    h.selectQueue = [[]];
    expect(await findLiveTaskForContact(ORG, 'identity_offboarding', C1)).toBeNull();
    const q = render(h.wheres[0]);
    expect(q.sql).toMatch(/"ai_operator_tasks"\."org_id" = \$\d/);
    expect(q.sql).toMatch(/"ai_operator_task_targets"\."org_id" = \$\d/);
    expect(q.sql).toContain('not in');
    expect(q.params).toEqual(expect.arrayContaining([ORG, 'identity_offboarding', C1, 'completed', 'failed', 'cancelled']));
    h.selectQueue = [[{ id: 'live-task' }]];
    expect(await findLiveTaskForContact(ORG, 'identity_offboarding', C1)).toEqual({ taskId: 'live-task' });
  });
});

describe('pinContact / createContactForTask (inside the admission transaction)', () => {
  it('pinContact re-reads the contact FOR KEY SHARE with the org predicate; gone is contact_not_in_org', async () => {
    h.selectQueue = [[{ id: C1 }]];
    expect(await pinContact(ORG, C1)).toBe(true);
    expectOrgPredicate(h.wheres[0]);
    h.selectQueue = [[]];
    expect(await pinContact(ORG, C1)).toBe(false);
  });

  it('creates under the SAME per-address advisory lock the inbound-email path takes, then re-matches', async () => {
    h.matchContactByEmail.mockResolvedValue({ kind: 'no-match' });
    h.createContact.mockResolvedValue({ id: C2 });
    const r = await createContactForTask(ORG, 'new@customer.example', null);
    expect(r).toEqual({ ok: true, contactId: C2, created: true });
    const lock = render(h.executes[0]);
    expect(lock.sql).toContain('pg_advisory_xact_lock(hashtext(');
    expect(lock.params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG}:new@customer.example`]);
    expect(h.createContact).toHaveBeenCalledWith(
      expect.anything(),
      { orgId: ORG, email: 'new@customer.example', name: null, roles: [] },
      { userId: null, destinationSource: 'ai_tool' },
    );
  });

  it('a contact that appeared since identification is used, not duplicated; two is ambiguous', async () => {
    h.matchContactByEmail.mockResolvedValue({ kind: 'contact', contactId: C1 });
    expect(await createContactForTask(ORG, 'new@customer.example', null)).toEqual({ ok: true, contactId: C1, created: false });
    h.matchContactByEmail.mockResolvedValue({ kind: 'none', reason: 'shared-mailbox' });
    expect(await createContactForTask(ORG, 'new@customer.example', null)).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(h.createContact).not.toHaveBeenCalled();
  });
});

describe('resolveProviderAccounts', () => {
  beforeEach(() => {
    h.resolveContextByOrg.mockResolvedValue({ conn: { id: 'g-conn', adminEmail: 'admin@customer.example' }, keyJson: '{}' });
    h.dir = { users: { get: vi.fn(async () => ({ data: { id: '101', primaryEmail: 'Dana@customer.example' } })) } };
    h.m365Read.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: 'obj-1', userPrincipalName: 'dana@customer.example' } });
  });

  it('uses existing contact_external_links first (org-predicated) and looks up only the missing provider', async () => {
    // links, then the m365 actions connection id
    h.selectQueue = [[{ system: 'm365', externalId: 'obj-linked' }], [{ id: 'm-conn', profile: 'customer-graph-actions' }]];
    const r = await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'Dana' });
    expect(r.accounts).toEqual([
      { provider: 'm365', externalId: 'obj-linked', principalLabel: 'dana@customer.example', connectionId: 'm-conn', fromLink: true },
      { provider: 'google', externalId: '101', principalLabel: 'dana@customer.example', connectionId: 'g-conn', fromLink: false },
    ]);
    expect(h.m365Read).not.toHaveBeenCalled();
    expectOrgPredicate(h.wheres[0]);
  });

  it('a new person (no contact yet) is looked up on both providers by address', async () => {
    h.selectQueue = [[{ id: 'm-conn', profile: 'customer-graph-actions' }]];
    const r = await resolveProviderAccounts(ORG, { contactId: null, email: 'dana@customer.example', label: 'x' });
    expect(r.accounts.map((a) => a.provider).sort()).toEqual(['google', 'm365']);
    expect(h.m365Read).toHaveBeenCalledWith(ORG, { type: 'm365.user.get', userIdOrUpn: 'dana@customer.example' });
  });

  it('REFUSES a provider account whose primary address is not the one asked for (alias -> another person)', async () => {
    h.m365Read.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: 'obj-9', userPrincipalName: 'sam@customer.example', mail: 'sam@customer.example' } });
    h.dir.users.get.mockResolvedValue({ data: { id: '909', primaryEmail: 'sam@customer.example' } });
    h.selectQueue = [[{ id: 'm-conn', profile: 'customer-graph-actions' }]];
    const r = await resolveProviderAccounts(ORG, { contactId: null, email: 'dana@customer.example', label: 'x' });
    expect(r.accounts).toEqual([]);
    expect(r.problems.join(' ')).toMatch(/m365: dana@customer.example resolves to a different primary account \(sam@customer.example\)/);
    expect(r.problems.join(' ')).toMatch(/google: dana@customer.example resolves to a different primary account/);
  });

  it('accepts an M365 account whose mail (not UPN) is the address asked for', async () => {
    h.m365Read.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: 'obj-2', userPrincipalName: 'dana_ext@tenant.example', mail: 'Dana@customer.example' } });
    h.selectQueue = [[{ id: 'm-conn', profile: 'customer-graph-actions' }]];
    const r = await resolveProviderAccounts(ORG, { contactId: null, email: 'dana@customer.example', label: 'x' });
    expect(r.accounts.find((a) => a.provider === 'm365')).toMatchObject({ externalId: 'obj-2' });
  });

  it('an org with NO Microsoft 365 connection row is not looked up there, and that is not a problem', async () => {
    h.selectQueue = [[], [], [{ id: 'g-conn' }]];
    const r = await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'x' });
    expect(h.m365Read).not.toHaveBeenCalled();
    expect(r.accounts.map((x) => x.provider)).toEqual(['google']);
    expect(r.problems).toEqual([]);
  });

  it('an org with only the READ-profile M365 connection is still looked up (the lookup reads through it)', async () => {
    h.selectQueue = [[], [{ id: 'm-read', profile: 'customer-graph-read' }], []];
    const r = await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'x' });
    expect(h.m365Read).toHaveBeenCalled();
    expect(r.accounts.find((x) => x.provider === 'm365')).toMatchObject({ externalId: 'obj-1', connectionId: null });
  });

  it('a REVOKED or consent-pending M365 row is not looked through, but is a named problem — never a silent skip', async () => {
    for (const status of ['revoked', 'pending-consent']) {
      h.m365Read.mockClear();
      h.selectQueue = [[], [{ id: 'm-conn', profile: 'customer-graph-actions', status }], [{ id: 'g-conn' }]];
      const r = await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'x' });
      expect(h.m365Read, status).not.toHaveBeenCalled();
      expect(r.problems, status).toEqual([`m365 connection is ${status}, so Breeze could not look this person up in Microsoft 365`]);
    }
  });

  it('a Google connection that EXISTS but is unusable is a problem even with no link — never a silent skip', async () => {
    h.resolveContextByOrg.mockResolvedValue({ error: 'connection inactive' });
    h.selectQueue = [[], [{ id: 'm-conn', profile: 'customer-graph-actions' }], [{ id: 'g-conn' }]];
    const r = await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'x' });
    expect(r.accounts.map((x) => x.provider)).toEqual(['m365']);
    expect(r.problems).toEqual(['google connection unavailable']);
    // …and no Google connection row at all is not one.
    h.selectQueue = [[], [{ id: 'm-conn', profile: 'customer-graph-actions' }], []];
    expect((await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'x' })).problems).toEqual([]);
  });

  it('both provider lookups resolve their connection in a context scoped to exactly this org', async () => {
    h.contexts = [];
    h.selectQueue = [[], [{ id: 'm-conn', profile: 'customer-graph-actions' }], [{ id: 'g-conn' }]];
    await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'x' });
    expect(h.contexts).toHaveLength(2);
    for (const c of h.contexts) expect(c).toMatchObject({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
  });

  it('a provider error is reported, never thrown; no address and no links means no accounts', async () => {
    h.m365Read.mockResolvedValue({ ok: false, code: 'connection_not_ready', message: 'not ready' });
    h.dir.users.get.mockRejectedValue(new Error('google down'));
    // links (none), then the M365 connection row, then the Google connection row
    h.selectQueue = [[], [{ id: 'm-conn', profile: 'customer-graph-actions' }], [{ id: 'g-conn' }]];
    const r = await resolveProviderAccounts(ORG, { contactId: C1, email: 'dana@customer.example', label: 'x' });
    expect(r.accounts).toEqual([]);
    expect(r.problems.join(' ')).toMatch(/m365.*connection_not_ready/);
    expect(r.problems.join(' ')).toMatch(/google/);
    h.selectQueue = [[]];
    expect((await resolveProviderAccounts(ORG, { contactId: C1, email: null, label: 'x' })).accounts).toEqual([]);
  });
});
