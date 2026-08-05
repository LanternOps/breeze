/**
 * RLS coverage for `drizzleInstallManagementPort` (routes/extensionOrgInstalls.ts)
 * — the production port the partner management API's routes call. The route
 * unit tests (routes/extensionOrgInstalls.test.ts) inject an in-memory
 * `ExtensionOrgInstallManagementPort` and never touch Postgres, so they can't
 * prove the RLS backstop described in that route's docstring: "reads/writes
 * run in the ambient request context so the org-axis RLS on
 * extension_org_installs bounds it a second time — deliberately unlike the
 * gateway's system-scope read." This file exercises the REAL port against a
 * live Postgres connection with the policies from
 * migrations/2026-08-10-extension-org-installs.sql actually enforced.
 *
 * Modeled on extension-org-installs-rls.integration.test.ts (Task 2) — same
 * `./setup` import, `runDb` guard, and db-utils seeding. `extension_org_installs`
 * is in `setup.ts`'s CLEANUP_TABLES, so each test starts with an empty table;
 * `installed_extensions` (its FK parent) is NOT truncated between tests, so
 * the seed below upserts idempotently with `onConflictDoNothing`.
 */
import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { extensionOrgInstalls, installedExtensions } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { drizzleInstallManagementPort } from '../../routes/extensionOrgInstalls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const EXTENSION_NAME = 'org-install-port-rls-demo';

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
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    await db.insert(installedExtensions).values({
      name: EXTENSION_NAME,
      enabled: true,
      lifecycleState: 'active',
    }).onConflictDoNothing();

    return { orgA, orgB };
  });
}

describe('drizzleInstallManagementPort under extension_org_installs RLS', () => {
  runDb('upsert succeeds for an accessible org', async () => {
    const { orgA } = await seed();
    const actorId = randomUUID();

    await withDbAccessContext(orgCtx(orgA.id), () =>
      drizzleInstallManagementPort.upsert(EXTENSION_NAME, orgA.id, actorId));

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(extensionOrgInstalls)
        .where(eq(extensionOrgInstalls.extensionName, EXTENSION_NAME)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: orgA.id, enabled: true, installedBy: actorId });
  });

  runDb('upsert for an inaccessible org is rejected by RLS', async () => {
    const { orgA, orgB } = await seed();
    const actorId = randomUUID();

    // orgB is outside orgA's DbAccessContext — the INSERT ... WITH CHECK
    // policy (breeze_has_org_access(org_id)) rejects it outright, unlike the
    // UPDATE case below where an inaccessible row is merely invisible.
    await expect(
      withDbAccessContext(orgCtx(orgA.id), () =>
        drizzleInstallManagementPort.upsert(EXTENSION_NAME, orgB.id, actorId)),
    ).rejects.toThrow();

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(extensionOrgInstalls)
        .where(eq(extensionOrgInstalls.extensionName, EXTENSION_NAME)));
    expect(rows).toHaveLength(0);
  });

  runDb('list under org scope returns only accessible-org rows; system scope sees all', async () => {
    const { orgA, orgB } = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(extensionOrgInstalls).values([
        { extensionName: EXTENSION_NAME, orgId: orgA.id, enabled: true },
        { extensionName: EXTENSION_NAME, orgId: orgB.id, enabled: true },
      ]));

    const orgScoped = await withDbAccessContext(orgCtx(orgA.id), () =>
      drizzleInstallManagementPort.list(EXTENSION_NAME));
    expect(orgScoped.map((r) => r.orgId)).toEqual([orgA.id]);

    const systemScoped = await withSystemDbAccessContext(() =>
      drizzleInstallManagementPort.list(EXTENSION_NAME));
    expect(systemScoped.map((r) => r.orgId).sort()).toEqual([orgA.id, orgB.id].sort());
  });

  runDb('disable under org scope only affects accessible rows', async () => {
    const { orgA, orgB } = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(extensionOrgInstalls).values([
        { extensionName: EXTENSION_NAME, orgId: orgA.id, enabled: true },
        { extensionName: EXTENSION_NAME, orgId: orgB.id, enabled: true },
      ]));

    // The caller's own row: disable succeeds and reports true.
    const ownResult = await withDbAccessContext(orgCtx(orgA.id), () =>
      drizzleInstallManagementPort.disable(EXTENSION_NAME, orgA.id));
    expect(ownResult).toBe(true);

    // Another org's row: the UPDATE ... USING policy filters it out before
    // the WHERE clause ever sees it, so the port reports "no row" (false)
    // rather than throwing — the asymmetry with the upsert/INSERT case above
    // (WITH CHECK rejects outright) is expected RLS behavior, not a bug.
    const otherResult = await withDbAccessContext(orgCtx(orgA.id), () =>
      drizzleInstallManagementPort.disable(EXTENSION_NAME, orgB.id));
    expect(otherResult).toBe(false);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(extensionOrgInstalls)
        .where(eq(extensionOrgInstalls.extensionName, EXTENSION_NAME)));
    const enabledByOrg = new Map(rows.map((r) => [r.orgId, r.enabled]));
    expect(enabledByOrg.get(orgA.id)).toBe(false);
    expect(enabledByOrg.get(orgB.id)).toBe(true);
  });
});
