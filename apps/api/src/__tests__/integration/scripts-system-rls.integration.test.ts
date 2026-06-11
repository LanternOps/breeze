/**
 * Integration test for Discussion #633 — scripts.is_system RLS hole.
 *
 * The original SELECT policy on `scripts` was:
 *   USING (breeze_has_org_access(org_id))
 * System scripts are stored with is_system=true, org_id=NULL.
 * breeze_has_org_access(NULL) returns FALSE for every non-system scope
 * (function body in 0001-baseline.sql). So system scripts were invisible
 * to partner-scope and org-scope readers — they could only be SELECTed
 * under system DB context.
 *
 * The migration `2026-05-15-scripts-is-system-rls-select.sql` replaces
 * the SELECT policy with:
 *   USING (is_system = true OR breeze_has_org_access(org_id))
 *
 * INSERT/UPDATE/DELETE policies are unchanged. System-row writes still
 * require system DB context.
 *
 * These tests run as the unprivileged `breeze_app` role so RLS is
 * actually enforced. They prove:
 *
 *   1. After the migration, a partner-scope reader sees an is_system row.
 *      (Without the migration, this read returns 0 rows — the bug.)
 *   2. After the migration, an org-scope reader sees the same is_system row.
 *   3. Partner-scope INSERT of {is_system: true, org_id: null} is still
 *      rejected by RLS — locks that the migration didn't relax writes.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { scripts } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';

describe('scripts.is_system RLS — Discussion #633', () => {
  it('partner-scope reader sees an is_system=true script (org_id=NULL)', async () => {
    const partner = await createPartner();
    const name = `sys-script-partner-${Date.now()}`;

    // Insert the system row under system DB context (existing pattern).
    await withSystemDbAccessContext(async () => {
      await db.insert(scripts).values({
        orgId: null,
        name,
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Write-Host "noop"',
        isSystem: true
      });
    });

    // Read under partner scope as breeze_app — pre-fix this returned 0 rows.
    const rows = await withDbAccessContext(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: null,
        accessiblePartnerIds: [partner.id]
      },
      async () => db.select().from(scripts).where(eq(scripts.name, name))
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.isSystem).toBe(true);
    expect(row.orgId).toBeNull();
  });

  it('org-scope reader sees an is_system=true script (org_id=NULL)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const name = `sys-script-org-${Date.now()}`;

    await withSystemDbAccessContext(async () => {
      await db.insert(scripts).values({
        orgId: null,
        name,
        osTypes: ['linux'],
        language: 'bash',
        content: 'echo noop',
        isSystem: true
      });
    });

    const rows = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: org.id,
        accessibleOrgIds: [org.id]
      },
      async () => db.select().from(scripts).where(eq(scripts.name, name))
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.isSystem).toBe(true);
  });

  it('partner-scope INSERT of {is_system:true, org_id:null} is still rejected by RLS', async () => {
    const partner = await createPartner();
    const attemptedName = `sys-insert-attempt-${Date.now()}`;

    let caught: unknown;
    try {
      await withDbAccessContext(
        {
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: null,
          accessiblePartnerIds: [partner.id]
        },
        async () => {
          await db.insert(scripts).values({
            orgId: null,
            name: attemptedName,
            osTypes: ['windows'],
            language: 'powershell',
            content: 'Write-Host "noop"',
            isSystem: true
          });
        }
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "scripts"/
    );

    // And confirm via superuser read that no row landed.
    const rows = await getTestDb()
      .select()
      .from(scripts)
      .where(eq(scripts.name, attemptedName));
    expect(rows).toHaveLength(0);
  });
});
