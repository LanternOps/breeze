/**
 * Portal registration W2 (#11379): `portal_user_identities` against real
 * Postgres — tenancy (forced RLS as breeze_app), the composite same-org FK,
 * cascade, org merge, uniqueness and the issuer CHECK.
 *
 * Fixtures are written with the superuser handle on purpose: the point is what
 * the DATABASE refuses. The cases that are about the unprivileged role say so
 * and run through `withDbAccessContext` on the app pool.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalUserIdentities.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

// W3: the MSP routes below email invites; nothing here reads the mail.
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({ sendPortalInvite: async () => undefined, sendPasswordReset: async () => undefined }),
}));

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { contacts } from '../../db/schema/contacts';
import { portalUserIdentities, portalUsers } from '../../db/schema/portal';
import { clientAiOrgPolicies, clientAiTenantMappings } from '../../db/schema/clientAi';
import * as orgMergeModule from '../../services/orgMerge';
import { resolveAndMintClientSession } from '../../services/clientAiExchange';
import type { ClientAiEntraClaims } from '../../services/clientAiEntraJwt';
import {
  ensureEntraIdentity,
  findPortalUserIdByEntraIdentity,
  listIdentityProvidersByUser,
  portalUserHasIdentitySql,
  reconcilePortalUserIdentities,
} from '../../services/portalUserIdentities';
import { listPortalUsersForOrg } from '../../services/portalUserDirectory';
import { authMiddleware } from '../../middleware/auth';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { clientAiAdminOrgRoutes } from '../../routes/clientAi/adminOrgs';
import { validatePortalCapability } from '../../routes/portal/capabilityTokens';
import { processPortalIdentityReconcileJob } from '../../jobs/portalIdentityReconcile';
import { createAccessToken } from '../../services/jwt';
import { createOrganization, createPartner, setupTestEnvironment } from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const admin = () => getTestDb() as any;
const entraIss = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

let fx: { partnerId: string; orgId: string };

beforeEach(async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  fx = { partnerId: partner.id, orgId: org.id };
});

async function otherOrg(): Promise<string> {
  const org = await createOrganization({ partnerId: fx.partnerId });
  return org.id as string;
}

/** An add-in (Entra) login in `orgId`. */
async function seedEntraLogin(orgId: string, ids: { tid?: string; oid?: string } = {}) {
  const tid = ids.tid ?? randomUUID();
  const oid = ids.oid ?? randomUUID();
  const [row] = await admin()
    .insert(portalUsers)
    .values({
      orgId,
      email: `${oid}@${tid}.entra.invalid`,
      authMethod: 'entra',
      entraTenantId: tid,
      entraOid: oid,
      browserAccess: 'none',
    })
    .returning({ id: portalUsers.id });
  return { id: row.id as string, tid, oid };
}

async function seedIdentity(orgId: string, portalUserId: string, tid: string, oid: string) {
  const [row] = await admin()
    .insert(portalUserIdentities)
    .values({
      orgId,
      portalUserId,
      provider: 'entra',
      issuer: entraIss(tid),
      subject: oid,
      entraTenantId: tid,
      linkedVia: 'jit',
    })
    .returning({ id: portalUserIdentities.id });
  return row.id as string;
}

describe('portal_user_identities — tenancy and constraints', () => {
  it('refuses an identity whose org_id differs from its portal user (23503 portal_user_identities_user_org_fk)', async () => {
    const login = await seedEntraLogin(fx.orgId);
    const foreignOrg = await otherOrg();
    await expect(seedIdentity(foreignOrg, login.id, login.tid, login.oid)).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'portal_user_identities_user_org_fk' },
    });
  });

  it('refuses a cross-tenant INSERT as breeze_app under org A context naming org B (42501)', async () => {
    const orgB = await otherOrg();
    const loginB = await seedEntraLogin(orgB);
    const forge = withDbAccessContext(orgCtx(fx.orgId), () =>
      db.insert(portalUserIdentities).values({
        orgId: orgB,
        portalUserId: loginB.id,
        provider: 'entra',
        issuer: entraIss(loginB.tid),
        subject: loginB.oid,
        entraTenantId: loginB.tid,
        linkedVia: 'jit',
      }),
    );
    await expect(forge).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('hides org B identities from an org A context (SELECT returns 0)', async () => {
    const orgB = await otherOrg();
    const loginB = await seedEntraLogin(orgB);
    await seedIdentity(orgB, loginB.id, loginB.tid, loginB.oid);

    const seenFromA = await withDbAccessContext(orgCtx(fx.orgId), () =>
      db.select({ id: portalUserIdentities.id }).from(portalUserIdentities),
    );
    expect(seenFromA).toHaveLength(0);
    // Control: the row is visible to its own org, so the 0 above is RLS, not an empty table.
    const seenFromB = await withDbAccessContext(orgCtx(orgB), () =>
      db.select({ id: portalUserIdentities.id }).from(portalUserIdentities),
    );
    expect(seenFromB).toHaveLength(1);
  });

  it('portal_user_identities_user_org_fk is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const [row] = await admin().execute(sql`
      SELECT condeferrable, condeferred, confdeltype
        FROM pg_constraint
       WHERE conname = 'portal_user_identities_user_org_fk'
         AND conrelid = 'portal_user_identities'::regclass
    `);
    expect(row).toMatchObject({ condeferrable: true, condeferred: false, confdeltype: 'c' });
  });

  it('deletes identities when the portal user is deleted (ON DELETE CASCADE)', async () => {
    const login = await seedEntraLogin(fx.orgId);
    const identityId = await seedIdentity(fx.orgId, login.id, login.tid, login.oid);
    await admin().delete(portalUsers).where(eq(portalUsers.id, login.id));
    const rows = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.id, identityId));
    expect(rows).toHaveLength(0);
  });

  it('refuses a second entra identity for the same user (23505 portal_user_identities_user_provider_uq)', async () => {
    const login = await seedEntraLogin(fx.orgId);
    await seedIdentity(fx.orgId, login.id, login.tid, login.oid);
    await expect(seedIdentity(fx.orgId, login.id, login.tid, randomUUID())).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'portal_user_identities_user_provider_uq' },
    });
  });

  it('refuses the same (issuer, subject) on two users (23505 portal_user_identities_issuer_subject_uq)', async () => {
    const first = await seedEntraLogin(fx.orgId);
    const second = await seedEntraLogin(fx.orgId);
    await seedIdentity(fx.orgId, first.id, first.tid, first.oid);
    await expect(seedIdentity(fx.orgId, second.id, first.tid, first.oid)).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'portal_user_identities_issuer_subject_uq' },
    });
  });

  it('refuses an entra issuer that does not embed entra_tenant_id (23514 portal_user_identities_issuer_chk)', async () => {
    const login = await seedEntraLogin(fx.orgId);
    const forge = admin().insert(portalUserIdentities).values({
      orgId: fx.orgId,
      portalUserId: login.id,
      provider: 'entra',
      issuer: entraIss(randomUUID()),
      subject: login.oid,
      entraTenantId: login.tid,
      linkedVia: 'jit',
    });
    await expect(forge).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'portal_user_identities_issuer_chk' },
    });
  });
});

describe('org merge re-tenants portal_user_identities', () => {
  let priorDrain: string | undefined;

  beforeEach(() => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  });
  afterEach(() => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  it('org merge re-tenants the login AND its identity to the survivor, link intact', async () => {
    const survivorId = await otherOrg();
    const login = await seedEntraLogin(fx.orgId);
    const identityId = await seedIdentity(fx.orgId, login.id, login.tid, login.oid);

    await orgMergeModule.executeOrgMerge({
      loserOrgId: fx.orgId,
      survivorOrgId: survivorId,
      partnerId: fx.partnerId,
      performedBy: randomUUID(),
      performedByEmail: `merge-actor-${randomUUID()}@example.test`,
    });

    const [loginRow] = await admin()
      .select({ orgId: portalUsers.orgId })
      .from(portalUsers)
      .where(eq(portalUsers.id, login.id));
    const [identityRow] = await admin()
      .select({ orgId: portalUserIdentities.orgId, portalUserId: portalUserIdentities.portalUserId })
      .from(portalUserIdentities)
      .where(eq(portalUserIdentities.id, identityId));

    expect(loginRow.orgId).toBe(survivorId);
    expect(identityRow).toEqual({ orgId: survivorId, portalUserId: login.id });
  });
});

// ---------------------------------------------------------------------------
// Task 3: identity writes + drift report (services/portalUserIdentities.ts)
// ---------------------------------------------------------------------------

describe('ensureEntraIdentity (real Postgres, breeze_app, system context)', () => {
  it('inserts once, then reports present and bumps last_used_at', async () => {
    const login = await seedEntraLogin(fx.orgId);
    const first = new Date('2026-11-01T00:00:00Z');
    const second = new Date('2026-11-02T00:00:00Z');
    const input = { orgId: fx.orgId, portalUserId: login.id, tid: login.tid, oid: login.oid };

    await expect(withSystemDbAccessContext(() => ensureEntraIdentity(db, { ...input, usedAt: first }))).resolves.toBe('inserted');
    await expect(withSystemDbAccessContext(() => ensureEntraIdentity(db, { ...input, usedAt: second }))).resolves.toBe('present');

    const rows = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, login.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ linkedVia: 'jit', issuer: entraIss(login.tid), subject: login.oid });
    expect((rows[0].lastUsedAt as Date).toISOString()).toBe(second.toISOString());
  });

  it('reports conflict (no throw, transaction still usable) when the subject belongs to another user', async () => {
    const owner = await seedEntraLogin(fx.orgId);
    const other = await seedEntraLogin(fx.orgId);
    await seedIdentity(fx.orgId, owner.id, owner.tid, owner.oid);

    const outcome = await withSystemDbAccessContext(async () => {
      const r = await ensureEntraIdentity(db, { orgId: fx.orgId, portalUserId: other.id, tid: owner.tid, oid: owner.oid, usedAt: new Date() });
      // Same transaction: a 23505 here would have aborted it (25P02).
      const [probe] = await db.execute<{ one: number }>(sql`SELECT 1 AS one`);
      return { r, probe };
    });
    expect(outcome.r).toBe('conflict');
    expect(outcome.probe).toEqual({ one: 1 });
  });

  it('reports conflict when the user already holds a different entra subject', async () => {
    const login = await seedEntraLogin(fx.orgId);
    await seedIdentity(fx.orgId, login.id, login.tid, login.oid);
    const outcome = await withSystemDbAccessContext(() =>
      ensureEntraIdentity(db, { orgId: fx.orgId, portalUserId: login.id, tid: login.tid, oid: randomUUID(), usedAt: new Date() }),
    );
    expect(outcome).toBe('conflict');
  });
});

describe('reconcilePortalUserIdentities (drift report, read-only)', () => {
  it('drift report is clean right after the migration backfill', async () => {
    await seedEntraLogin(fx.orgId);
    await seedEntraLogin(await otherOrg());
    // Replaying the (idempotent) migration runs the release-A backfill over the rows above.
    await replayMigration('2027-01-22-230200-portal-account-foundations.sql');

    const report = await reconcilePortalUserIdentities();
    expect(report.counts).toEqual({ missingIdentity: 0, orphanIdentity: 0, mismatched: 0, halfPopulated: 0 });
    const [{ n }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_user_identities`);
    expect(n).toBe(2);
  });

  it('drift report counts a missing identity, an orphan identity, a mismatched subject and a half-populated row', async () => {
    const missing = await seedEntraLogin(fx.orgId);

    const orphanUser = await seedEntraLogin(fx.orgId);
    const orphanIdentity = await seedIdentity(fx.orgId, orphanUser.id, orphanUser.tid, orphanUser.oid);
    await admin().update(portalUsers).set({ entraOid: null, entraTenantId: null }).where(eq(portalUsers.id, orphanUser.id));

    const mismatchedUser = await seedEntraLogin(fx.orgId);
    const mismatchedIdentity = await seedIdentity(fx.orgId, mismatchedUser.id, mismatchedUser.tid, randomUUID());

    const half = await seedEntraLogin(fx.orgId);
    await admin().update(portalUsers).set({ entraTenantId: null }).where(eq(portalUsers.id, half.id));

    const report = await reconcilePortalUserIdentities();
    expect(report.counts).toEqual({ missingIdentity: 1, orphanIdentity: 1, mismatched: 1, halfPopulated: 1 });
    expect(report.samples.missingIdentity).toEqual([{ portalUserId: missing.id, orgId: fx.orgId }]);
    expect(report.samples.orphanIdentity).toEqual([{ identityId: orphanIdentity, portalUserId: orphanUser.id }]);
    expect(report.samples.mismatched).toEqual([{ portalUserId: mismatchedUser.id, identityId: mismatchedIdentity, field: 'subject' }]);
    expect(report.samples.halfPopulated).toEqual([{ portalUserId: half.id }]);
    expect(typeof report.checkedAt).toBe('string');
  });

  it('drift report scoped by orgId ignores other orgs', async () => {
    const elsewhere = await otherOrg();
    await seedEntraLogin(elsewhere); // missing identity in another org
    const scoped = await reconcilePortalUserIdentities({ orgId: fx.orgId });
    expect(scoped.counts).toEqual({ missingIdentity: 0, orphanIdentity: 0, mismatched: 0, halfPopulated: 0 });
    const all = await reconcilePortalUserIdentities();
    expect(all.counts.missingIdentity).toBe(1);
  });

  it('caps samples at sampleLimit (count stays the full total)', async () => {
    await seedEntraLogin(fx.orgId);
    await seedEntraLogin(fx.orgId);
    await seedEntraLogin(fx.orgId);
    const report = await reconcilePortalUserIdentities({ sampleLimit: 2 });
    expect(report.counts.missingIdentity).toBe(3);
    expect(report.samples.missingIdentity).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Task 4: AI for Office exchange dual-write (real Postgres, breeze_app)
// ---------------------------------------------------------------------------

/** The exchange mints a Redis session; nothing here asserts on it. */
const fakeRedis = {
  setex: async () => 'OK',
  sadd: async () => 1,
  expire: async () => 1,
} as never;

async function mapTenant(orgId: string, partnerId: string): Promise<string> {
  await admin().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, partnerId));
  const tid = randomUUID();
  await admin().insert(clientAiTenantMappings).values({ orgId, entraTenantId: tid });
  await admin().insert(clientAiOrgPolicies).values({ orgId, enabled: true });
  return tid;
}

const exchangeClaims = (tid: string, oid: string) =>
  ({
    tid,
    oid,
    upn: null,
    emailClaim: null,
    emailDomainOwnerVerified: false,
    email: null,
    name: 'Ada Addin',
    aud: 'api://breeze',
    iss: entraIss(tid),
    exp: 0,
    iat: 0,
    scp: null,
  }) as unknown as ClientAiEntraClaims;

describe('resolveAndMintClientSession dual-writes portal_user_identities', () => {
  it('first exchange creates login (browser_access none) + identity atomically; drift report stays clean', async () => {
    const tid = await mapTenant(fx.orgId, fx.partnerId);
    const oid = randomUUID();

    const outcome = await resolveAndMintClientSession(exchangeClaims(tid, oid), fakeRedis);
    expect(outcome.kind).toBe('resolved');

    const [login] = await admin().select().from(portalUsers).where(eq(portalUsers.entraOid, oid));
    expect(login).toMatchObject({ authMethod: 'entra', status: 'active', browserAccess: 'none', orgId: fx.orgId });
    const identities = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, login.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      orgId: fx.orgId, provider: 'entra', issuer: entraIss(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
    });
    const report = await reconcilePortalUserIdentities();
    expect(report.counts).toEqual({ missingIdentity: 0, orphanIdentity: 0, mismatched: 0, halfPopulated: 0 });
  });

  it('release B: an identity whose login carries different legacy columns resolves to THAT login; no JIT, and the drift report flags the mismatch', async () => {
    // W2 (release A) looked the login up by the entra_* columns, so this
    // shape — the identity (tid, oid) held by a login whose columns say
    // something else — missed, JIT-inserted, collided on the identity and was
    // denied (provisioning_failed; the savepoint rollback is still pinned by
    // clientAiExchange.test.ts). Release B makes the identity the source of
    // truth (spec §5.2): the token resolves to the identity's login and the
    // stale columns are reported as drift, never read.
    const tid = await mapTenant(fx.orgId, fx.partnerId);
    const oid = randomUUID();
    const holder = await seedEntraLogin(fx.orgId);
    await seedIdentity(fx.orgId, holder.id, tid, oid);
    const [{ n: before }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_users`);

    const outcome = await resolveAndMintClientSession(exchangeClaims(tid, oid), fakeRedis);

    expect(outcome).toMatchObject({ kind: 'resolved', audit: { actorId: holder.id, details: { provisioned: false } } });
    const [{ n: after }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_users`);
    expect(after).toBe(before);
    expect(await admin().select().from(portalUsers).where(eq(portalUsers.entraOid, oid))).toHaveLength(0);
    expect((await reconcilePortalUserIdentities()).samples.mismatched).toEqual([
      expect.objectContaining({ portalUserId: holder.id, field: 'subject' }),
    ]);
  });

  it('add-in exchange for a login whose identity row is missing fails closed (403 provisioning_failed) and never inserts a second portal_users row', async () => {
    // Release B (W3) reads identities only. A login that kept its legacy
    // entra_* columns but has no identity row (drift the deploy-time backfill
    // should have repaired) is NOT found; the JIT insert then hits the login's
    // own unique index (portal_users_entra_identity_uniq), the identity
    // re-select finds nothing, and the exchange is denied. No silent fallback
    // to the columns, and never a second login for the same (tid, oid).
    const tid = await mapTenant(fx.orgId, fx.partnerId);
    const oid = randomUUID();
    const [legacy] = await admin().execute(sql`
      INSERT INTO portal_users (org_id, email, auth_method, entra_tenant_id, entra_oid)
      VALUES (${fx.orgId}, ${`${oid}@${tid}.entra.invalid`}, 'entra', ${tid}, ${oid})
      RETURNING id`);
    expect((await reconcilePortalUserIdentities()).counts.missingIdentity).toBe(1);
    const [{ n: before }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_users`);

    const outcome = await resolveAndMintClientSession(exchangeClaims(tid, oid), fakeRedis);

    expect(outcome).toMatchObject({ kind: 'denied', status: 403, body: { error: 'provisioning_failed' } });
    const [{ n: after }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_users`);
    expect(after).toBe(before);
    const logins = await admin().select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.entraOid, oid));
    expect(logins).toEqual([{ id: legacy.id }]);
    // Fail closed means no self-heal either: the drift is left for a human (D10).
    expect(await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, legacy.id))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// W3 — identities release B: the AI for Office exchange reads identities
// ---------------------------------------------------------------------------

describe('resolveAndMintClientSession reads portal_user_identities (release B)', () => {
  it('JIT still writes both entra_* columns and the identity (writer fence) and the drift report stays clean', async () => {
    const tid = await mapTenant(fx.orgId, fx.partnerId);
    const oid = randomUUID();

    const first = await resolveAndMintClientSession(exchangeClaims(tid, oid), fakeRedis);
    expect(first).toMatchObject({ kind: 'resolved', audit: { details: { provisioned: true } } });

    const [login] = await admin().select().from(portalUsers).where(eq(portalUsers.orgId, fx.orgId));
    // D4 writer fence: a release-A instance (reads the columns) still finds this login.
    expect(login).toMatchObject({ entraTenantId: tid, entraOid: oid, authMethod: 'entra' });
    expect(await withSystemDbAccessContext(() => findPortalUserIdByEntraIdentity(db, { tid, oid })))
      .toEqual({ portalUserId: login.id, orgId: fx.orgId });
    expect((await reconcilePortalUserIdentities()).counts)
      .toEqual({ missingIdentity: 0, orphanIdentity: 0, mismatched: 0, halfPopulated: 0 });

    // The second exchange resolves the SAME login through its identity: no second row.
    const second = await resolveAndMintClientSession(exchangeClaims(tid, oid), fakeRedis);
    expect(second).toMatchObject({ kind: 'resolved', audit: { actorId: login.id, details: { provisioned: false } } });
    const [{ n }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_users WHERE org_id = ${fx.orgId}`);
    expect(n).toBe(1);
  });

  it('mints for an account found by its entra identity regardless of auth_method (D5)', async () => {
    const tid = await mapTenant(fx.orgId, fx.partnerId);
    const oid = randomUUID();
    // A password account linked to an Entra identity (the W4 shape), legacy columns empty.
    const [pw] = await admin().insert(portalUsers).values({
      orgId: fx.orgId, email: `pw-${oid}@acme.example`, authMethod: 'password', status: 'active', browserAccess: 'granted',
    }).returning({ id: portalUsers.id });
    await seedIdentity(fx.orgId, pw.id, tid, oid);

    const outcome = await resolveAndMintClientSession(exchangeClaims(tid, oid), fakeRedis);

    expect(outcome).toMatchObject({ kind: 'resolved', audit: { actorId: pw.id, details: { provisioned: false } } });
    const logins = await admin().select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.orgId, fx.orgId));
    expect(logins).toEqual([{ id: pw.id }]);
  });

  it('identity in org B for a tenant mapped to org A → org_mismatch denial, nothing written', async () => {
    const tid = await mapTenant(fx.orgId, fx.partnerId);
    const orgB = await otherOrg();
    const loginB = await seedEntraLogin(orgB, { tid });
    await seedIdentity(orgB, loginB.id, tid, loginB.oid);
    const [{ n: before }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_users`);

    const outcome = await resolveAndMintClientSession(exchangeClaims(tid, loginB.oid), fakeRedis);

    expect(outcome).toMatchObject({ kind: 'denied', status: 403, body: { error: 'org_mismatch' } });
    const [{ n: after }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_users`);
    expect(after).toBe(before);
    const [identity] = await admin().select({ lastUsedAt: portalUserIdentities.lastUsedAt })
      .from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, loginB.id));
    expect(identity.lastUsedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W3 — identities release B: the MSP / portal readers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function buildMspApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  registerOrgPortalUsersRoutes(app);
  app.route('/client-ai/admin', clientAiAdminOrgRoutes);
  return app;
}

async function mfaTokenFor(env: Awaited<ReturnType<typeof setupTestEnvironment>>): Promise<string> {
  return createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: 'it-session',
  });
}

/** A browser (password) login with NO legacy entra columns. */
async function seedPasswordLogin(orgId: string, over: Record<string, unknown> = {}) {
  const [row] = await admin().insert(portalUsers).values({
    orgId, email: `pw-${randomUUID()}@acme.example`, authMethod: 'password', status: 'invited', browserAccess: 'granted', ...over,
  }).returning({ id: portalUsers.id, email: portalUsers.email, authEpoch: portalUsers.authEpoch });
  return row as { id: string; email: string; authEpoch: number };
}

describe('external-identity readers use portal_user_identities (release B)', () => {
  it('an identity on ANOTHER user does not make this user identity-managed (single-table select, #9692)', async () => {
    const plain = await seedPasswordLogin(fx.orgId);
    const linked = await seedPasswordLogin(fx.orgId);
    await seedIdentity(fx.orgId, linked.id, randomUUID(), randomUUID());

    // Single-table: exactly where drizzle strips qualifiers from selection sql.
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: portalUsers.id, has: portalUserHasIdentitySql() }).from(portalUsers).where(eq(portalUsers.orgId, fx.orgId)),
    );
    const has = new Map(rows.map((r) => [r.id, r.has]));
    expect(has.get(plain.id)).toBe(false);
    expect(has.get(linked.id)).toBe(true);

    // ...and the same helper negated in a WHERE.
    const without = await withSystemDbAccessContext(() =>
      db.select({ id: portalUsers.id }).from(portalUsers)
        .where(sql`${eq(portalUsers.orgId, fx.orgId)} and not ${portalUserHasIdentitySql()}`),
    );
    expect(without.map((r) => r.id)).toEqual([plain.id]);
  });

  it('an account with an identity row is identity-managed even when entra_oid is NULL (capability, resend, invite, invite-contacts)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const token = await mfaTokenFor(env);
    const app = buildMspApp();
    const plain = await seedPasswordLogin(orgId);
    const linked = await seedPasswordLogin(orgId);
    await seedIdentity(orgId, linked.id, randomUUID(), randomUUID());
    const [legacyColumns] = await admin().select({ entraOid: portalUsers.entraOid }).from(portalUsers).where(eq(portalUsers.id, linked.id));
    expect(legacyColumns.entraOid).toBeNull();

    // Capability consume (accept-invite / reset facts).
    const cap = (u: { id: string; email: string; authEpoch: number }) => validatePortalCapability('invite', {
      format: 'v2', payload: { v: 2, purpose: 'invite', portalUserId: u.id, orgId, email: u.email, authEpoch: u.authEpoch },
    });
    expect(await cap(plain)).toMatchObject({ ok: true, user: { hasExternalIdentity: false } });
    expect(await cap(linked)).toMatchObject({ ok: true, user: { hasExternalIdentity: true } });

    // Resend (getOrgScopedPortalUser → state module).
    const resend = (id: string) => app.request(`/organizations/${orgId}/portal-users/${id}/resend-invite`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    expect((await resend(plain.id)).status).toBe(200);
    const refused = await resend(linked.id);
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('PORTAL_USER_IDENTITY_MANAGED');

    // Invite by email (the existing-row lookup).
    const invited = await app.request(`/organizations/${orgId}/portal-users/invite`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS }, body: JSON.stringify({ email: linked.email }),
    });
    expect(invited.status).toBe(409);
    expect((await invited.json()).code).toBe('PORTAL_INVITE_EXTERNAL_IDENTITY');

    // Invite a contact on the linked login's address (services/contacts/portalInvite.ts).
    const [contact] = await admin().insert(contacts).values({ orgId, name: 'Linked', email: linked.email }).returning({ id: contacts.id });
    const batch = await app.request(`/organizations/${orgId}/portal-users/invite-contacts`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS }, body: JSON.stringify({ contactIds: [contact.id] }),
    });
    expect(batch.status).toBe(200);
    expect((await batch.json()).data.results).toEqual([
      { contactId: contact.id, outcome: 'already_has_access', portalUserId: linked.id, reason: 'external_identity' },
    ]);
    const [after] = await admin().select({ contactId: portalUsers.contactId, authEpoch: portalUsers.authEpoch })
      .from(portalUsers).where(eq(portalUsers.id, linked.id));
    expect(after).toEqual({ contactId: null, authEpoch: linked.authEpoch });
  });

  it('bulk invite skips accounts with any identity row', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const pending = await seedPasswordLogin(orgId);
    const linked = await seedPasswordLogin(orgId);
    await seedIdentity(orgId, linked.id, randomUUID(), randomUUID());

    const res = await buildMspApp().request(`/organizations/${orgId}/portal-users/bulk-invite`, {
      method: 'POST', headers: { Authorization: `Bearer ${await mfaTokenFor(env)}`, ...JSON_HEADERS }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((r: { id: string }) => r.id)).toEqual([pending.id]);
    const [linkedAfter] = await admin().select({ authEpoch: portalUsers.authEpoch, invitedBy: portalUsers.invitedBy })
      .from(portalUsers).where(eq(portalUsers.id, linked.id));
    expect(linkedAfter).toEqual({ authEpoch: linked.authEpoch, invitedBy: null });
  });

  it('identity-only active account reads active, not pending_setup; list items carry browserAccess and identityProviders', async () => {
    const addin = await seedEntraLogin(fx.orgId);
    await seedIdentity(fx.orgId, addin.id, addin.tid, addin.oid);
    const pending = await seedPasswordLogin(fx.orgId);
    const linked = await seedPasswordLogin(fx.orgId, { status: 'active' });
    await seedIdentity(fx.orgId, linked.id, randomUUID(), randomUUID());

    const list = await withDbAccessContext(orgCtx(fx.orgId), () => listPortalUsersForOrg(fx.orgId));
    const byId = new Map(list.map((u) => [u.id, u]));
    expect(byId.get(addin.id)).toMatchObject({ effectiveStatus: 'active', browserAccess: 'none', identityProviders: ['entra'] });
    expect(byId.get(pending.id)).toMatchObject({ effectiveStatus: 'pending_setup', browserAccess: 'granted', identityProviders: [] });
    expect(byId.get(linked.id)).toMatchObject({ effectiveStatus: 'active', identityProviders: ['entra'] });

    const providers = await withSystemDbAccessContext(() => listIdentityProvidersByUser(db, [addin.id, pending.id]));
    expect([...providers.entries()]).toEqual([[addin.id, ['entra']]]);
  });

  it('entra user count and picker come from identities (a password user with an entra identity is counted)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    await admin().insert(clientAiTenantMappings).values({ orgId, entraTenantId: randomUUID() });
    const pwWithIdentity = await seedPasswordLogin(orgId, { status: 'active' });
    await seedIdentity(orgId, pwWithIdentity.id, randomUUID(), randomUUID());
    // An 'entra' login whose identity is gone (drift): no longer counted or offered.
    const strandedEntra = await seedEntraLogin(orgId);
    await seedPasswordLogin(orgId); // a plain password login is never counted

    const app = buildMspApp();
    const auth = { Authorization: `Bearer ${env.token}` };
    const list = await app.request(`/client-ai/admin/orgs?orgId=${orgId}`, { headers: auth });
    expect(list.status).toBe(200);
    expect((await list.json()).data).toEqual([expect.objectContaining({ orgId, mapped: true, consentStatus: 'granted' })]);

    const picker = await app.request(`/client-ai/admin/orgs/${orgId}/users`, { headers: auth });
    expect(picker.status).toBe(200);
    const ids = (await picker.json()).data.map((u: { id: string }) => u.id);
    expect(ids).toEqual([pwWithIdentity.id]);
    expect(ids).not.toContain(strandedEntra.id);
  });

  it('consent stays pending while the only entra-method login has no identity', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    await admin().insert(clientAiTenantMappings).values({ orgId, entraTenantId: randomUUID() });
    await seedEntraLogin(orgId); // auth_method entra, legacy columns set, no identity row

    const res = await buildMspApp().request(`/client-ai/admin/orgs?orgId=${orgId}`, { headers: { Authorization: `Bearer ${env.token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([expect.objectContaining({ orgId, consentStatus: 'pending' })]);
  });
});

// ---------------------------------------------------------------------------
// W3 — the daily drift report job (D10: report, never repair)
// ---------------------------------------------------------------------------

describe('portal identity drift report job', () => {
  it('the real job handler runs against Postgres without throwing "context already held", and never repairs', async () => {
    const missing = await seedEntraLogin(fx.orgId); // drift: no identity row
    const [{ n: before }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_user_identities`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await processPortalIdentityReconcileJob();
      expect(result.clean).toBe(false);
      expect(result.counts.missingIdentity).toBe(1);
    } finally {
      log.mockRestore();
    }
    const [{ n: after }] = await admin().execute(sql`SELECT count(*)::int AS n FROM portal_user_identities`);
    expect(after).toBe(before);
    expect(await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, missing.id))).toHaveLength(0);
  });
});
