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

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { portalUserIdentities, portalUsers } from '../../db/schema/portal';
import * as orgMergeModule from '../../services/orgMerge';
import { createOrganization, createPartner } from './db-utils';
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
