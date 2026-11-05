/**
 * `resolve_accounts` — adopting ONLY the accounts this task created, then the
 * one-transaction stage transition (W07 Task 9; Amendment B1 "Resolve only
 * what this task created", B2 "The stage transition is ONE transaction",
 * B.0 item 13, B.9 item 9, B.10 Q4).
 *
 * Offboarding freezes accounts at admission because they already exist.
 * Onboarding cannot: `external_id` is NOT NULL and there is nothing to put in
 * it until the create has settled. So the freeze moves here, and the failure
 * this file exists to prevent is ADOPTING A STRANGER: a read by UPN after a
 * collision finds the existing holder of that name, and provisioning would
 * then grant licences and groups to someone else. Hence:
 *
 *   1. M365 resolves only from THIS task's own `m365_create_user` operation —
 *      matched on org, task, step, revision, operation key AND argument
 *      digest — whose projected NON-SECRET result proves the create, then a
 *      read by the returned immutable id whose UPN must be the one requested.
 *      Never a UPN lookup; never the whole `result` column (it holds the
 *      sealed credential).
 *   2. Google resolves only when snapshot 1 recorded the address strictly
 *      free AND a user ticked the manual-create item, by exact canonical
 *      primary email.
 *   3. The in-transaction half guards, bumps r → r+1, freezes, links and
 *      writes snapshot 2, and a guard miss THROWS a typed sentinel (the
 *      leased write commits whenever its callback returns).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, is, Column, SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityOnboardingInputSchema, type IdentityOnboardingInput } from '@breeze/shared';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  m365Read: vi.fn(),
  resolveContextByOrg: vi.fn(),
  readHumanWorkStep: vi.fn(),
  freezeTargetAccount: vi.fn(),
  upsertContactExternalLinks: vi.fn(),
  bumpPlanRevisionInTx: vi.fn(),
  lockAndCheckAccountReservations: vi.fn(async () => null),
  dir: null as any,
  /** Module-db select results, queued per table name. */
  queue: {} as Record<string, Row[][]>,
  selects: [] as Array<{ table: string; projection: Record<string, unknown> | undefined; where: unknown }>,
}));

vi.mock('../m365ControlPlane/readActionService', () => ({
  executeM365ReadActionByOrg: (...args: unknown[]) => h.m365Read(...args),
}));
vi.mock('../aiToolsGoogle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiToolsGoogle')>()),
  resolveContextByOrg: (...args: unknown[]) => h.resolveContextByOrg(...args),
}));
vi.mock('../googleClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../googleClient')>()),
  getDirectoryClient: () => h.dir,
}));
vi.mock('./humanWorkService', () => ({ readHumanWorkStep: h.readHumanWorkStep }));
vi.mock('./accountReservations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lockAndCheckAccountReservations: h.lockAndCheckAccountReservations,
}));
vi.mock('./targetService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./targetService')>()),
  freezeTargetAccount: h.freezeTargetAccount,
  upsertContactExternalLinks: h.upsertContactExternalLinks,
}));
vi.mock('./planApproval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./planApproval')>()),
  bumpPlanRevisionInTx: h.bumpPlanRevisionInTx,
}));
vi.mock('../../db', async () => {
  const { getTableName: tableName } = await import('drizzle-orm');
  const select = (projection?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const name = tableName(table as never);
      const rec = { table: name, projection, where: undefined as unknown };
      h.selects.push(rec);
      const c: any = {
        where: (w: unknown) => { rec.where = w; return c; },
        orderBy: () => c,
        for: () => c,
        limit: async () => h.queue[name]?.shift() ?? [],
      };
      c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(h.queue[name]?.shift() ?? []).then(res, rej);
      return c;
    },
  });
  return {
    db: { select },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

import { aiOperatorOperations } from '../../db/schema/aiOperatorTasks';
import { DiscoveryTransientError } from './identityDiscovery';
import { effectArgumentDigest, planEffectOperationKey } from './planApproval';
import { sealPlanningSnapshot } from './planningSnapshot';
import {
  buildIdentityOnboardingCreatePlan,
  identityOnboardingCreateFactsSchema,
  identityOnboardingProvisionFactsSchema,
} from './recipes/identityOnboarding';
import {
  commitOnboardingStageTransition,
  OnboardingStageTransitionAbort,
  resolveCreatedAccounts,
  type ResolveCreatedAccountsResult,
} from './onboardingAccounts';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const TASK = '00000000-0000-4000-8000-0000000000bb';
const CONTACT = '00000000-0000-4000-8000-000000000001';
const CONTACT_TARGET = '00000000-0000-4000-8000-0000000000e1';
const DISCOVER_STEP = '00000000-0000-4000-8000-0000000000d1';
const RESOLVE_STEP = '00000000-0000-4000-8000-0000000000d2';
const USER_ID = '00000000-0000-4000-8000-0000000000c1';
const STRANGER_ID = '00000000-0000-4000-8000-0000000000c9';
const M365_CONN = '00000000-0000-4000-8000-0000000000f1';
const GOOGLE_CONN = '00000000-0000-4000-8000-0000000000f2';
const R = 4;
const NOW = new Date('2026-10-24T12:00:00.000Z');

const INPUT: IdentityOnboardingInput = identityOnboardingInputSchema.parse({
  displayName: 'Priya Raman',
  m365: { userPrincipalName: 'Priya@customer.example', mailNickname: 'priya', usageLocation: 'CA' },
  google: { primaryEmail: 'priya@customer.example', givenName: 'Priya', familyName: 'Raman' },
});
/** Same M365 block as INPUT, so the planned create (and its digest) is identical. */
const M365_ONLY: IdentityOnboardingInput = identityOnboardingInputSchema.parse({
  displayName: 'Priya Raman',
  m365: { userPrincipalName: 'Priya@customer.example', mailNickname: 'priya', usageLocation: 'CA' },
});

function facts(over: { m365?: unknown; google?: unknown; degradedTools?: string[] } = {}) {
  return {
    stage: 'create',
    targets: { contactTargetId: CONTACT_TARGET, contactLabel: 'Priya Raman' },
    collisions: {
      m365: 'm365' in over ? over.m365 : { upnTaken: false, existingObjectId: null },
      google: 'google' in over ? over.google : { emailTaken: false, existingUserId: null },
    },
    seats: { m365: [] },
    groups: { m365: [], google: [] },
    modelAfter: null,
    degradedTools: over.degradedTools ?? [],
    capabilityReadiness: {},
    flags: [],
    truncated: [],
  };
}

const CREATE = buildIdentityOnboardingCreatePlan(INPUT, facts())[0]!;
const OP_KEY = planEffectOperationKey({
  stepKey: 'create_accounts', planRevision: R, toolName: 'm365_create_user', targetId: CONTACT_TARGET, ordinal: CREATE.ordinal,
});
const DIGEST = effectArgumentDigest(CREATE);

/** The PROJECTED operation row the resolver's select returns (never `result` itself). */
function opRow(over: Row = {}): Row {
  return {
    id: 'op-1', orgId: ORG, taskId: TASK, taskStepKey: 'create_accounts', planRevision: R,
    operationKey: OP_KEY, argumentDigest: DIGEST, resultState: 'succeeded',
    resultSuccess: 'true', resultAction: 'm365.user.create', resultUserId: USER_ID,
    resultUserPrincipalName: 'priya@customer.example',
    ...over,
  };
}

function base(input = INPUT, f: Record<string, unknown> = facts()) {
  return { orgId: ORG, taskId: TASK, attemptOrdinal: 0, createPlanRevision: R, input, facts: f };
}

const TICKED = {
  stepId: 'hw-1', state: 'succeeded', dependencyId: 'item-1', checklistItemId: 'item-1',
  itemDoneAt: NOW, itemDoneByUserId: '00000000-0000-4000-8000-00000000aa01', itemLabel: 'Create the account',
};

function m365User(id: string, upn: string) {
  return { ok: true, kind: 'resource', resource: { id, userPrincipalName: upn } };
}

function googleNotFound() {
  return Object.assign(new Error('Resource Not Found: userKey'), { code: 404, response: { status: 404 } });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.queue = {};
  h.selects = [];
  h.m365Read.mockResolvedValue(m365User(USER_ID, 'priya@customer.example'));
  h.resolveContextByOrg.mockResolvedValue({ conn: { id: GOOGLE_CONN, adminEmail: 'admin@customer.example' }, keyJson: '{}' });
  h.dir = { users: { get: vi.fn().mockResolvedValue({ data: { id: '900100', primaryEmail: 'Priya@customer.example' } }) } };
  h.readHumanWorkStep.mockResolvedValue(TICKED);
});

function queueM365(rows: Row[] = [opRow()], conns: Row[] = [{ id: M365_CONN, profile: 'customer-graph-actions' }]) {
  h.queue.ai_operator_operations = [rows];
  h.queue.m365_connections = [conns];
}

const okOf = (r: ResolveCreatedAccountsResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${'detail' in r ? r.detail : ''}`);
  return r;
};

describe('resolveCreatedAccounts — M365 only from this task’s own create operation', () => {
  it('resolves the created user by its immutable id, read back through the audited read path', async () => {
    queueM365();
    const r = okOf(await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null }))));
    expect(r.accounts.m365).toEqual({ externalId: USER_ID, principalLabel: 'priya@customer.example' });
    expect(r.accounts.google).toBeNull();
    expect(r.connectionIds.m365).toBe(M365_CONN);
    // The read is BY ID — never by UPN.
    expect(h.m365Read).toHaveBeenCalledTimes(1);
    expect(h.m365Read).toHaveBeenCalledWith(ORG, { type: 'm365.user.get', userIdOrUpn: USER_ID });
  });

  it('the operation query is scoped to org, task, step, revision and the expected key', async () => {
    queueM365();
    await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    const sel = h.selects.find((s) => s.table === 'ai_operator_operations')!;
    const q = new PgDialect().sqlToQuery(sel.where as SQL);
    for (const col of ['org_id', 'task_id', 'task_step_key', 'plan_revision', 'operation_key']) {
      expect(q.sql, col).toMatch(new RegExp(`"${col}" = \\$\\d`));
    }
    expect(q.params).toEqual(expect.arrayContaining([ORG, TASK, 'create_accounts', R, OP_KEY]));
  });

  it('NEVER selects the whole `result` column — only the four non-secret keys, projected in SQL', async () => {
    queueM365();
    await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    const sel = h.selects.find((s) => s.table === 'ai_operator_operations')!;
    expect(sel.projection).toBeDefined();
    const dialect = new PgDialect();
    const projectedKeys: string[] = [];
    for (const [alias, v] of Object.entries(sel.projection!)) {
      expect(v, alias).not.toBe(aiOperatorOperations.result);
      if (is(v, Column)) {
        expect((v as Column).name, alias).not.toBe('result');
        continue;
      }
      expect(is(v, SQL), alias).toBe(true);
      const text = dialect.sqlToQuery(v as SQL).sql;
      if (!text.includes('"result"')) continue;
      const m = /"result"\s*->>\s*'([A-Za-z]+)'\s*$/.exec(text);
      expect(m, `${alias}: ${text}`).not.toBeNull();
      projectedKeys.push(m![1]!);
    }
    expect(projectedKeys.sort()).toEqual(['action', 'success', 'userId', 'userPrincipalName']);
  });

  it('after a UPN collision nothing is resolved for M365 — even though a user with that UPN exists', async () => {
    // The stranger IS there; a UPN read would find them. The resolver must not look.
    h.m365Read.mockResolvedValue(m365User(STRANGER_ID, 'priya@customer.example'));
    queueM365();
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ m365: { upnTaken: true, existingObjectId: STRANGER_ID }, google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved).toEqual([expect.objectContaining({ provider: 'm365', reason: 'upn_collision' })]);
    expect(h.m365Read).not.toHaveBeenCalled();
    expect(h.selects.some((s) => s.table === 'ai_operator_operations')).toBe(false);
  });

  it('a collision check that could not run (null) resolves nothing either', async () => {
    queueM365();
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ m365: { upnTaken: null, existingObjectId: null }, google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'collision_unchecked' });
    expect(h.m365Read).not.toHaveBeenCalled();
  });

  it('a degraded create (not in the plan) is unresolved — never a lookup fallback', async () => {
    queueM365();
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null, degradedTools: ['m365_create_user'] })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'create_not_planned' });
    expect(h.m365Read).not.toHaveBeenCalled();
  });

  it('missing provenance after an expected create is unresolved, and there is no UPN lookup', async () => {
    queueM365([]);
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'create_operation_missing' });
    expect(h.m365Read).not.toHaveBeenCalled();
  });

  it.each([
    ['another revision', { planRevision: R - 1 }],
    ['another step', { taskStepKey: 'provision_effects' }],
    ['another operation key', { operationKey: `${OP_KEY}x` }],
    ['another argument digest', { argumentDigest: 'f'.repeat(64) }],
    ['another task', { taskId: '00000000-0000-4000-8000-0000000000bc' }],
    ['another org', { orgId: '00000000-0000-4000-8000-0000000000ab' }],
  ])('an operation row with %s is ignored, even when the SQL returned it', async (_label, over) => {
    queueM365([opRow(over)]);
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'create_operation_missing' });
    expect(h.m365Read).not.toHaveBeenCalled();
  });

  it.each([
    ['success is not true', { resultSuccess: 'false' }],
    ['success is absent', { resultSuccess: null }],
    ['the action is another write', { resultAction: 'm365.user.license.assign' }],
    ['the userId is not a GUID', { resultUserId: 'obj-1111' }],
    ['the result names another UPN', { resultUserPrincipalName: 'someone@customer.example' }],
    ['resultState is succeeded but the body is an error', { resultSuccess: null, resultAction: null, resultUserId: null, resultUserPrincipalName: null }],
    ['the body is a success but resultState is unknown', { resultState: 'unknown' }],
  ])('a create whose projected result does not prove it (%s) is unresolved', async (_label, over) => {
    queueM365([opRow(over)]);
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'create_result_unproven' });
    expect(h.m365Read).not.toHaveBeenCalled();
  });

  it('a userPrincipalName mismatch on the read by userId leaves M365 unresolved', async () => {
    h.m365Read.mockResolvedValue(m365User(USER_ID, 'someone.else@customer.example'));
    queueM365();
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'account_mismatch' });
  });

  it('a read that returns a different object id is a mismatch, not an adoption', async () => {
    h.m365Read.mockResolvedValue(m365User(STRANGER_ID, 'priya@customer.example'));
    queueM365();
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'account_mismatch' });
  });

  it('the UPN comparison is canonical (case-insensitive, trimmed)', async () => {
    h.m365Read.mockResolvedValue(m365User(USER_ID, 'PRIYA@Customer.Example'));
    queueM365([opRow({ resultUserPrincipalName: 'Priya@customer.example' })]);
    const r = okOf(await resolveCreatedAccounts(base(INPUT, facts({ google: null }))));
    expect(r.accounts.m365).toEqual({ externalId: USER_ID, principalLabel: 'priya@customer.example' });
  });

  it('a transient M365 fault on the read RETHROWS, so the wake retries (R1’s rule)', async () => {
    h.m365Read.mockResolvedValue({ ok: false, code: 'graph_throttled', message: 'slow down' });
    queueM365();
    await expect(resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })))).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  it('a definitive read failure is unresolved, not a throw', async () => {
    h.m365Read.mockResolvedValue({ ok: false, code: 'graph_not_found', message: 'gone' });
    queueM365();
    const r = await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'm365', reason: 'account_not_found' });
  });

  it('passes a null connection id when the org has no actions-profile connection row', async () => {
    queueM365([opRow()], []);
    const r = okOf(await resolveCreatedAccounts(base(M365_ONLY, facts({ google: null }))));
    expect(r.connectionIds.m365).toBeNull();
  });
});

describe('resolveCreatedAccounts — Google only after a ticked, collision-free manual item', () => {
  const GOOGLE_ONLY = identityOnboardingInputSchema.parse({
    displayName: 'Priya Raman',
    google: { primaryEmail: 'priya@customer.example', givenName: 'Priya', familyName: 'Raman' },
  });

  it('resolves by exact canonical primary email and freezes the immutable id', async () => {
    const r = okOf(await resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null }))));
    expect(r.accounts.google).toEqual({ externalId: '900100', principalLabel: 'priya@customer.example' });
    expect(r.connectionIds.google).toBe(GOOGLE_CONN);
    expect(h.dir.users.get).toHaveBeenCalledWith({ userKey: 'priya@customer.example' });
    expect(h.readHumanWorkStep).toHaveBeenCalledWith(ORG, TASK, 'manual_create_google', 0);
  });

  it.each([
    ['no step row', null],
    ['never linked', { ...TICKED, dependencyId: null, checklistItemId: null, itemLabel: null }],
    ['not ticked', { ...TICKED, itemDoneAt: null, itemDoneByUserId: null }],
    ['ticked with no user', { ...TICKED, itemDoneByUserId: null }],
    ['the item moved tenants (join missed)', { ...TICKED, itemLabel: null }],
  ])('an item that was not ticked by a user (%s) resolves nothing and reads nothing', async (_label, view) => {
    h.readHumanWorkStep.mockResolvedValue(view);
    const r = await resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'google', reason: 'manual_item_not_ticked' });
    expect(h.dir.users.get).not.toHaveBeenCalled();
  });

  it('after an email collision a ticked item still adopts nothing — the holder exists, and is never read', async () => {
    const r = await resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null, google: { emailTaken: true, existingUserId: '900199' } })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'google', reason: 'email_collision' });
    expect(h.dir.users.get).not.toHaveBeenCalled();
  });

  it('an unrun email check (null) resolves nothing', async () => {
    const r = await resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null, google: { emailTaken: null, existingUserId: null } })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'google', reason: 'collision_unchecked' });
  });

  it('an alias lookup landing on a different primary address is a mismatch', async () => {
    h.dir.users.get.mockResolvedValue({ data: { id: '900199', primaryEmail: 'p.raman@customer.example' } });
    const r = await resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'google', reason: 'account_mismatch' });
  });

  it('a not-found read is unresolved; a transient one rethrows', async () => {
    h.dir.users.get.mockRejectedValueOnce(googleNotFound());
    const r = await resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'google', reason: 'account_not_found' });

    h.dir.users.get.mockRejectedValueOnce(Object.assign(new Error('backend'), { code: 503, response: { status: 503 } }));
    await expect(resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null })))).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  it('no usable Google connection is unresolved', async () => {
    h.resolveContextByOrg.mockResolvedValue({ error: 'no_google_connection' });
    const r = await resolveCreatedAccounts(base(GOOGLE_ONLY, facts({ m365: null })));
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved[0]).toMatchObject({ provider: 'google', reason: 'connection_unavailable' });
  });
});

describe('resolveCreatedAccounts — both providers, and refusals', () => {
  it('both resolve independently; one unresolved provider does not stop the other', async () => {
    queueM365();
    const both = okOf(await resolveCreatedAccounts(base()));
    expect(both.accounts.m365?.externalId).toBe(USER_ID);
    expect(both.accounts.google?.externalId).toBe('900100');
    expect(both.unresolved).toEqual([]);

    h.readHumanWorkStep.mockResolvedValue(null);
    queueM365();
    const half = okOf(await resolveCreatedAccounts(base()));
    expect(half.accounts.m365?.externalId).toBe(USER_ID);
    expect(half.accounts.google).toBeNull();
    expect(half.unresolved).toEqual([expect.objectContaining({ provider: 'google', reason: 'manual_item_not_ticked' })]);
  });

  it('neither resolves ⇒ no_account_resolved naming each provider’s reason', async () => {
    const r = await resolveCreatedAccounts(base(INPUT, facts({
      m365: { upnTaken: true, existingObjectId: STRANGER_ID }, google: { emailTaken: true, existingUserId: '900199' },
    })));
    expect(r).toMatchObject({ ok: false, reason: 'no_account_resolved' });
    if (r.ok || r.reason !== 'no_account_resolved') throw new Error('expected no_account_resolved');
    expect(r.unresolved.map((u) => `${u.provider}:${u.reason}`)).toEqual(['google:email_collision', 'm365:upn_collision']);
    expect(r.detail).toMatch(/m365/);
    expect(r.detail).toMatch(/google/);
  });

  it('facts that are not a strict stage-1 snapshot are refused, never read', async () => {
    const r = await resolveCreatedAccounts(base(INPUT, { ...facts(), stage: 'provision' }));
    expect(r).toMatchObject({ ok: false, reason: 'facts_invalid' });
    const r2 = await resolveCreatedAccounts(base(INPUT, { ...facts(), extra: 1 }));
    expect(r2).toMatchObject({ ok: false, reason: 'facts_invalid' });
    expect(h.m365Read).not.toHaveBeenCalled();
    expect(h.selects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The in-transaction half
// ---------------------------------------------------------------------------

const REF1 = sealPlanningSnapshot(facts() as never, NOW);
const SNAPSHOT_REF = { stepId: DISCOVER_STEP, digest: REF1.digest };

function makeTx(over: { task?: Row | null; discover?: Row | null; unsettled?: Row[]; contact?: Row | null; resolve?: Row | null; stepUpdate?: Row[] } = {}) {
  const calls = { selects: [] as string[], updates: [] as Array<{ table: string; set: Row; where: unknown }>, inserts: [] as string[] };
  const rows: Record<string, Row[][]> = {
    ai_operator_tasks: [[...(over.task === null ? [] : [over.task ?? {
      id: TASK, orgId: ORG, revision: R, leaseEpoch: 3, currentStepKey: 'resolve_accounts',
      checkpoint: { version: 1, checkpointKind: 'identity_onboarding', planningSnapshot: SNAPSHOT_REF, createPlanRevision: R },
    }])]],
    ai_operator_task_steps: [
      over.discover === null ? [] : [over.discover ?? { id: DISCOVER_STEP, orgId: ORG, taskId: TASK, stepKey: 'discover' }],
      over.resolve === null ? [] : [over.resolve ?? {
        id: RESOLVE_STEP, orgId: ORG, taskId: TASK, stepKey: 'resolve_accounts', planRevision: R, state: 'running',
        // The coordinator's move copies the TASK checkpoint (with its ref) onto the step row.
        checkpoint: { version: 1, planningSnapshot: SNAPSHOT_REF },
      }],
    ],
    ai_operator_operations: [over.unsettled ?? []],
    ai_operator_task_targets: [over.contact === null ? [] : [over.contact ?? { id: CONTACT_TARGET, orgId: ORG, taskId: TASK, targetKind: 'contact', contactId: CONTACT }]],
  };
  const tx = {
    select: (_p?: unknown) => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);
        calls.selects.push(name);
        const settle = () => Promise.resolve(rows[name]?.shift() ?? []);
        const c: any = {
          where: () => c, orderBy: () => c, for: () => c,
          // `.limit(n)` and `.limit(n).for('update')` both await to the rows.
          limit: () => { const p: any = settle(); p.for = () => p; return p; },
        };
        c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows[name]?.shift() ?? []).then(res, rej);
        return c;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: (where: unknown) => {
          calls.updates.push({ table: getTableName(table as never), set, where });
          return { returning: async () => over.stepUpdate ?? [{ id: RESOLVE_STEP }] };
        },
      }),
    }),
    insert: (table: unknown) => { calls.inserts.push(getTableName(table as never)); throw new Error('unexpected insert'); },
  };
  return { tx, calls };
}

function resolvedBoth(): Extract<ResolveCreatedAccountsResult, { ok: true }> {
  return {
    ok: true,
    accounts: {
      m365: { externalId: USER_ID, principalLabel: 'priya@customer.example' },
      google: { externalId: '900100', principalLabel: 'priya@customer.example' },
    },
    connectionIds: { m365: M365_CONN, google: GOOGLE_CONN },
    unresolved: [],
  };
}

function commitArgs(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG, taskId: TASK, leaseEpoch: 3, attemptOrdinal: 0, createPlanRevision: R,
    snapshotRef: SNAPSHOT_REF, facts: facts(), resolved: resolvedBoth(), now: NOW, ...over,
  };
}

describe('commitOnboardingStageTransition — one transaction, in B2’s order', () => {
  beforeEach(() => {
    h.bumpPlanRevisionInTx.mockResolvedValue({ bumped: true, newRevision: R + 1, supersededApprovalId: 'appr-1', cancelledIntentIds: [] });
    h.freezeTargetAccount.mockResolvedValue({ id: 'acct-1' });
    h.upsertContactExternalLinks.mockResolvedValue(2);
  });

  it('bumps r → r+1, freezes and links both accounts, and writes snapshot 2 once — all on the caller’s handle', async () => {
    const order: string[] = [];
    h.bumpPlanRevisionInTx.mockImplementation(async () => { order.push('bump'); return { bumped: true, newRevision: R + 1, supersededApprovalId: 'appr-1', cancelledIntentIds: [] }; });
    h.freezeTargetAccount.mockImplementation(async (_d: unknown, a: { provider: string }) => { order.push(`freeze:${a.provider}`); return { id: 'acct' }; });
    h.upsertContactExternalLinks.mockImplementation(async () => { order.push('links'); return 2; });
    const { tx, calls } = makeTx();

    const out = await commitOnboardingStageTransition(tx as never, commitArgs());

    expect(order).toEqual(['bump', 'freeze:google', 'freeze:m365', 'links']);
    expect(h.bumpPlanRevisionInTx).toHaveBeenCalledWith(tx, expect.objectContaining({ orgId: ORG, taskId: TASK, fromRevision: R, leaseEpoch: 3 }));
    expect(h.freezeTargetAccount).toHaveBeenCalledWith(tx, expect.objectContaining({
      orgId: ORG, taskId: TASK, targetId: CONTACT_TARGET, provider: 'm365', connectionId: M365_CONN,
      externalId: USER_ID, principalLabel: 'priya@customer.example', actor: { kind: 'coordinator' },
    }));
    expect(h.freezeTargetAccount).toHaveBeenCalledWith(tx, expect.objectContaining({
      provider: 'google', connectionId: GOOGLE_CONN, externalId: '900100', principalLabel: 'priya@customer.example',
    }));
    expect(h.upsertContactExternalLinks).toHaveBeenCalledWith(tx, {
      orgId: ORG, contactId: CONTACT,
      links: [{ system: 'google', externalId: '900100' }, { system: 'm365', externalId: USER_ID }],
    });

    // Snapshot 2: written to the resolve_accounts row, exactly once, after the freeze.
    const stepWrites = calls.updates.filter((u) => u.table === 'ai_operator_task_steps');
    expect(stepWrites).toHaveLength(1);
    expect(calls.updates.filter((u) => u.table !== 'ai_operator_task_steps')).toEqual([]);
    expect(calls.inserts).toEqual([]);
    const written = (stepWrites[0]!.set.checkpoint as Row).planningSnapshot as { facts: Row; version: number };
    expect(written.version).toBe(1);
    const f2 = identityOnboardingProvisionFactsSchema.parse(written.facts);
    expect(f2.stage).toBe('provision');
    expect(f2.accounts).toEqual(resolvedBoth().accounts);
    // Snapshot 1's verified facts ride forward unchanged.
    const { stage: _s1, ...rest1 } = identityOnboardingCreateFactsSchema.parse(facts());
    const { stage: _s2, accounts: _a, ...rest2 } = f2;
    expect(rest2).toEqual(rest1);

    expect(out).toMatchObject({
      newRevision: R + 1, resolveStepId: RESOLVE_STEP, contactTargetId: CONTACT_TARGET,
      frozen: ['google', 'm365'], supersededApprovalId: 'appr-1',
      snapshot: { stepId: RESOLVE_STEP, digest: sealPlanningSnapshot(written.facts as never, NOW).digest },
    });
    expect(out.envelope).toEqual(written);
  });

  it('freezes and links only the providers that resolved', async () => {
    const { tx } = makeTx();
    const resolved = { ...resolvedBoth(), accounts: { m365: resolvedBoth().accounts.m365, google: null } };
    const out = await commitOnboardingStageTransition(tx as never, commitArgs({ resolved }));
    expect(out.frozen).toEqual(['m365']);
    expect(h.freezeTargetAccount).toHaveBeenCalledTimes(1);
    expect(h.upsertContactExternalLinks).toHaveBeenCalledWith(tx, { orgId: ORG, contactId: CONTACT, links: [{ system: 'm365', externalId: USER_ID }] });
  });

  const guardCases: Array<[string, Parameters<typeof makeTx>[0], Record<string, unknown>, string]> = [
    ['the task revision moved', { task: { id: TASK, orgId: ORG, revision: R + 1, leaseEpoch: 3, currentStepKey: 'resolve_accounts', checkpoint: { planningSnapshot: SNAPSHOT_REF } } }, {}, 'revision_moved'],
    ['the task row is gone', { task: null }, {}, 'revision_moved'],
    ['the current step is not resolve_accounts', { task: { id: TASK, orgId: ORG, revision: R, leaseEpoch: 3, currentStepKey: 'provision_effects', checkpoint: { planningSnapshot: SNAPSHOT_REF } } }, {}, 'wrong_step'],
    ['the ref was re-pointed', { task: { id: TASK, orgId: ORG, revision: R, leaseEpoch: 3, currentStepKey: 'resolve_accounts', checkpoint: { planningSnapshot: { stepId: RESOLVE_STEP, digest: REF1.digest } } } }, {}, 'snapshot_ref_moved'],
    ['the ref row is not discover', { discover: { id: DISCOVER_STEP, orgId: ORG, taskId: TASK, stepKey: 'resolve_accounts' } }, {}, 'snapshot_ref_moved'],
    ['an operation at r is pending/unknown', { unsettled: [{ id: 'op-9' }] }, {}, 'operation_unsettled'],
    ['the contact target is detached', { contact: { id: CONTACT_TARGET, orgId: ORG, taskId: TASK, targetKind: 'contact', contactId: null } }, {}, 'contact_target_missing'],
    ['the resolve_accounts row is missing', { resolve: null }, {}, 'resolve_step_missing'],
    ['snapshot 2 is already on the row', { resolve: { id: RESOLVE_STEP, orgId: ORG, taskId: TASK, stepKey: 'resolve_accounts', planRevision: R, state: 'running', checkpoint: { planningSnapshot: { version: 1, capturedAt: NOW.toISOString(), facts: {} } } } }, {}, 'snapshot_already_written'],
    ['the caller’s revision is not the create revision', {}, { createPlanRevision: R - 1 }, 'revision_moved'],
    ['nothing resolved', {}, { resolved: { ...resolvedBoth(), accounts: { m365: null, google: null } } }, 'nothing_resolved'],
    ['a resolved account contradicts a snapshot-1 collision', {}, { facts: facts({ m365: { upnTaken: true, existingObjectId: STRANGER_ID } }) }, 'facts_invalid'],
  ];
  it.each(guardCases)('a guard miss (%s) THROWS the sentinel and writes nothing', async (_label, txOver, argOver, guard) => {
    const { tx, calls } = makeTx(txOver);
    const err = await commitOnboardingStageTransition(tx as never, commitArgs(argOver)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingStageTransitionAbort);
    expect((err as OnboardingStageTransitionAbort).guard).toBe(guard);
    expect(h.bumpPlanRevisionInTx).not.toHaveBeenCalled();
    expect(h.freezeTargetAccount).not.toHaveBeenCalled();
    expect(h.upsertContactExternalLinks).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([]);
    expect(calls.inserts).toEqual([]);
  });

  it('#9981: an account another task holds aborts as account_reserved before the bump, naming the holder; nothing is written', async () => {
    h.lockAndCheckAccountReservations.mockResolvedValueOnce({
      taskId: 'task-holder', orgId: ORG, provider: 'm365', externalId: USER_ID, principalLabel: 'priya@customer.example',
      taskState: 'running', taskOutcome: null, fromMergedOrg: false,
    } as never);
    const { tx, calls } = makeTx();
    const err = await commitOnboardingStageTransition(tx as never, commitArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingStageTransitionAbort);
    expect((err as OnboardingStageTransitionAbort).guard).toBe('account_reserved');
    expect((err as Error).message).toContain('task-holder');
    // The accounts this transition is about to freeze, on the caller's handle, excluding itself.
    expect(h.lockAndCheckAccountReservations).toHaveBeenCalledWith(tx, ORG, [
      { provider: 'google', externalId: '900100' }, { provider: 'm365', externalId: USER_ID },
    ], { excludeTaskId: TASK });
    expect(h.bumpPlanRevisionInTx).not.toHaveBeenCalled();
    expect(h.freezeTargetAccount).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([]);
  });

  it('a bump that is not `bumped: true` throws, and nothing is frozen or written after it', async () => {
    h.bumpPlanRevisionInTx.mockResolvedValue({ bumped: false, newRevision: R, supersededApprovalId: null, cancelledIntentIds: [] });
    const { tx, calls } = makeTx();
    const err = await commitOnboardingStageTransition(tx as never, commitArgs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingStageTransitionAbort);
    expect((err as OnboardingStageTransitionAbort).guard).toBe('bump_lost');
    expect(h.freezeTargetAccount).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([]);
  });

  it('a bump to anything but r+1 throws', async () => {
    h.bumpPlanRevisionInTx.mockResolvedValue({ bumped: true, newRevision: R + 2, supersededApprovalId: null, cancelledIntentIds: [] });
    const { tx } = makeTx();
    const err = await commitOnboardingStageTransition(tx as never, commitArgs()).catch((e: unknown) => e);
    expect((err as OnboardingStageTransitionAbort).guard).toBe('bump_lost');
    expect(h.freezeTargetAccount).not.toHaveBeenCalled();
  });

  it('a lost snapshot-2 CAS (a concurrent writer) throws, so the transaction rolls back', async () => {
    const { tx } = makeTx({ stepUpdate: [] });
    const err = await commitOnboardingStageTransition(tx as never, commitArgs()).catch((e: unknown) => e);
    expect((err as OnboardingStageTransitionAbort).guard).toBe('snapshot_already_written');
  });
});

describe('onboardingAccounts.ts — source contract', () => {
  const src = readFileSync(join(__dirname, 'onboardingAccounts.ts'), 'utf8');

  it('never names the checklist tick column (the tick is human-only; G8)', () => {
    // Assembled from parts so this file does not itself name the column.
    const tickColumn = new RegExp(`\\b(${['done', 'At'].join('')}|${['done', 'at'].join('_')})\\b`);
    expect(tickColumn.test(src)).toBe(false);
  });

  it('never opens its own transaction or db context in the commit half, and never calls openStep', () => {
    const commit = src.slice(src.indexOf('export async function commitOnboardingStageTransition'));
    expect(commit.length).toBeGreaterThan(100);
    expect(commit).not.toMatch(/withSystemDbAccessContext|runOutsideDbContext|\.transaction\(|\bdb\./);
    expect(src).not.toMatch(/\bopenStep\b/);
  });

  it('never selects the whole operation result column (only `${…result}->>` projections)', () => {
    // Control: the pattern flags a whole-column projection and lets a `->>` key through.
    const wholeColumn = /aiOperatorOperations\.result\b(?!\}->>')/;
    expect(wholeColumn.test('{ resultState: aiOperatorOperations.resultState }')).toBe(false);
    expect(wholeColumn.test('{ result: aiOperatorOperations.result }')).toBe(true);
    expect(wholeColumn.test("sql`${aiOperatorOperations.result}->>'userId'`")).toBe(false);
    expect(src).not.toMatch(wholeColumn);
  });
});
