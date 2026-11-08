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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { portalUserIdentities, portalUsers } from '../../db/schema/portal';
import * as orgMergeModule from '../../services/orgMerge';
import { ensureEntraIdentity, reconcilePortalUserIdentities } from '../../services/portalUserIdentities';
import { createOrganization, createPartner } from './db-utils';
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
    await replayMigration('2027-01-22-210500-portal-account-foundations.sql');

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

  it('caps samples at sampleLimit but still reports the full count', async () => {
    await seedEntraLogin(fx.orgId);
    await seedEntraLogin(fx.orgId);
    await seedEntraLogin(fx.orgId);
    const report = await reconcilePortalUserIdentities({ sampleLimit: 2 });
    expect(report.counts.missingIdentity).toBe(3);
    expect(report.samples.missingIdentity).toHaveLength(2);
  });
});
