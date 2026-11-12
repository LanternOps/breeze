/**
 * portal_access_requests: RLS, FK and org-merge proofs (W3 #11380, plan Task 2).
 * Task 7 appends the service-level cases in a separate describe block, and
 * Task 8 the routes through the real router.
 */
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Task 8 route cases only. Every hook below is a pass-through until a test sets
// its flag, so the Task 2 / Task 7 cases run the real modules unchanged.
const routeFaults = vi.hoisted(() => ({
  contactLink: false,
  noSavepoint: false,
  // Approve of the request at this address hits a real, unmapped statement failure.
  contactLinkCrashEmail: null as string | null,
  // Every decision email runs a real failing statement before it "sends".
  emailDbFault: false,
  // Parks an approval inside its transaction (after its tenant check) until the test lets go.
  contactLinkGate: null as null | (() => Promise<void>),
}));
const sentEmails = vi.hoisted(() => [] as Array<{ kind: 'invite' | 'approved' | 'declined'; to: string }>);

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    // CONTROL hook: with `noSavepoint` the approve body runs bare in the request
    // transaction, which is what the caught-409 case must be able to tell apart.
    withDbTransaction: <T>(fn: () => Promise<T>): Promise<T> =>
      (routeFaults.noSavepoint ? fn() : actual.withDbTransaction(fn)),
  };
});

vi.mock('../../services/contacts/loginLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/contacts/loginLink')>();
  return {
    ...actual,
    linkLoginToContact: async (...args: Parameters<typeof actual.linkLoginToContact>) => {
      if (routeFaults.contactLinkGate) await routeFaults.contactLinkGate();
      if (routeFaults.contactLink) {
        // A REAL statement failure (22012) on the approve transaction, caught,
        // then surfaced as the service's own 409: the #11203 shape.
        const { sql: rawSql } = await import('drizzle-orm');
        await args[0].execute(rawSql`SELECT 1/0`).catch(() => undefined);
        const { PortalAccessRequestError: RefusalError } = await import('../../services/portalAccessRequests');
        throw new RefusalError('PORTAL_ACCESS_REQUEST_IDENTITY_LINKED', 409, 'forced refusal after a failed statement');
      }
      if (routeFaults.contactLinkCrashEmail !== null && args[1].email === routeFaults.contactLinkCrashEmail) {
        // A REAL statement failure (22012) that nothing maps to a refusal: it
        // leaves approve as an unexpected error, inside approve's savepoint.
        const { sql: rawSql } = await import('drizzle-orm');
        await args[0].execute(rawSql`SELECT 1/0`);
      }
      return actual.linkLoginToContact(...args);
    },
  };
});

vi.mock('../../services/email', async (importOriginal) => {
  /**
   * Stands in for a DB read on the send path failing in place, as the
   * partner-lane sender lookup (services/emailDomains/partnerLaneLookup.ts)
   * does under a partner request context: a REAL statement failure (22012) on
   * whatever transaction scope the send runs in, rethrown to the caller.
   */
  const emailPathStatement = async (): Promise<void> => {
    if (!routeFaults.emailDbFault) return;
    const { db: ambientDb } = await import('../../db');
    const { sql: rawSql } = await import('drizzle-orm');
    await ambientDb.execute(rawSql`SELECT 1/0`);
  };
  return {
    ...(await importOriginal<typeof import('../../services/email')>()),
    getEmailService: () => ({
      sendPortalInvite: async (m: { to: string }) => { await emailPathStatement(); sentEmails.push({ kind: 'invite', to: m.to }); },
      sendPortalAccessApproved: async (m: { to: string }) => { await emailPathStatement(); sentEmails.push({ kind: 'approved', to: m.to }); },
      sendPortalAccessDeclined: async (m: { to: string }) => { await emailPathStatement(); sentEmails.push({ kind: 'declined', to: m.to }); },
      // A displacement (recordEntraTenantProof) mails the displaced partner; not under test here.
      sendPortalEntraTenantDisplaced: async () => undefined,
      // So does a W5 domain transfer (W7 race cases); not under test here.
      sendPortalDomainVerificationLost: async () => undefined,
    }),
  };
});
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext, withDbTransaction, type DbAccessContext } from '../../db';
import {
  auditLogs, clientAiTenantMappings, contacts, customerEmailDomains, portalAccessPolicies, portalAccessRequests, portalUserIdentities, portalUsers,
} from '../../db/schema';
import { recordEntraTenantProof } from '../../services/portalEntraTenantProof';
import {
  findOrgByVerifiedDomain,
  listVerifiedDomainsForOrg,
  verifyCustomerDomain,
  type DomainCheckResult,
  type DomainCheckTarget,
  type DomainVerificationChecker,
  type DomainVerificationCheckers,
} from '../../services/portalDomainVerification';
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
import { authMiddleware } from '../../middleware/auth';
import { registerOrgPortalAccessRequestRoutes } from '../../routes/orgPortalAccessRequests';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { createAccessToken } from '../../services/jwt';
import { awaitAuditRows } from './auditWait';
import { createOrganization, createPartner, createUser, setupTestEnvironment } from './db-utils';

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

/**
 * The org's proven tenant, recorded by the real proof service as a proof run
 * does (W4 D7). An `entra` request is only ever created for a tenant proven for
 * its org (sign-in resolves the org through the proven mapping), and approval
 * re-checks that it still is. Called with no DB context held.
 */
async function proveTenant(orgId: string, tid: string = randomUUID()) {
  const outcome = await recordEntraTenantProof({
    orgId, tenantId: tid, via: 'proof_run', evidence: { adminOid: randomUUID(), runId: randomUUID() }, provenByUserId: null,
  });
  return { tid, displaced: outcome.displaced };
}
const provenTid = async (orgId: string) => (await proveTenant(orgId)).tid;

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

/**
 * `holdLock`, except the test-owned transaction ROLLS BACK on release, so the
 * rows `statement` wrote are never seen by anyone: they only make a concurrent
 * insert on the same unique key wait until then.
 */
function holdUncommitted(statement: SQL) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const rollback = new Error('test-owned rollback');
  const done = getTestDb().transaction(async (tx) => {
    await tx.execute(statement);
    markReady();
    await gate;
    throw rollback;
  }).catch((err: unknown) => { if (err !== rollback) throw err; });
  return { ready: Promise.race([ready, done]), release, done };
}

/** Poll pg_stat_activity until `count` backends wait on a lock while running a query LIKE `pattern` (any of them). */
async function waitForLockWaiters(pattern: string | string[], count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const matches = sql.join(patterns.map((p) => sql`query ILIKE ${p}`), sql` OR `);
  for (;;) {
    const rows = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND (${matches})`);
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

/**
 * W7 D8: a Workspace domain verified for `org` the way W5 records one (dns_txt
 * evidence, a pass within the stale window), and the read API's fact for it,
 * read with no DB context held exactly as the approval route reads it.
 */
async function seedVerifiedGoogleDomain(org: { id: string; partnerId: string }) {
  const domain = `ws-${randomUUID().slice(0, 8)}.example.test`;
  const at = new Date(Date.now() - 60_000);
  const [row] = await getTestDb().insert(customerEmailDomains).values({
    partnerId: org.partnerId, orgId: org.id, domain, isActive: true, verificationToken: `tok-${randomUUID()}`,
    verifiedAt: at, verifiedMethod: 'dns_txt', verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
    lastCheckedAt: at, lastPassedAt: at, lastCheckStatus: 'pass',
  }).returning({ id: customerEmailDomains.id });
  const fact = await findOrgByVerifiedDomain(domain);
  expect(fact).toMatchObject({ orgId: org.id, domain });
  return { rowId: row!.id, domain, verifiedAt: fact!.verifiedAt };
}

/**
 * A REAL W5 transfer of `domain` to an org of another partner (D5): the
 * challenger's DNS check passes, the incumbent's fails, so the incumbent row
 * is displaced. Checkers are fakes (no DNS); everything else is W5's code.
 * `run` must be called with no DB context held.
 */
async function transferDomainToAnotherPartner(domain: string) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test` });
  const [challenger] = await getTestDb().insert(customerEmailDomains).values({
    partnerId: partner.id, orgId: org.id, domain, isActive: true, verificationToken: `tok-${randomUUID()}`,
  }).returning({ id: customerEmailDomains.id });
  const verdict = async (target: DomainCheckTarget): Promise<DomainCheckResult> => (target.rowId === challenger!.id
    ? { status: 'pass', evidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` } }
    : { status: 'fail', reason: 'record_missing' });
  const checker = (method: DomainVerificationChecker['method']): DomainVerificationChecker => ({ method, check: verdict });
  const checkers: DomainVerificationCheckers = {
    dns_txt: checker('dns_txt'), entra_tenant: checker('entra_tenant'), google_directory: checker('google_directory'),
  };
  return {
    org,
    run: () => verifyCustomerDomain(
      { orgId: org.id, partnerId: partner.id, domainId: challenger!.id, method: 'dns_txt', actorUserId: actor.id },
      { checkers },
    ),
  };
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

  it('two concurrent creates at cap - 1 for different new addresses: exactly one created, one capped', async () => {
    const { org } = await serviceFixture();
    const future = new Date(Date.now() + 7 * DAY);
    await sys(() => db.insert(portalAccessRequests).values(
      Array.from({ length: PORTAL_ACCESS_REQUEST_PENDING_CAP - 1 }, (_, i) => ({
        orgId: org.id, email: `fill-${i}-${randomUUID()}@example.test`, source: 'self' as const, expiresAt: future,
      })),
    ));
    const addresses = [`race-a-${randomUUID()}@example.test`, `race-b-${randomUUID()}@example.test`];

    // Force the interleaving the cap has to survive. A test-owned transaction
    // holds UNCOMMITTED pending rows for both new addresses, so each create's
    // insert waits on the pending-email unique index AFTER it has counted.
    // Without admission control both count 199 and both land once the holder
    // rolls back. With it, the second create waits on the per-org admission
    // lock instead, and counts 200 once the first commits.
    const held = holdUncommitted(sql`
      INSERT INTO portal_access_requests (org_id, email, source, expires_at)
      VALUES (${org.id}, ${addresses[0]}, 'self', ${future.toISOString()}::timestamptz),
             (${org.id}, ${addresses[1]}, 'self', ${future.toISOString()}::timestamptz)`);
    await held.ready;
    const runs = addresses.map((email) => settle(createPortalAccessRequest({ source: 'self', orgId: org.id, email, name: null })));
    try {
      await waitForLockWaiters(['insert into "portal_access_requests"%', '%pg_advisory_xact_lock%'], 2);
    } finally {
      held.release();
      await held.done;
    }
    const outcomes = await Promise.all(runs);

    const kinds = outcomes.map((o) => (o.ok ? o.value.kind : `error: ${String(o.error)}`)).sort();
    expect(kinds).toEqual(['capped', 'created']);
    const [live] = await sys(() => db.select({ n: sql<number>`count(*)::int` }).from(portalAccessRequests).where(and(
      eq(portalAccessRequests.orgId, org.id), eq(portalAccessRequests.status, 'pending'),
    )));
    expect(Number(live!.n)).toBe(PORTAL_ACCESS_REQUEST_PENDING_CAP);
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
    const tid = await provenTid(org.id);
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
    const hd = await seedVerifiedGoogleDomain(org);
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: hd.domain }));

    const result = await withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, googleDomain: { verifiedAt: hd.verifiedAt } }));
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
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, selfDomainVerified: true }));
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
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, selfDomainVerified: true })));
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
    const hd = await seedVerifiedGoogleDomain(org);
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: hd.domain }));

    const err = await rejectionOf(withDbAccessContext(ctx, () =>
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, googleDomain: { verifiedAt: hd.verifiedAt } })));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED', httpStatus: 409 });
    expect(await loginsFor(org.id, email)).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('approve entra refuses when a login holds the (tid, oid) on its legacy entra_* columns (IDENTITY_LINKED, no 23505)', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const tid = await provenTid(org.id);
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

  describe("approve entra re-checks the org's proven tenant (inv. 4: a request outlives a displacement)", () => {
    const TENANT_CHANGED = {
      code: 'PORTAL_ACCESS_REQUEST_ENTRA_TENANT_NOT_PROVEN',
      httpStatus: 409,
      message: "This organization's Microsoft tenant has changed since this request was made. Ask the person to sign in again.",
    };

    async function expectRefusedAndNothingWritten(
      fixture: Awaited<ReturnType<typeof serviceFixture>>,
      request: { requestId: string; email: string; tid: string; oid: string },
    ) {
      const err = await rejectionOf(withDbAccessContext(fixture.ctx, () =>
        approvePortalAccessRequest({ orgId: fixture.org.id, requestId: request.requestId, deciderUserId: fixture.decider.id })));
      expect(err).toBeInstanceOf(PortalAccessRequestError);
      expect(err).toMatchObject(TENANT_CHANGED);
      // No account, no identity, no contact; the request is still pending.
      expect(await loginsFor(fixture.org.id, request.email)).toEqual([]);
      expect(await sys(() => db.select().from(portalUserIdentities).where(and(
        eq(portalUserIdentities.issuer, entraIssuer(request.tid)), eq(portalUserIdentities.subject, request.oid),
      )))).toEqual([]);
      expect(await sys(() => db.select().from(contacts).where(and(
        eq(contacts.orgId, fixture.org.id), eq(contacts.email, request.email),
      )))).toEqual([]);
      expect((await readRequest(request.requestId)).status).toBe('pending');
    }

    async function entraRequest(orgId: string, tid: string) {
      const email = `stale-${randomUUID()}@example.test`;
      const oid = randomUUID();
      const requestId = requestIdOf(await createPortalAccessRequest({ source: 'entra', orgId, email, name: null, tid, oid }));
      return { requestId, email, tid, oid };
    }

    it('the tenant was displaced to another partner\'s org by a proof run since the request → 409, nothing written', async () => {
      const fixture = await serviceFixture();
      const tid = await provenTid(fixture.org.id);
      const request = await entraRequest(fixture.org.id, tid);

      // Days later a proof run in another partner's org takes the tenant (D7).
      const otherPartner = await createPartner();
      const otherOrg = await createOrganization({ partnerId: otherPartner.id });
      const { displaced } = await proveTenant(otherOrg.id, tid);
      expect(displaced).toMatchObject({ orgId: fixture.org.id, wasProven: true });

      await expectRefusedAndNothingWritten(fixture, request);
    });

    it('the org now holds a proof for a different tenant → 409, nothing written', async () => {
      const fixture = await serviceFixture();
      const request = await entraRequest(fixture.org.id, randomUUID());
      await provenTid(fixture.org.id);
      await expectRefusedAndNothingWritten(fixture, request);
    });

    it('the org maps the tenant but the mapping is unproven (proof cleared) → 409, nothing written', async () => {
      const fixture = await serviceFixture();
      const tid = randomUUID();
      await sys(() => db.insert(clientAiTenantMappings).values({ orgId: fixture.org.id, entraTenantId: tid }));
      await expectRefusedAndNothingWritten(fixture, await entraRequest(fixture.org.id, tid));
    });

    it('the org has no tenant mapping at all → 409, nothing written', async () => {
      const fixture = await serviceFixture();
      await expectRefusedAndNothingWritten(fixture, await entraRequest(fixture.org.id, randomUUID()));
    });

    it('a displacement racing the approval waits for it (FOR SHARE), then bumps the new account\'s epoch with the org\'s other tenant identities', async () => {
      const fixture = await serviceFixture();
      const tid = await provenTid(fixture.org.id);
      const request = await entraRequest(fixture.org.id, tid);
      const otherPartner = await createPartner();
      const otherOrg = await createOrganization({ partnerId: otherPartner.id });

      // Park the approval inside its transaction, after the tenant check.
      let parked!: () => void;
      const isParked = new Promise<void>((resolve) => { parked = resolve; });
      let letGo!: () => void;
      const gate = new Promise<void>((resolve) => { letGo = resolve; });
      routeFaults.contactLinkGate = async () => { parked(); await gate; };
      try {
        const approving = settle(withDbAccessContext(fixture.ctx, () =>
          approvePortalAccessRequest({ orgId: fixture.org.id, requestId: request.requestId, deciderUserId: fixture.decider.id })));
        await isParked;
        const displacing = settle(proveTenant(otherOrg.id, tid));
        try {
          // The displacement's FOR UPDATE on the org's mapping row waits on the approval's FOR SHARE.
          await waitForLockWaiters('%from "client_ai_tenant_mappings"%for update%', 1);
        } finally {
          letGo();
        }
        const approved = await approving;
        const displacedOutcome = await displacing;

        expect(approved.ok, approved.ok ? '' : String(approved.error)).toBe(true);
        expect(displacedOutcome.ok, displacedOutcome.ok ? '' : String(displacedOutcome.error)).toBe(true);
        const created = approved.ok ? approved.value : null;
        // The displacement ran after the approval committed, so it saw the new
        // account and killed any session it could mint (epoch +1).
        expect(displacedOutcome.ok && displacedOutcome.value.displaced).toMatchObject({ orgId: fixture.org.id, epochsBumped: 1 });
        const [login] = await loginsFor(fixture.org.id, request.email);
        expect(login).toMatchObject({ id: created!.portalUserId, authEpoch: created!.authEpoch + 1 });
        const [mapping] = await sys(() => db.select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.entraTenantId, tid)));
        expect(mapping).toMatchObject({ orgId: otherOrg.id });
      } finally {
        routeFaults.contactLinkGate = null;
        letGo();
      }
    });
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
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, selfDomainVerified: true })));
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
      source: 'entra', orgId: org.id, email, name: null, tid: await provenTid(org.id), oid: randomUUID(),
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
      approvePortalAccessRequest({ orgId: org.id, requestId, deciderUserId: decider.id, selfDomainVerified: true })));
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
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub: `g-${randomUUID()}`, hostedDomain: 'example.test' }));
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

// ---------------------------------------------------------------------------
// W7 (#11384): Google requests record their Workspace domain (D8), approval is
// fenced on W5's row for it, and a conflicting pending request is refused (D9).
// ---------------------------------------------------------------------------

describe('google requests (W7 D8, D9)', () => {
  const GOOGLE_DOMAIN_NOT_VERIFIED = {
    code: 'PORTAL_ACCESS_REQUEST_GOOGLE_DOMAIN_NOT_VERIFIED',
    httpStatus: 409,
    message: "This request's Google Workspace domain is no longer verified for this organization. Verify it again or invite the person directly.",
  };
  const googleIdentityRows = (sub: string) => sys(() => db.select().from(portalUserIdentities).where(and(
    eq(portalUserIdentities.issuer, GOOGLE_ISSUER), eq(portalUserIdentities.subject, sub),
  )));

  it('creates a google request with google_hosted_domain (lowercased, trimmed)', async () => {
    const { org } = await serviceFixture();
    const email = `g-${randomUUID()}@example.test`;
    const id = requestIdOf(await createPortalAccessRequest({
      source: 'google', orgId: org.id, email, name: null, sub: `g-${randomUUID()}`, hostedDomain: ' Example.TEST ',
    }));
    expect(await readRequest(id)).toMatchObject({ source: 'google', issuer: GOOGLE_ISSUER, googleHostedDomain: 'example.test' });
  });

  it('a google create at an address pending for another sub → claims_conflict, nothing written (D9)', async () => {
    const { org } = await serviceFixture();
    const email = `g-${randomUUID()}@example.test`;
    const t0 = new Date(Date.now() - HOUR);
    const first = requestIdOf(await createPortalAccessRequest({
      source: 'google', orgId: org.id, email, name: 'First', sub: 'sub-first', hostedDomain: 'example.test',
    }, t0));
    const before = await readRequest(first);

    expect(await createPortalAccessRequest({
      source: 'google', orgId: org.id, email: email.toUpperCase(), name: 'Second', sub: 'sub-second', hostedDomain: 'other.example.test',
    })).toEqual({ kind: 'claims_conflict', requestId: first });
    // Not even a bump: the queued identity, its domain and its timestamps are exactly as they were.
    expect(await readRequest(first)).toEqual(before);
    const rows = await sys(() => db.select({ id: portalAccessRequests.id }).from(portalAccessRequests)
      .where(and(eq(portalAccessRequests.orgId, org.id), eq(portalAccessRequests.email, email))));
    expect(rows.map((r) => r.id)).toEqual([first]);
  });

  it('a google create at an address pending as entra (provider switch) → claims_conflict', async () => {
    const { org } = await serviceFixture();
    const email = `switch-${randomUUID()}@example.test`;
    const first = requestIdOf(await createPortalAccessRequest({
      source: 'entra', orgId: org.id, email, name: null, tid: randomUUID(), oid: randomUUID(),
    }));
    const before = await readRequest(first);
    expect(await createPortalAccessRequest({
      source: 'google', orgId: org.id, email, name: null, sub: `g-${randomUUID()}`, hostedDomain: 'example.test',
    })).toEqual({ kind: 'claims_conflict', requestId: first });
    expect(await readRequest(first)).toEqual(before);
  });

  it('an entra create at an address pending for another oid → claims_conflict (deliberate W3 change)', async () => {
    const { org } = await serviceFixture();
    const email = `entra-${randomUUID()}@example.test`;
    const tid = randomUUID();
    const first = requestIdOf(await createPortalAccessRequest({ source: 'entra', orgId: org.id, email, name: null, tid, oid: randomUUID() }));
    const before = await readRequest(first);

    expect(await createPortalAccessRequest({ source: 'entra', orgId: org.id, email, name: null, tid, oid: randomUUID() }))
      .toEqual({ kind: 'claims_conflict', requestId: first });
    expect(await readRequest(first)).toEqual(before);

    // The same identity re-requesting still bumps (W3).
    const again = await createPortalAccessRequest({ source: 'entra', orgId: org.id, email, name: null, tid, oid: before.subject! });
    expect(again).toEqual({ kind: 'already_pending', requestId: first });
    expect((await readRequest(first)).lastRequestedAt.getTime()).toBeGreaterThan(before.lastRequestedAt.getTime());
  });

  it('the same google sub re-requesting with a new hd bumps and refreshes google_hosted_domain', async () => {
    const { org } = await serviceFixture();
    const email = `g-${randomUUID()}@example.test`;
    const sub = `g-${randomUUID()}`;
    const t0 = new Date(Date.now() - HOUR);
    const id = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: 'example.test' }, t0));

    const t1 = new Date(t0.getTime() + 60_000);
    expect(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: 'sub.example.test' }, t1))
      .toEqual({ kind: 'already_pending', requestId: id });
    const after = await readRequest(id);
    expect(after).toMatchObject({ source: 'google', issuer: GOOGLE_ISSUER, subject: sub, googleHostedDomain: 'sub.example.test' });
    expect(after.lastRequestedAt.getTime()).toBe(t1.getTime());
    expect(after.requestedAt.getTime()).toBe(t0.getTime());
  });

  it("a self re-request keeps the W3 bump and never touches a pending google request's claims", async () => {
    const { org } = await serviceFixture();
    const email = `g-${randomUUID()}@example.test`;
    const sub = `g-${randomUUID()}`;
    const t0 = new Date(Date.now() - HOUR);
    const id = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: 'example.test' }, t0));

    const t1 = new Date(t0.getTime() + 60_000);
    expect(await createPortalAccessRequest({ source: 'self', orgId: org.id, email, name: null }, t1))
      .toEqual({ kind: 'already_pending', requestId: id });
    const after = await readRequest(id);
    expect(after).toMatchObject({ source: 'google', issuer: GOOGLE_ISSUER, subject: sub, googleHostedDomain: 'example.test' });
    expect(after.lastRequestedAt.getTime()).toBe(t1.getTime());
  });

  it('approve refuses a google request whose hd is not verified for the org (null fact) or whose fact is stale; nothing written', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const hd = await seedVerifiedGoogleDomain(org);
    const email = `g-${randomUUID()}@example.test`;
    const sub = `g-${randomUUID()}`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: hd.domain }));

    for (const googleDomain of [null, undefined, { verifiedAt: new Date(hd.verifiedAt.getTime() - 1) }]) {
      const err = await rejectionOf(withDbAccessContext(ctx, () => approvePortalAccessRequest({
        orgId: org.id, requestId, deciderUserId: decider.id, googleDomain, googleContactAllowed: true,
      })));
      expect(err).toBeInstanceOf(PortalAccessRequestError);
      expect(err).toMatchObject(GOOGLE_DOMAIN_NOT_VERIFIED);
    }
    expect(await loginsFor(org.id, email)).toEqual([]);
    expect(await googleIdentityRows(sub)).toEqual([]);
    expect(await sys(() => db.select().from(contacts).where(and(eq(contacts.orgId, org.id), eq(contacts.email, email))))).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('approve of a google request with a verified hd creates an identity-only google account; the contact only when allowed (D3)', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const hd = await seedVerifiedGoogleDomain(org);
    const linked = { email: `in-${randomUUID()}@example.test`, sub: `g-${randomUUID()}` };
    const unlinked = { email: `out-${randomUUID()}@example.test`, sub: `g-${randomUUID()}` };

    for (const [person, googleContactAllowed] of [[linked, true], [unlinked, false]] as const) {
      const requestId = requestIdOf(await createPortalAccessRequest({
        source: 'google', orgId: org.id, email: person.email, name: null, sub: person.sub, hostedDomain: hd.domain,
      }));
      const result = await withDbAccessContext(ctx, () => approvePortalAccessRequest({
        orgId: org.id, requestId, deciderUserId: decider.id, googleDomain: { verifiedAt: hd.verifiedAt }, googleContactAllowed,
      }));
      expect(result).toMatchObject({ outcome: 'account_created', source: 'google', email: person.email });
      const [login] = await loginsFor(org.id, person.email);
      expect(login).toMatchObject({ id: result.portalUserId, authMethod: 'google', status: 'active', browserAccess: 'granted' });
      expect(await identitiesOf(login!.id)).toEqual([expect.objectContaining({ provider: 'google', issuer: GOOGLE_ISSUER, subject: person.sub })]);
      const contactRows = await sys(() => db.select().from(contacts).where(and(eq(contacts.orgId, org.id), eq(contacts.email, person.email))));
      if (googleContactAllowed) {
        expect(login!.contactId).toBe(contactRows[0]!.id);
      } else {
        expect(login!.contactId).toBeNull();
        expect(contactRows).toEqual([]);
      }
    }
  });

  it('a W5 transfer of the hd that commits between the route pre-check and the approval → 409, no identity in the old org', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const hd = await seedVerifiedGoogleDomain(org);
    const email = `race-${randomUUID()}@example.test`;
    const sub = `g-${randomUUID()}`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: hd.domain }));

    // The route's pre-check (outside the request transaction) sees the domain verified for this org...
    const preCheck = await findOrgByVerifiedDomain(hd.domain);
    expect(preCheck).toMatchObject({ orgId: org.id });
    // ...then, before the approval transaction starts, W5 moves the domain to another partner's org.
    const transfer = await transferDomainToAnotherPartner(hd.domain);
    expect(await transfer.run()).toMatchObject({ result: 'verified', displacedOrgId: org.id });

    const err = await rejectionOf(withDbAccessContext(ctx, () => approvePortalAccessRequest({
      orgId: org.id, requestId, deciderUserId: decider.id, googleDomain: { verifiedAt: preCheck!.verifiedAt }, googleContactAllowed: true,
    })));
    expect(err).toMatchObject(GOOGLE_DOMAIN_NOT_VERIFIED);
    // The globally unique (issuer, sub) was never placed in the old org: the person can still be admitted where the domain now lives.
    expect(await googleIdentityRows(sub)).toEqual([]);
    expect(await loginsFor(org.id, email)).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('a W5 transfer started while the approval holds the row waits for the approval to commit', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const hd = await seedVerifiedGoogleDomain(org);
    const email = `hold-${randomUUID()}@example.test`;
    const sub = `g-${randomUUID()}`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: hd.domain }));
    const transfer = await transferDomainToAnotherPartner(hd.domain);

    // Park the approval inside its transaction, after the domain fence (the contact link runs after it).
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => { parked = resolve; });
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => { letGo = resolve; });
    routeFaults.contactLinkGate = async () => { parked(); await gate; };
    try {
      const approving = settle(withDbAccessContext(ctx, () => approvePortalAccessRequest({
        orgId: org.id, requestId, deciderUserId: decider.id, googleDomain: { verifiedAt: hd.verifiedAt }, googleContactAllowed: true,
      })));
      await isParked;
      let transferSettled = false;
      const transferring = settle(transfer.run()).finally(() => { transferSettled = true; });
      try {
        // The transfer's FOR UPDATE on the incumbent domain row waits on the approval's FOR SHARE.
        await waitForLockWaiters('%from "customer_email_domains"%for update%', 1);
        expect(transferSettled).toBe(false);
      } finally {
        letGo();
      }
      const approved = await approving;
      const transferred = await transferring;

      expect(approved.ok, approved.ok ? '' : String(approved.error)).toBe(true);
      expect(transferred.ok, transferred.ok ? '' : String(transferred.error)).toBe(true);
      // Serialized: the approval committed in the org that held the domain, then the transfer displaced it.
      const created = approved.ok ? approved.value : null;
      expect(created).toMatchObject({ outcome: 'account_created', source: 'google' });
      expect(await googleIdentityRows(sub)).toEqual([expect.objectContaining({ orgId: org.id, portalUserId: created!.portalUserId })]);
      expect(transferred.ok && transferred.value).toMatchObject({ result: 'verified', displacedOrgId: org.id });
      expect((await findOrgByVerifiedDomain(hd.domain))?.orgId).toBe(transfer.org.id);
    } finally {
      routeFaults.contactLinkGate = null;
      letGo();
    }
  });

  it('a domain cleared by an uncommitted writer: the approval waits on the row, then re-reads it and refuses', async () => {
    const { org, decider, ctx } = await serviceFixture();
    const hd = await seedVerifiedGoogleDomain(org);
    const email = `wait-${randomUUID()}@example.test`;
    const sub = `g-${randomUUID()}`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: null, sub, hostedDomain: hd.domain }));

    // A W5 writer's clear, held uncommitted (the row lock every W5 writer takes, then its UPDATE).
    const held = holdLock(sql`
      UPDATE customer_email_domains
         SET verified_at = NULL, verified_method = NULL, verified_evidence = NULL, last_passed_at = NULL,
             cleared_at = now(), cleared_reason = 'msp_removed'
       WHERE id = ${hd.rowId}`);
    await held.ready;
    const approving = settle(withDbAccessContext(ctx, () => approvePortalAccessRequest({
      orgId: org.id, requestId, deciderUserId: decider.id, googleDomain: { verifiedAt: hd.verifiedAt }, googleContactAllowed: true,
    })));
    try {
      await waitForLockWaiters('%from "customer_email_domains"%for share%', 1);
    } finally {
      held.release();
      await held.done;
    }
    const outcome = await approving;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error).toMatchObject(GOOGLE_DOMAIN_NOT_VERIFIED);
    expect(await googleIdentityRows(sub)).toEqual([]);
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('the list carries googleHostedDomain and domainVerified for google rows', async () => {
    const { org, ctx } = await serviceFixture();
    const hd = await seedVerifiedGoogleDomain(org);
    const verifiedId = requestIdOf(await createPortalAccessRequest({
      // The email's domain differs from hd (OD2): the row is judged by its hd.
      source: 'google', orgId: org.id, email: `a-${randomUUID()}@other.example.test`, name: null, sub: `g-${randomUUID()}`, hostedDomain: hd.domain,
    }));
    const unverifiedId = requestIdOf(await createPortalAccessRequest({
      source: 'google', orgId: org.id, email: `b-${randomUUID()}@${hd.domain}`, name: null, sub: `g-${randomUUID()}`, hostedDomain: `lapsed.${hd.domain}`,
    }));
    const selfId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: `c-${randomUUID()}@${hd.domain}`, name: null }));

    // The route reads the verified set outside the request transaction (W5 read API).
    const verifiedDomains = new Set((await listVerifiedDomainsForOrg(org.id)).map((f) => f.domain));
    const page = await withDbAccessContext(ctx, () => listPortalAccessRequests(org.id, { status: 'pending', verifiedDomains }));
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(verifiedId)).toMatchObject({ source: 'google', googleHostedDomain: hd.domain, domainVerified: true });
    expect(byId.get(unverifiedId)).toMatchObject({ source: 'google', googleHostedDomain: `lapsed.${hd.domain}`, domainVerified: false });
    expect(byId.get(selfId)).toMatchObject({ source: 'self', googleHostedDomain: null, domainVerified: true });
  });
});

// ---------------------------------------------------------------------------
// Task 8: the routes through the real router. authMiddleware opens the request
// transaction (withDbAccessContext), the service opens its savepoint inside it,
// and the route's catch sits outside the service call (#11203).
// ---------------------------------------------------------------------------

function buildRoutesApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  registerOrgPortalAccessRequestRoutes(app);
  registerOrgPortalUsersRoutes(app);
  return app;
}

/** A partner tech (all orgs, wildcard role) with an MFA'd token, for the requireMfa() writes. */
async function routeFixture() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = buildRoutesApp();
  const request = (method: 'GET' | 'POST', path: string, body?: unknown) => app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const org = env.organization;
  return {
    org,
    get: (path: string) => request('GET', path),
    post: (path: string, body?: unknown) => request('POST', path, body),
    base: `/organizations/${org.id}/portal-access-requests`,
  };
}

/**
 * W6 D11: the route approves a `self` request only while the address's domain
 * is verified for the org (W5 read API, read outside the request transaction).
 * Seeds a unique domain verified for `org` the way W5 records one: dns_txt
 * evidence and a pass within the stale window. Org cleanup cascades the row.
 */
async function verifiedSelfDomain(org: { id: string; partnerId: string }): Promise<string> {
  const domain = `self-${randomUUID().slice(0, 8)}.example.test`;
  const at = new Date(Date.now() - 60_000);
  await getTestDb().insert(customerEmailDomains).values({
    partnerId: org.partnerId, orgId: org.id, domain, isActive: true, verificationToken: `tok-${randomUUID()}`,
    verifiedAt: at, verifiedMethod: 'dns_txt', verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
    lastCheckedAt: at, lastPassedAt: at, lastCheckStatus: 'pass',
  });
  return domain;
}

describe('routes (real router)', () => {
  afterEach(() => {
    routeFaults.contactLink = false;
    routeFaults.noSavepoint = false;
    routeFaults.contactLinkCrashEmail = null;
    routeFaults.emailDbFault = false;
    sentEmails.length = 0;
  });

  /** The decision audit rows for these requests (fire-and-forget writes: polled, #6555). */
  async function decisionAudits(ids: string[], expected: number) {
    return awaitAuditRows(() => getTestDb()
      .select({ resourceId: auditLogs.resourceId, action: auditLogs.action, orgId: auditLogs.orgId })
      .from(auditLogs)
      .where(and(inArray(auditLogs.resourceId, ids), sql`${auditLogs.action} LIKE 'organization.portal_user.access_request.%'`)), expected);
  }

  const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

  it('decide: an unexpected SQL failure on one id is INTERNAL_ERROR; the other approvals commit WITH their audit rows and emails', async () => {
    const { org, post, base } = await routeFixture();
    const tid = await provenTid(org.id);
    const made: Array<{ id: string; email: string }> = [];
    for (const tag of ['x', 'y', 'z']) {
      const email = `d-crash-${tag}-${randomUUID()}@example.test`;
      made.push({
        id: requestIdOf(await createPortalAccessRequest({
          source: 'entra', orgId: org.id, email, name: null, tid, oid: randomUUID(),
        })),
        email,
      });
    }
    // The route decides in ascending id order: fail the middle one, so one
    // approval commits before the failure and one after it.
    const [low, mid, high] = [...made].sort((p, q) => byId(p.id, q.id)) as [typeof made[0], typeof made[0], typeof made[0]];
    routeFaults.contactLinkCrashEmail = mid.email;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let res: Response;
    try {
      res = await post(`${base}/decide`, { requestIds: [high.id, mid.id, low.id], decision: 'approve' });
    } finally {
      errSpy.mockRestore();
    }
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { requestId: high.id, result: 'approved' },
        { requestId: mid.id, result: 'INTERNAL_ERROR' },
        { requestId: low.id, result: 'approved' },
      ],
    });

    expect((await readRequest(low.id)).status).toBe('approved');
    expect((await readRequest(mid.id)).status).toBe('pending');
    expect((await readRequest(high.id)).status).toBe('approved');
    expect(await loginsFor(org.id, low.email)).toHaveLength(1);
    expect(await loginsFor(org.id, mid.email)).toEqual([]);
    expect(await loginsFor(org.id, high.email)).toHaveLength(1);
    expect(sentEmails).toEqual([{ kind: 'approved', to: low.email }, { kind: 'approved', to: high.email }]);

    const audits = await decisionAudits(made.map((m) => m.id), 2);
    expect(audits.map((a) => String(a.resourceId)).sort(byId)).toEqual([low.id, high.id].sort(byId));
    expect(audits.every((a) => a.action === 'organization.portal_user.access_request.approve' && a.orgId === org.id)).toBe(true);
  });

  it('two overlapping decide batches [A,B] and [B,A] both complete without a deadlock', async () => {
    const { org, post, base } = await routeFixture();
    const emails = [`ov-a-${randomUUID()}@example.test`, `ov-b-${randomUUID()}@example.test`];
    const [a, b] = [
      requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: emails[0]!, name: null })),
      requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: emails[1]!, name: null })),
    ] as [string, string];

    // Park both batches on a request row lock before either takes one. In client
    // order the first batch would queue on A and the second on B; once let go,
    // each would hold one row and wait for the other's (40P01).
    const held = holdLock(sql`SELECT 1 FROM portal_access_requests WHERE id IN (${a}, ${b}) FOR UPDATE`);
    await held.ready;
    let forward: Response | Promise<Response> | undefined;
    let reverse: Response | Promise<Response> | undefined;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      forward = post(`${base}/decide`, { requestIds: [a, b], decision: 'deny' });
      reverse = post(`${base}/decide`, { requestIds: [b, a], decision: 'deny' });
      await waitForLockWaiters('%from "portal_access_requests"%for update%', 2);
    } finally {
      held.release();
      await held.done;
    }
    const responses = [await forward!, await reverse!];
    errSpy.mockRestore();

    const bodies: Array<{ data: Array<{ requestId: string; result: string }> }> = [];
    for (const r of responses) {
      expect(r.status, await r.clone().text()).toBe(200);
      bodies.push(await r.json());
    }
    expect(bodies.map((body) => body.data.map((d) => d.requestId))).toEqual([[a, b], [b, a]]);
    // One batch decided both rows; the other found them already decided.
    expect(bodies.map((body) => body.data.map((d) => d.result).join(',')).sort()).toEqual([
      'PORTAL_ACCESS_REQUEST_NOT_PENDING,PORTAL_ACCESS_REQUEST_NOT_PENDING',
      'denied,denied',
    ]);
    expect((await readRequest(a)).status).toBe('denied');
    expect((await readRequest(b)).status).toBe('denied');
    expect(sentEmails.map((e) => e.to).sort()).toEqual([...emails].sort());
  });

  it('a failed DB statement on the decision-email path leaves the decision committed: 200, emailSent false', async () => {
    const { org, post, base } = await routeFixture();
    const entraEmail = `mailfail-entra-${randomUUID()}@example.test`;
    const selfEmail = `mailfail-self-${randomUUID()}@${await verifiedSelfDomain(org)}`;
    const denyEmail = `mailfail-deny-${randomUUID()}@example.test`;
    const entraId = requestIdOf(await createPortalAccessRequest({
      source: 'entra', orgId: org.id, email: entraEmail, name: null, tid: await provenTid(org.id), oid: randomUUID(),
    }));
    const selfId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: selfEmail, name: null }));
    const denyId = requestIdOf(await createPortalAccessRequest({ source: 'google', orgId: org.id, email: denyEmail, name: null, sub: `g-${randomUUID()}`, hostedDomain: 'example.test' }));

    routeFaults.emailDbFault = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // The "approved" email: the failure propagates out of the send.
      const entra = await post(`${base}/${entraId}/approve`);
      expect(entra.status, await entra.clone().text()).toBe(200);
      const entraBody = await entra.json();
      expect(entraBody).toMatchObject({ data: { outcome: 'account_created' }, emailSent: false });

      // The invite: issueAndSendInvite catches the send failure INSIDE itself,
      // which on its own would still poison the request transaction.
      const self = await post(`${base}/${selfId}/approve`);
      expect(self.status, await self.clone().text()).toBe(200);
      expect(await self.json()).toMatchObject({ data: { outcome: 'invite_pending' }, emailSent: false });

      // The batch path's declined email.
      const denied = await post(`${base}/decide`, { requestIds: [denyId], decision: 'deny' });
      expect(denied.status, await denied.clone().text()).toBe(200);
      expect(await denied.json()).toEqual({ data: [{ requestId: denyId, result: 'denied' }] });
    } finally {
      errSpy.mockRestore();
    }

    expect((await readRequest(entraId)).status).toBe('approved');
    expect((await readRequest(selfId)).status).toBe('approved');
    expect((await readRequest(denyId)).status).toBe('denied');
    expect(await loginsFor(org.id, entraEmail)).toHaveLength(1);
    expect((await loginsFor(org.id, selfEmail)).map((l) => l.status)).toEqual(['invited']);
    expect(sentEmails).toEqual([]);
    const audits = await decisionAudits([entraId, selfId, denyId], 3);
    expect(audits.map((a) => String(a.resourceId)).sort(byId)).toEqual([entraId, selfId, denyId].sort(byId));
  });

  it('CONTROL: without the savepoints the same failed email statement rolls the approval back (500 at commit)', async () => {
    const { org, post, base } = await routeFixture();
    const email = `mailfail-nosp-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({
      source: 'entra', orgId: org.id, email, name: null, tid: await provenTid(org.id), oid: randomUUID(),
    }));
    routeFaults.emailDbFault = true;
    routeFaults.noSavepoint = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await post(`${base}/${requestId}/approve`);
      expect(res.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
    expect((await readRequest(requestId)).status).toBe('pending');
    expect(await loginsFor(org.id, email)).toEqual([]);
  });

  it('a caught 409 inside the request transaction stays a 409 (not a 500 at commit)', async () => {
    const { org, post, base } = await routeFixture();
    const email = `fault-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({
      source: 'entra', orgId: org.id, email, name: null, tid: await provenTid(org.id), oid: randomUUID(),
    }));

    routeFaults.contactLink = true;
    const refused = await post(`${base}/${requestId}/approve`);
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'forced refusal after a failed statement', code: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED',
    });
    expect((await readRequest(requestId)).status).toBe('pending');
    expect(await loginsFor(org.id, email)).toEqual([]);
    expect(sentEmails).toEqual([]);

    // The request committed cleanly, and the same request approves once the fault is gone.
    routeFaults.contactLink = false;
    const approved = await post(`${base}/${requestId}/approve`);
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await approved.json()).data.outcome).toBe('account_created');
    expect(await loginsFor(org.id, email)).toHaveLength(1);
    expect(sentEmails).toEqual([{ kind: 'approved', to: email }]);
  });

  it('CONTROL: without the service savepoint the same caught 409 turns into a 500 at commit', async () => {
    const { org, post, base } = await routeFixture();
    const email = `nosp-${randomUUID()}@example.test`;
    const requestId = requestIdOf(await createPortalAccessRequest({
      source: 'entra', orgId: org.id, email, name: null, tid: await provenTid(org.id), oid: randomUUID(),
    }));
    routeFaults.contactLink = true;
    routeFaults.noSavepoint = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await post(`${base}/${requestId}/approve`);
      expect(res.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
    expect((await readRequest(requestId)).status).toBe('pending');
  });

  it('decide runs every id through the real router and commits the approvals around a refused id', async () => {
    const { org, get, post, base } = await routeFixture();
    const entraEmail = `d-entra-${randomUUID()}@example.test`;
    const selfDomain = await verifiedSelfDomain(org);
    const takenEmail = `d-taken-${randomUUID()}@${selfDomain}`;
    const selfEmail = `d-self-${randomUUID()}@${selfDomain}`;
    const entraId = requestIdOf(await createPortalAccessRequest({
      source: 'entra', orgId: org.id, email: entraEmail, name: null, tid: await provenTid(org.id), oid: randomUUID(),
    }));
    const takenId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: takenEmail, name: null }));
    const selfId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email: selfEmail, name: null }));
    await sys(() => db.insert(portalUsers).values({
      orgId: org.id, email: takenEmail, authMethod: 'password', status: 'invited', browserAccess: 'granted',
    }));

    const res = await post(`${base}/decide`, { requestIds: [entraId, takenId, selfId], decision: 'approve' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { requestId: entraId, result: 'approved' },
        { requestId: takenId, result: 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS' },
        { requestId: selfId, result: 'approved' },
      ],
    });
    expect((await readRequest(entraId)).status).toBe('approved');
    expect((await readRequest(takenId)).status).toBe('pending');
    expect((await readRequest(selfId)).status).toBe('approved');
    expect(await loginsFor(org.id, entraEmail)).toHaveLength(1);
    expect(await loginsFor(org.id, takenEmail)).toHaveLength(1);
    expect((await loginsFor(org.id, selfEmail)).map((l) => l.status)).toEqual(['invited']);
    // Sent in ascending id order (the route's lock order), so compare as a set.
    expect([...sentEmails].sort((x, y) => (x.to < y.to ? -1 : 1)))
      .toEqual([{ kind: 'approved', to: entraEmail }, { kind: 'invite', to: selfEmail }].sort((x, y) => (x.to < y.to ? -1 : 1)));

    // The list reads the same rows under the request's RLS context.
    const pending = await get(base);
    expect(pending.status).toBe(200);
    expect((await pending.json()).data.map((i: { id: string }) => i.id)).toEqual([takenId]);
    const decided = await get(`${base}?status=decided`);
    expect((await decided.json()).data.map((i: { id: string }) => i.id).sort()).toEqual([entraId, selfId].sort());
  });

  it('a plain-email invite racing a self-request approval through the real routes yields exactly one account', async () => {
    const { org, post, base } = await routeFixture();
    const email = `race-route-${randomUUID()}@${await verifiedSelfDomain(org)}`;
    const requestId = requestIdOf(await createPortalAccessRequest({ source: 'self', orgId: org.id, email, name: null }));

    // Park both requests on the per-address advisory lock, approve first.
    // Waiters are granted in queue order, so approve creates the invited
    // account and its request commits before the invite runs. An invite that
    // read the existing login BEFORE queueing acts on a stale "none" and
    // inserts a second portal_users row (portal_users.email is not unique).
    const held = holdLock(sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${org.id}:${email}`}))`);
    await held.ready;
    let approving: Response | Promise<Response> | undefined;
    let inviting: Response | Promise<Response> | undefined;
    try {
      approving = post(`${base}/${requestId}/approve`);
      await waitForLockWaiters('%pg_advisory_xact_lock%', 1);
      inviting = post(`/organizations/${org.id}/portal-users/invite`, { email });
      await waitForLockWaiters('%pg_advisory_xact_lock%', 2);
    } finally {
      held.release();
      await held.done;
    }
    const approveRes = await approving!;
    const inviteRes = await inviting!;

    expect(approveRes.status, await approveRes.clone().text()).toBe(200);
    expect((await approveRes.json()).data.outcome).toBe('invite_pending');
    expect(inviteRes.status, await inviteRes.clone().text()).toBe(200);
    const logins = await loginsFor(org.id, email);
    expect(logins).toHaveLength(1);
    // The invite re-invited the account approve created rather than minting another.
    expect((await inviteRes.json()).data.id).toBe(logins[0]!.id);
    expect((await readRequest(requestId)).portalUserId).toBe(logins[0]!.id);
  });
});
