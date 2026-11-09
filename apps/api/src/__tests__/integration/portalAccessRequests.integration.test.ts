/**
 * portal_access_requests: RLS, FK and org-merge proofs (W3 #11380, plan Task 2).
 * Task 7 appends the service-level cases in a separate describe block.
 */
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext, withDbTransaction, type DbAccessContext } from '../../db';
import {
  contacts, portalAccessPolicies, portalAccessRequests, portalUserIdentities, portalUsers,
} from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { runPolicy } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import {
  PORTAL_ACCESS_REQUEST_PENDING_CAP,
  PortalAccessRequestError,
  approvePortalAccessRequest,
  createPortalAccessRequest,
  denyPortalAccessRequest,
  listPortalAccessRequests,
  summarizePendingPortalAccessRequests,
} from '../../services/portalAccessRequests';
import { PORTAL_ACCOUNT_TRANSITION_REFUSED, PortalAccountTransitionError } from '../../services/portalAccountState';
import { bindContactLoginForInvite, loadOrgContactsForPortalInvite } from '../../services/contacts/portalInvite';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../../services/inboundEmail/resolveOrg';
import { entraIssuer } from '../../services/portalUserIdentities';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

function orgContext(orgId: string, currentPartnerId: string | null = null): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId,
  };
}

const requestIds: string[] = [];
const policyIds: string[] = [];
const portalUserIds: string[] = [];

afterEach(async () => {
  const r = [...new Set(requestIds)]; requestIds.length = 0;
  const p = [...new Set(policyIds)]; policyIds.length = 0;
  const u = [...new Set(portalUserIds)]; portalUserIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (r.length) await db.delete(portalAccessRequests).where(inArray(portalAccessRequests.id, r));
    if (p.length) await db.delete(portalAccessPolicies).where(inArray(portalAccessPolicies.id, p));
    if (u.length) await db.delete(portalUsers).where(inArray(portalUsers.id, u));
  });
});

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

async function seedRequest(orgId: string, email: string, extra: Partial<typeof portalAccessRequests.$inferInsert> = {}) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(portalAccessRequests).values({
      orgId, email, source: 'self', expiresAt: inDays(7), ...extra,
    }).returning({ id: portalAccessRequests.id }));
  requestIds.push(row!.id);
  return row!.id;
}

async function seedPolicy(values: { orgId?: string; partnerId?: string }) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(portalAccessPolicies).values({ ...values, passwordMode: 'sso_only' })
      .returning({ id: portalAccessPolicies.id }));
  policyIds.push(row!.id);
  return row!.id;
}

async function existingPolicyIds(ids: string[]) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: portalAccessPolicies.id }).from(portalAccessPolicies)
      .where(inArray(portalAccessPolicies.id, ids)));
  return rows.map((r) => r.id).sort();
}

async function existingRequestIds(ids: string[]) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: portalAccessRequests.id }).from(portalAccessRequests)
      .where(inArray(portalAccessRequests.id, ids)));
  return rows.map((r) => r.id).sort();
}

async function runMerge(table: string, loserOrgId: string, survivorOrgId: string) {
  const policy = getOrgMergePolicies().get(table);
  expect(policy, `merge policy for ${table}`).toBeDefined();
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const phase of ['resolve', 'move'] as const) {
      await runPolicy(table, policy!, loserOrgId, survivorOrgId, phase);
    }
  });
}

describe('RLS, FK and merge', () => {
  it('org A context cannot see or insert org B requests (0 rows / 42501)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const bId = await seedRequest(orgB.id, `b-${randomUUID()}@example.test`);
    const seen = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db.select().from(portalAccessRequests).where(eq(portalAccessRequests.id, bId)));
    expect(seen).toHaveLength(0);
    await expectSqlState(
      () => withDbAccessContext(orgContext(orgA.id, partner.id), () =>
        db.insert(portalAccessRequests).values({
          orgId: orgB.id, email: `x-${randomUUID()}@example.test`, source: 'self', expiresAt: inDays(7),
        }).returning()),
      '42501',
    );
  });

  it('deleting the portal user deletes requests that reference it', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [pu] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(portalUsers).values({
        orgId: org.id, email: `pu-${randomUUID()}@example.test`, authMethod: 'password',
      }).returning({ id: portalUsers.id }));
    portalUserIds.push(pu!.id);
    const reqId = await seedRequest(org.id, `pu-${randomUUID()}@example.test`, {
      source: 'addin_user', portalUserId: pu!.id,
    });
    expect(await existingRequestIds([reqId])).toEqual([reqId]);
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(portalUsers).where(eq(portalUsers.id, pu!.id)));
    expect(await existingRequestIds([reqId])).toEqual([]);
  });

  it('merge keeps the survivor policy and dedupes pending requests by email', async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const loserPolicy = await seedPolicy({ orgId: loser.id });
    const survivorPolicy = await seedPolicy({ orgId: survivor.id });
    const dup = `dup-${randomUUID()}@example.test`;
    const loserDup = await seedRequest(loser.id, dup);
    const survivorDup = await seedRequest(survivor.id, dup);

    expect(getOrgMergePolicies().get('portal_access_policies')).toEqual({ kind: 'keep-survivor' });
    await runMerge('portal_access_policies', loser.id, survivor.id);
    await runMerge('portal_access_requests', loser.id, survivor.id); // must not 23505

    expect(await existingPolicyIds([loserPolicy, survivorPolicy])).toEqual([survivorPolicy]);
    expect(await existingRequestIds([loserDup, survivorDup])).toEqual([survivorDup]);
  });

  it('merge drops the loser override when the survivor has none: the survivor stays on the partner default', async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const partnerDefault = await seedPolicy({ partnerId: partner.id });
    const loserPolicy = await seedPolicy({ orgId: loser.id });

    await runMerge('portal_access_policies', loser.id, survivor.id);

    expect(await existingPolicyIds([partnerDefault, loserPolicy])).toEqual([partnerDefault]);
    const survivorRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: portalAccessPolicies.id }).from(portalAccessPolicies)
        .where(eq(portalAccessPolicies.orgId, survivor.id)));
    expect(survivorRows).toHaveLength(0);
  });

  it("merge moves the loser's non-colliding and decided requests to the survivor", async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const email = `same-${randomUUID()}@example.test`;
    const pendingOnly = await seedRequest(loser.id, `only-${randomUUID()}@example.test`);
    // Decided rows sit outside the pending-only unique index: they move even on an email collision.
    const denied = await seedRequest(loser.id, email, { status: 'denied', decidedAt: new Date() });
    const survivorPending = await seedRequest(survivor.id, email);

    await runMerge('portal_access_requests', loser.id, survivor.id);

    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: portalAccessRequests.id, orgId: portalAccessRequests.orgId }).from(portalAccessRequests)
        .where(inArray(portalAccessRequests.id, [pendingOnly, denied, survivorPending])));
    const byId = new Map(rows.map((r) => [r.id, r.orgId]));
    expect(byId.size).toBe(3);
    for (const id of [pendingOnly, denied, survivorPending]) expect(byId.get(id)).toBe(survivor.id);
  });
});

// ---------------------------------------------------------------------------
// Task 7: the queue service (create / approve / deny / list / summary) on real
// Postgres as breeze_app under forced RLS. Approve and deny run inside a
// partner request context, exactly as the Task 8 routes call them.
// ---------------------------------------------------------------------------

const GOOGLE_ISSUER = 'https://accounts.google.com';
const HOUR = 3_600_000;
const DAY = 86_400_000;

function partnerContext(partnerId: string, orgIds: string[], userId: string): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId],
    userId, currentPartnerId: partnerId,
  };
}

async function serviceFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const decider = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
  return { partner, org, decider, ctx: partnerContext(partner.id, [org.id], decider.id) };
}

const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  const r = await settle(p);
  expect(r.ok, 'expected a rejection').toBe(false);
  return r.ok ? undefined : r.error;
}
const requestIdOf = (outcome: { kind: string; requestId?: string }): string => {
  expect(outcome.kind).toBe('created');
  return outcome.requestId!;
};

async function readRequest(id: string) {
  const [row] = await sys(() => db.select().from(portalAccessRequests).where(eq(portalAccessRequests.id, id)));
  return row!;
}
async function loginsFor(orgId: string, email: string) {
  return sys(() => db.select().from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), sql`lower(${portalUsers.email}) = ${email}`)));
}
async function identitiesOf(portalUserId: string) {
  return sys(() => db.select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, portalUserId)));
}

/** A test-owned superuser transaction that runs `statement` and keeps its lock until released. */
function holdLock(statement: SQL) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const done = getTestDb().transaction(async (tx) => {
    await tx.execute(statement);
    markReady();
    await gate;
  });
  return { ready: Promise.race([ready, done]), release, done };
}

/** Poll pg_stat_activity until `count` backends wait on a lock while running a query LIKE `pattern`. */
async function waitForLockWaiters(pattern: string, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`);
    const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
    if (n >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lock waiter(s) on ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function seedAddinLogin(orgId: string, email: string) {
  const tid = randomUUID();
  const oid = randomUUID();
  const [login] = await sys(() => db.insert(portalUsers).values({
    orgId, email, authMethod: 'entra', status: 'active', browserAccess: 'none', entraTenantId: tid, entraOid: oid,
  }).returning());
  await sys(() => db.insert(portalUserIdentities).values({
    orgId, portalUserId: login!.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
  }));
  return login!;
}

describe('service', () => {
  it('create normalizes the email, sets expires_at +14 d, and a repeat returns already_pending with a bumped last_requested_at', async () => {
    const { org } = await serviceFixture();
    const t0 = new Date(Date.now() - HOUR);
    const t1 = new Date(t0.getTime() + 30 * 60_000);

    const id = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: '  Ada@Example.TEST ', name: ' Ada ' }, t0));
    const created = await readRequest(id);
    expect(created).toMatchObject({ email: 'ada@example.test', name: 'Ada', source: 'self', status: 'pending' });
    expect(created.requestedAt.getTime()).toBe(t0.getTime());
    expect(created.lastRequestedAt.getTime()).toBe(t0.getTime());
    expect(created.expiresAt.getTime()).toBe(t0.getTime() + 14 * DAY);

    const repeat = await createPortalAccessRequest({ source: 'self', orgId: org.id, email: 'ADA@example.test', name: null }, t1);
    expect(repeat).toEqual({ kind: 'already_pending', requestId: id });
    const bumped = await readRequest(id);
    expect(bumped.lastRequestedAt.getTime()).toBe(t1.getTime());
    expect(bumped.requestedAt.getTime()).toBe(t0.getTime());
    expect(bumped.expiresAt.getTime()).toBe(t0.getTime() + 14 * DAY);
  });

  it('create expires a stale pending row and creates a fresh one', async () => {
    const { org } = await serviceFixture();
    const email = `stale-${randomUUID()}@example.test`;
    const staleId = await seedRequest(org.id, email, {
      requestedAt: new Date(Date.now() - 20 * DAY), expiresAt: new Date(Date.now() - 6 * DAY),
    });

    const freshId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email, name: null }));
    expect(freshId).not.toBe(staleId);
    expect((await readRequest(staleId)).status).toBe('expired');
    expect((await readRequest(freshId)).status).toBe('pending');
  });

  it('create returns capped at 200 live pending requests (a repeat of a live one still bumps)', async () => {
    const { org } = await serviceFixture();
    const future = new Date(Date.now() + 7 * DAY);
    const emails = Array.from({ length: PORTAL_ACCESS_REQUEST_PENDING_CAP }, (_, i) => `cap-${i}-${randomUUID()}@example.test`);
    await sys(() => db.insert(portalAccessRequests).values(
      emails.map((email) => ({ orgId: org.id, email, source: 'self' as const, expiresAt: future })),
    ));

    const extra = `over-${randomUUID()}@example.test`;
    expect(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: extra, name: null })).toEqual({ kind: 'capped' });
    const leaked = await sys(() => db.select({ id: portalAccessRequests.id }).from(portalAccessRequests)
      .where(eq(portalAccessRequests.email, extra)));
    expect(leaked).toHaveLength(0);

    const repeat = await createPortalAccessRequest({ source: 'self', orgId: org.id, email: emails[0]!, name: null });
    expect(repeat.kind).toBe('already_pending');
  });

  it('create joins a held context without escalating, and its failure stays inside its savepoint', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const survived = await withDbAccessContext(orgContext(orgB.id, partner.id), async () => {
      const err = await rejectionOf(createPortalAccessRequest({
        source: 'self', orgId: orgA.id, email: `x-${randomUUID()}@example.test`, name: null,
      }));
      expect(pgErrorCode(err)).toBe('42501');
      // The held transaction is still usable after the caught failure (#11203).
      return db.select({ id: portalAccessRequests.id }).from(portalAccessRequests);
    });
    expect(survived).toEqual([]);
  });

  it('approve entra creates an active, granted, identity-only account (auth_method entra) with identity + entra_* columns + contact', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `entra-${randomUUID()}@example.test`;
    const tid = randomUUID();
    const oid = randomUUID();
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'entra', orgId: org.id, email, name: 'Ent Ra', tid, oid }));
    const now = new Date();

    const result = await withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, now }));
    expect(result).toMatchObject({ outcome: 'account_created', email, name: 'Ent Ra', source: 'entra' });

    const [login] = await loginsFor(org.id, email);
    expect(login).toMatchObject({
      id: result.portalUserId, status: 'active', browserAccess: 'granted', authMethod: 'entra',
      passwordHash: null, entraTenantId: tid, entraOid: oid, authEpoch: result.authEpoch,
    });
    expect(login!.contactId).not.toBeNull();
    const [contact] = await sys(() => db.select().from(contacts).where(eq(contacts.id, login!.contactId!)));
    expect(contact).toMatchObject({ orgId: org.id, email });
    expect(contact!.roles).toContain('portal');

    expect(await identitiesOf(login!.id)).toEqual([expect.objectContaining({
      orgId: org.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
    })]);

    const decided = await readRequest(requestId);
    expect(decided).toMatchObject({ status: 'approved', decidedByUserId: decider.id, portalUserId: login!.id });
    expect(decided.decidedAt!.getTime()).toBe(now.getTime());
  });

  it('approve google creates auth_method google with the google issuer', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `goog-${randomUUID()}@example.test`;
    const sub = `google-${randomUUID()}`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub }));

    const result = await withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id }));
    expect(result.outcome).toBe('account_created');

    const [login] = await loginsFor(org.id, email);
    expect(login).toMatchObject({
      status: 'active', browserAccess: 'granted', authMethod: 'google', entraTenantId: null, entraOid: null,
    });
    expect(await identitiesOf(login!.id)).toEqual([expect.objectContaining({
      provider: 'google', issuer: GOOGLE_ISSUER, subject: sub, entraTenantId: null, linkedVia: 'jit',
    })]);
  });

  it('approve self creates an invited password account and returns invite_pending', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `self-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email, name: 'Selfie' }));

    const result = await withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id }));
    expect(result).toMatchObject({ outcome: 'invite_pending', email, name: 'Selfie', source: 'self' });

    const [login] = await loginsFor(org.id, email);
    expect(login).toMatchObject({
      id: result.portalUserId, status: 'invited', browserAccess: 'granted', authMethod: 'password',
      passwordHash: null, invitedBy: decider.id,
    });
    expect(login!.invitedAt).not.toBeNull();
    expect(login!.contactId).not.toBeNull();
    expect(await identitiesOf(login!.id)).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('approved');
  });

  it('approve addin_user grants browser access without bumping auth_epoch', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `addin-${randomUUID()}@example.test`;
    const login = await seedAddinLogin(org.id, email);
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'addin_user', orgId: org.id, portalUserId: login.id, email, name: null }));

    const result = await withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id }));
    expect(result).toMatchObject({ outcome: 'browser_access_granted', portalUserId: login.id, authEpoch: login.authEpoch });

    const [after] = await loginsFor(org.id, email);
    expect(after).toMatchObject({ status: 'active', browserAccess: 'granted', authMethod: 'entra', authEpoch: login.authEpoch });
    expect(await readRequest(requestId)).toMatchObject({ status: 'approved', portalUserId: login.id });
  });

  it('approve refuses when the email now has an account (409 ACCOUNT_EXISTS) and the request stays pending', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `exists-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email, name: null }));
    const [existing] = await sys(() => db.insert(portalUsers).values({
      orgId: org.id, email: email.toUpperCase(), authMethod: 'password', status: 'invited', browserAccess: 'granted',
    }).returning());

    const err = await rejectionOf(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    expect(err).toBeInstanceOf(PortalAccessRequestError);
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS', httpStatus: 409 });
    expect((await readRequest(requestId)).status).toBe('pending');
    expect((await loginsFor(org.id, email)).map((l) => l.id)).toEqual([existing!.id]);
  });

  it('approve refuses when (issuer, subject) is now linked (409 IDENTITY_LINKED) and creates no account', async () => {
    const { org, decider, ctx } = await serviceFixture();
    // The identity belongs to a login in ANOTHER partner's org: invisible to
    // this context under RLS, still caught by the global unique key.
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const sub = `google-${randomUUID()}`;
    const [other] = await sys(() => db.insert(portalUsers).values({
      orgId: otherOrg.id, email: `other-${randomUUID()}@example.test`, authMethod: 'google', status: 'active', browserAccess: 'granted',
    }).returning());
    await sys(() => db.insert(portalUserIdentities).values({
      orgId: otherOrg.id, portalUserId: other!.id, provider: 'google', issuer: GOOGLE_ISSUER, subject: sub, linkedVia: 'jit',
    }));
    const email = `linked-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub }));

    const err = await rejectionOf(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED', httpStatus: 409 });
    expect(await loginsFor(org.id, email)).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('approve entra refuses when a login holds the (tid, oid) on its legacy entra_* columns (IDENTITY_LINKED, no 23505)', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const tid = randomUUID();
    const oid = randomUUID();
    // Drift: a legacy login with entra_* set and no identity row.
    await sys(() => db.insert(portalUsers).values({
      orgId: otherOrg.id, email: `legacy-${randomUUID()}@example.test`, authMethod: 'entra',
      status: 'active', browserAccess: 'none', entraTenantId: tid, entraOid: oid,
    }));
    const email = `drift-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'entra', orgId: org.id, email, name: null, tid, oid }));

    const err = await rejectionOf(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED', httpStatus: 409 });
    expect(await loginsFor(org.id, email)).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('approve self racing an MSP invite for the same address yields exactly one account', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `race-${randomUUID()}@example.test`;
    const [contact] = await sys(() => db.insert(contacts).values({ orgId: org.id, email, name: 'Race' }).returning({ id: contacts.id }));
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email, name: null }));

    // Park both writers on the shared per-address advisory lock, then let go.
    const held = holdLock(sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${org.id}:${email}`}))`);
    await held.ready;
    const approving = settle(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    const inviting = settle(withDbAccessContext(ctx, async () => {
      const [inviteable] = await loadOrgContactsForPortalInvite(db, org.id, [contact!.id]);
      return withDbTransaction(() => bindContactLoginForInvite(db, {
        orgId: org.id, contact: inviteable!, normalizedEmail: email, name: null, actor: { userId: decider.id }, now: new Date(),
      }));
    }));
    try {
      await waitForLockWaiters('%pg_advisory_xact_lock%', 2);
    } finally {
      held.release();
      await held.done;
    }
    const approved = await approving;
    const invited = await inviting;

    expect(invited.ok, invited.ok ? '' : String(invited.error)).toBe(true);
    const logins = await loginsFor(org.id, email);
    expect(logins).toHaveLength(1);
    if (approved.ok) {
      // Approve won the lock: the invite reused the invited account approve created.
      expect(invited.ok && invited.value).toMatchObject({ kind: 'invite', created: false, portalUserId: approved.value.portalUserId });
    } else {
      expect(approved.error).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS' });
      expect(invited.ok && invited.value).toMatchObject({ kind: 'invite', created: true, portalUserId: logins[0]!.id });
      expect((await readRequest(requestId)).status).toBe('pending');
    }
  });

  it('approve addin_user whose epoch moved after the read → 409 PORTAL_ACCOUNT_TRANSITION_REFUSED, request stays pending', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `epoch-${randomUUID()}@example.test`;
    const login = await seedAddinLogin(org.id, email);
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'addin_user', orgId: org.id, portalUserId: login.id, email, name: null }));

    // An uncommitted concurrent epoch bump: approve reads the old epoch, then
    // its guarded UPDATE waits on the row and re-checks the guard after commit.
    const held = holdLock(sql`UPDATE portal_users SET auth_epoch = auth_epoch + 1 WHERE id = ${login.id}`);
    await held.ready;
    const approving = settle(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    try {
      await waitForLockWaiters('update "portal_users"%', 1);
    } finally {
      held.release();
      await held.done;
    }
    const outcome = await approving;

    expect(outcome.ok).toBe(false);
    const err = outcome.ok ? null : outcome.error;
    expect(err).toBeInstanceOf(PortalAccountTransitionError);
    expect(err).toMatchObject({
      code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, writer: 'access_request_approve', rule: 'epoch_moved',
    });
    expect((await readRequest(requestId)).status).toBe('pending');
    const [after] = await loginsFor(org.id, email);
    expect(after).toMatchObject({ browserAccess: 'none', authEpoch: login.authEpoch + 1 });
  });

  it('two concurrent approvals create one account; the second gets NOT_PENDING', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `double-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({
      source: 'entra', orgId: org.id, email, name: null, tid: randomUUID(), oid: randomUUID(),
    }));

    // Queue both approvers (two connections) on the request row lock so they genuinely overlap.
    const held = holdLock(sql`SELECT 1 FROM portal_access_requests WHERE id = ${requestId} FOR UPDATE`);
    await held.ready;
    const runs = [1, 2].map(() => settle(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id }))));
    try {
      await waitForLockWaiters('%from "portal_access_requests"%for update%', 2);
    } finally {
      held.release();
      await held.done;
    }
    const outcomes = [await runs[0]!, await runs[1]!];

    const won = outcomes.filter((o) => o.ok);
    const lost = outcomes.flatMap((o) => (o.ok ? [] : [o.error]));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_PENDING', httpStatus: 409 });
    const logins = await loginsFor(org.id, email);
    expect(logins).toHaveLength(1);
    expect((await readRequest(requestId)).portalUserId).toBe(logins[0]!.id);
  });

  it('approve of an expired request → NOT_PENDING and the row reads expired', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `expired-${randomUUID()}@example.test`;
    const requestId = await seedRequest(org.id, email, {
      requestedAt: new Date(Date.now() - 15 * DAY), expiresAt: new Date(Date.now() - DAY),
    });

    const err = await rejectionOf(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_PENDING', httpStatus: 409 });
    expect(await loginsFor(org.id, email)).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('pending'); // approve never writes 'expired'

    const pending = await withDbAccessContext(ctx, () => listPortalAccessRequests(org.id, { status: 'pending' }));
    expect(pending.items.map((i) => i.id)).not.toContain(requestId);
    const decided = await withDbAccessContext(ctx, () => listPortalAccessRequests(org.id, { status: 'decided' }));
    expect(decided.items.find((i) => i.id === requestId)).toMatchObject({ status: 'expired', decidedBy: null, accountExists: false });
  });

  it('approve for a request in another org → NOT_FOUND', async () => {
    const { partner, org, decider } = await serviceFixture();
    const sibling = await createOrganization({ partnerId: partner.id });
    const requestId = await seedRequest(sibling.id, `sib-${randomUUID()}@example.test`);
    const err = await rejectionOf(withDbAccessContext(partnerContext(partner.id, [org.id, sibling.id], decider.id), () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_FOUND', httpStatus: 404 });
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('deny marks denied with decider; a second deny → NOT_PENDING', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const email = `deny-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub: `g-${randomUUID()}` }));
    const now = new Date();

    expect(await withDbAccessContext(ctx, () =>
      denyPortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, now })))
      .toEqual({ email, source: 'google' });
    const denied = await readRequest(requestId);
    expect(denied).toMatchObject({ status: 'denied', decidedByUserId: decider.id, portalUserId: null });
    expect(denied.decidedAt!.getTime()).toBe(now.getTime());

    const err = await rejectionOf(withDbAccessContext(ctx, () =>
      denyPortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id })));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_PENDING', httpStatus: 409 });

    const decided = await withDbAccessContext(ctx, () => listPortalAccessRequests(org.id, { status: 'decided' }));
    expect(decided.items.find((i) => i.id === requestId)).toMatchObject({
      status: 'denied', decidedBy: { id: decider.id, name: 'Tech One' }, email, source: 'google',
    });
    expect(await loginsFor(org.id, email)).toEqual([]);
  });

  it('summary counts live pending per accessible org only', async () => {
    const { partner, org, decider } = await serviceFixture();
    const hidden = await createOrganization({ partnerId: partner.id });
    await createPortalAccessRequest({ source: 'self', orgId: org.id, email: `s1-${randomUUID()}@example.test`, name: null });
    await createPortalAccessRequest({ source: 'self', orgId: org.id, email: `s2-${randomUUID()}@example.test`, name: null });
    await seedRequest(org.id, `old-${randomUUID()}@example.test`, { expiresAt: new Date(Date.now() - DAY) });
    await createPortalAccessRequest({ source: 'self', orgId: hidden.id, email: `h-${randomUUID()}@example.test`, name: null });

    const summary = await withDbAccessContext(partnerContext(partner.id, [org.id], decider.id), () =>
      summarizePendingPortalAccessRequests());
    expect(summary).toEqual({ pendingTotal: 2, orgs: [{ orgId: org.id, orgName: org.name, pending: 2 }] });
  });
});
