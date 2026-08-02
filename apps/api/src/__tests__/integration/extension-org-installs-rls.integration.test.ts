/**
 * RLS forge proof for extension_org_installs — AND the deliberate two-path
 * asymmetry from the design: the gateway reads this table in system scope, so
 * it must see rows the caller's own org scope would hide.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { extensionOrgInstalls, installedExtensions } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    // Two orgs via the shared integration fixtures (see db-utils in this dir),
    // same pattern as builtinCatalogRls.integration.test.ts.
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    await db.insert(installedExtensions).values({
      name: 'rls-demo',
      enabled: true,
      lifecycleState: 'active',
    }).onConflictDoNothing();
    await db.insert(extensionOrgInstalls).values([
      { extensionName: 'rls-demo', orgId: orgA.id, enabled: true },
      { extensionName: 'rls-demo', orgId: orgB.id, enabled: true },
    ]);
    return { orgA, orgB };
  });
}

describe('extension_org_installs RLS (org axis, two access paths)', () => {
  runDb('org scope sees only its own install row', async () => {
    const { orgA, orgB } = await seed();
    const rows = await withDbAccessContext(orgCtx(orgA.id), () =>
      db.select().from(extensionOrgInstalls)
        .where(eq(extensionOrgInstalls.extensionName, 'rls-demo')));
    expect(rows.map((r) => r.orgId)).toEqual([orgA.id]);
    expect(rows.map((r) => r.orgId)).not.toContain(orgB.id);
  });

  runDb('system scope sees rows the caller scope hides (the gateway read path)', async () => {
    const { orgA, orgB } = await seed();
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(extensionOrgInstalls)
        .where(eq(extensionOrgInstalls.extensionName, 'rls-demo')));
    expect(rows.map((r) => r.orgId).sort()).toEqual([orgA.id, orgB.id].sort());
  });

  runDb('org scope cannot forge an install row for another org', async () => {
    const { orgA, orgB } = await seed();
    await expect(withDbAccessContext(orgCtx(orgA.id), () =>
      db.insert(extensionOrgInstalls).values({
        extensionName: 'rls-demo', orgId: orgB.id, enabled: true,
      }))).rejects.toThrow();
  });
});
