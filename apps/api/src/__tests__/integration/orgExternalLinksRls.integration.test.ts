/**
 * Functional forge proof for organization_external_links (#3242).
 *
 * Shape 1 (direct org_id): breeze_has_org_access(org_id) policies, enabled
 * and forced in 2026-08-08-organization-external-links.sql. These tests run
 * through the real driver as the unprivileged app role under the integration
 * config; do not run them with the plain unit-test Vitest config.
 *
 * Also proves:
 *  - the composite FK (org_id, partner_id) → organizations (id, partner_id)
 *    makes a drifted partner_id unrepresentable even under system scope;
 *  - the migration backfill maps legacy accounting_* columns into link rows
 *    exactly once, and replaying the migration is a no-op.
 *
 * Fixtures are re-seeded per test — the integration setup truncates tenant
 * data between tests, so memoized fixtures would be stale and vacuous.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { organizationExternalLinks, organizations } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION_FILE = '2026-08-08-organization-external-links.sql';

function migrationText(): string {
  return readFileSync(join(__dirname, '../../../migrations', MIGRATION_FILE), 'utf8');
}

function partnerCtx(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    return { partnerA, orgA, partnerB, orgB };
  });
}

async function captureCause(fn: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause) return cause;
    const direct = err as { code?: string; message?: string };
    return direct.code ? { code: direct.code, message: direct.message } : { message: direct.message };
  }
}

describe('organization_external_links RLS — org-axis forge (breeze_app role)', () => {
  // Non-vacuity guard: if the code-under-test pool is ever a BYPASSRLS role
  // (e.g. a worktree missing its .env.test symlink), every forge assertion
  // below passes even with broken policies. Fail loudly here first.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { partnerA, orgA } = await seedFixture();
    const rows = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  runDb('allows an accessible-org link insert and read-back', async () => {
    const { partnerA, orgA } = await seedFixture();

    const [row] = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
      db.insert(organizationExternalLinks).values({
        orgId: orgA.id,
        partnerId: partnerA.id,
        system: 'datto_rmm',
        externalId: 'ext-1',
      }).returning({ id: organizationExternalLinks.id })
    );
    expect(row?.id).toBeDefined();
  });

  runDb('rejects a cross-partner forge INSERT with an RLS violation (42501)', async () => {
    const { partnerA, orgA, partnerB, orgB } = await seedFixture();

    // Partner A's context forging a link row onto partner B's org.
    const cause = await captureCause(() =>
      withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
        db.insert(organizationExternalLinks).values({
          orgId: orgB.id,
          partnerId: partnerB.id,
          system: 'datto_rmm',
          externalId: 'forged',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/row-level security/);
  });

  runDb('hides another partner’s link rows from SELECT (org isolation)', async () => {
    const { partnerA, orgA, partnerB, orgB } = await seedFixture();

    await withSystemDbAccessContext(() =>
      db.insert(organizationExternalLinks).values({
        orgId: orgB.id,
        partnerId: partnerB.id,
        system: 'ninjaone',
        externalId: 'hidden-1',
      })
    );

    // Visible under system scope (non-vacuity of the seed)…
    const systemProbe = await withSystemDbAccessContext(() =>
      db.select({ id: organizationExternalLinks.id })
        .from(organizationExternalLinks)
        .where(eq(organizationExternalLinks.orgId, orgB.id))
    );
    expect(systemProbe.length).toBeGreaterThan(0);

    // …but invisible to partner A.
    const rows = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
      db.select({ id: organizationExternalLinks.id })
        .from(organizationExternalLinks)
        .where(eq(organizationExternalLinks.orgId, orgB.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('composite FK rejects a link row whose partner_id disagrees with the org (even as system)', async () => {
    const { orgA, partnerB } = await seedFixture();

    // System scope bypasses RLS, so the FK is the only guard being tested.
    const cause = await captureCause(() =>
      withSystemDbAccessContext(() =>
        db.insert(organizationExternalLinks).values({
          orgId: orgA.id,          // belongs to partner A
          partnerId: partnerB.id,  // drifted partner
          system: 'csv',
          externalId: 'drift-1',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('23503'); // foreign_key_violation
  });

  runDb('unique index scopes (system, external_id) per partner — both partners can hold the same vendor UID', async () => {
    const { partnerA, orgA, partnerB, orgB } = await seedFixture();

    await withSystemDbAccessContext(async () => {
      await db.insert(organizationExternalLinks).values({
        orgId: orgA.id, partnerId: partnerA.id, system: 'datto_rmm', externalId: '12345',
      });
      await db.insert(organizationExternalLinks).values({
        orgId: orgB.id, partnerId: partnerB.id, system: 'datto_rmm', externalId: '12345',
      });
    });

    // Same partner + system + external id must be refused.
    const cause = await captureCause(() =>
      withSystemDbAccessContext(() =>
        db.insert(organizationExternalLinks).values({
          orgId: orgA.id, partnerId: partnerA.id, system: 'datto_rmm', externalId: '12345',
        })
      )
    );
    expect(cause?.code).toBe('23505'); // unique_violation
  });
});

describe('organization_external_links migration backfill (replay = no-op)', () => {
  runDb('backfills legacy accounting_* columns exactly once and is idempotent on replay', async () => {
    const { partnerA } = await seedFixture();

    // An org linked the pre-link-table way (QuickBooks columns only).
    const legacyOrg = await withSystemDbAccessContext(async () => {
      const org = await createOrganization({ partnerId: partnerA.id });
      await db.update(organizations)
        .set({ accountingProvider: 'quickbooks', accountingExternalId: 'qb-backfill-1' })
        .where(eq(organizations.id, org!.id));
      return org!;
    });

    const countLinks = async () =>
      withSystemDbAccessContext(async () => {
        const rows = await db.select({ id: organizationExternalLinks.id })
          .from(organizationExternalLinks)
          .where(and(
            eq(organizationExternalLinks.orgId, legacyOrg.id),
            eq(organizationExternalLinks.system, 'quickbooks'),
            eq(organizationExternalLinks.externalId, 'qb-backfill-1'),
          ));
        return rows.length;
      });

    // Replay the shipped migration (idempotent by construction): the backfill
    // must create the link row for the legacy-linked org…
    await getTestDb().execute(sql.raw(migrationText()));
    expect(await countLinks()).toBe(1);

    // …and replaying again must not duplicate it.
    await getTestDb().execute(sql.raw(migrationText()));
    expect(await countLinks()).toBe(1);
  });
});
