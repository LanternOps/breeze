/**
 * client_ai_prompt_templates RLS — dual-axis (org OR partner) enforcement.
 *
 * Migration under test: 2026-06-12-b-client-ai-foundation.sql (§5).
 *
 * A template is either org-scoped (org_id set, partner_id NULL) or partner-wide
 * (partner_id set, org_id NULL) — enforced by the scope CHECK
 * (num_nonnulls(org_id, partner_id) = 1). The table carries an org_id column, so
 * the generic org-tenant auto-discovery in rls-coverage.integration.test.ts
 * already picks it up (its policy string contains breeze_has_org_access). That
 * contract check therefore CANNOT catch a missing/broken partner-axis branch —
 * exactly the dual-axis blindspot recorded in MEMORY
 * (rls_dual_axis_contract_test_blindspot) and called out in spec §10:
 * breeze_has_org_access(NULL) = FALSE, so the partner branch is load-bearing,
 * not decorative.
 *
 * These tests run through the REAL postgres.js driver (the db pool connects as
 * the unprivileged breeze_app role) inside withDbAccessContext, so they exercise
 * actual RLS enforcement on the partner axis — the only guard the migration
 * header (§5) promised. No Drizzle schema object exists for this table yet
 * (added in a later task), so all DML goes through raw sql`` via db.execute /
 * getTestDb().execute.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const created: string[] = [];

afterEach(async () => {
  // Clean up rows the tests leave behind. Under system scope both access
  // helpers short-circuit to TRUE, so one system-context pass deletes every
  // tracked row regardless of its original partner/org axis.
  if (created.length === 0) return;
  await withSystemDbAccessContext(async () => {
    for (const id of created) {
      await db.execute(sql`DELETE FROM client_ai_prompt_templates WHERE id = ${id}`);
    }
  });
  created.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

/** Insert a partner-wide template (org_id NULL) as that partner, returning its id. */
async function insertPartnerTemplate(
  ctx: DbAccessContext,
  partnerId: string,
  name: string,
): Promise<string | undefined> {
  const rows = (await withDbAccessContext(ctx, () =>
    db.execute(sql`
      INSERT INTO client_ai_prompt_templates (org_id, partner_id, name, prompt_body)
      VALUES (NULL, ${partnerId}, ${name}, 'body')
      RETURNING id, org_id, partner_id
    `),
  )) as unknown as Array<{ id: string; org_id: string | null; partner_id: string | null }>;
  return rows[0]?.id;
}

describe('client_ai_prompt_templates RLS — dual-axis (2026-06-12-b migration)', () => {
  it('(a) a same-partner partner-axis insert (org_id NULL, partner_id set) SUCCEEDS', async () => {
    const partner = await createPartner();

    const rows = (await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.execute(sql`
        INSERT INTO client_ai_prompt_templates (org_id, partner_id, name, prompt_body)
        VALUES (NULL, ${partner.id}, 'Summarize Email', 'Summarize the following email thread.')
        RETURNING id, org_id, partner_id
      `),
    )) as unknown as Array<{ id: string; org_id: string | null; partner_id: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.org_id).toBeNull();
    expect(rows[0]?.partner_id).toBe(partner.id);
    if (rows[0]) created.push(rows[0].id);
  });

  it('(b) a cross-partner insert FAILS with an RLS violation', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    // partnerB attempts to forge a row attributed to partnerA. WITH CHECK denies
    // it. Drizzle/postgres.js surfaces the RLS signal as Postgres code 42501
    // (insufficient_privilege) on the underlying cause.
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.execute(sql`
          INSERT INTO client_ai_prompt_templates (org_id, partner_id, name, prompt_body)
          VALUES (NULL, ${partnerA.id}, 'Forged', 'body')
        `),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('(c) a cross-org row is not visible via SELECT', async () => {
    // Two orgs under DIFFERENT partners so neither axis grants cross access.
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const insertedA = (await withDbAccessContext(orgContext(orgA.id), () =>
      db.execute(sql`
        INSERT INTO client_ai_prompt_templates (org_id, partner_id, name, prompt_body)
        VALUES (${orgA.id}, NULL, 'OrgA Template', 'body')
        RETURNING id, org_id
      `),
    )) as unknown as Array<{ id: string; org_id: string | null }>;
    const idA = insertedA[0]?.id;
    expect(idA).toBeDefined();
    if (idA) created.push(idA);
    expect(insertedA[0]?.org_id).toBe(orgA.id);

    // orgB (different partner) cannot see orgA's org-scoped template.
    const visibleToB = (await withDbAccessContext(orgContext(orgB.id), () =>
      db.execute(sql`
        SELECT id FROM client_ai_prompt_templates WHERE id = ${idA}
      `),
    )) as unknown as Array<{ id: string }>;
    expect(visibleToB).toEqual([]);

    // The owning org can still see it — confirms the row exists and the empty
    // result above is RLS hiding, not a missing insert.
    const visibleToA = (await withDbAccessContext(orgContext(orgA.id), () =>
      db.execute(sql`
        SELECT id FROM client_ai_prompt_templates WHERE id = ${idA}
      `),
    )) as unknown as Array<{ id: string }>;
    expect(visibleToA.map((r) => r.id)).toContain(idA);
  });

  it('a different partner cannot SELECT the first partner\'s partner-wide template', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const idA = await insertPartnerTemplate(partnerContext(partnerA.id, []), partnerA.id, 'PartnerA Template');
    expect(idA).toBeDefined();
    if (idA) created.push(idA);

    const visibleToB = (await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.execute(sql`SELECT id FROM client_ai_prompt_templates WHERE id = ${idA}`),
    )) as unknown as Array<{ id: string }>;
    expect(visibleToB).toEqual([]);
  });

  it('stays fail-closed without a DB access context (scope "none")', async () => {
    // With no withDbAccessContext, breeze.scope is unset
    // (breeze_current_scope() = 'none'), so both helpers return FALSE and a
    // partner-wide row must be invisible on the bare pool. Seed under system
    // scope so the insert itself succeeds.
    const partner = await createPartner();
    const seeded = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO client_ai_prompt_templates (org_id, partner_id, name, prompt_body)
        VALUES (NULL, ${partner.id}, 'Fail Closed', 'body')
        RETURNING id
      `),
    )) as unknown as Array<{ id: string }>;
    const id = seeded[0]?.id;
    expect(id).toBeDefined();
    if (id) created.push(id);

    // Verify via the superuser pool the row really landed (RLS-bypassing read).
    const realRows = (await getTestDb().execute(sql`
      SELECT id FROM client_ai_prompt_templates WHERE id = ${id}
    `)) as unknown as Array<{ id: string }>;
    expect(realRows).toHaveLength(1);

    // The bare breeze_app pool (no context) must NOT see it.
    const bare = (await db.execute(sql`
      SELECT id FROM client_ai_prompt_templates WHERE id = ${id}
    `)) as unknown as Array<{ id: string }>;
    expect(bare).toEqual([]);
  });
});
