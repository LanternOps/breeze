/**
 * End-to-end integration test for `cascadeDeletePartner` (synthetic canary
 * cleanup — see routes/internal/synthetic.ts).
 *
 * `cascadeDeletePartner` is the most destructive code in the synthetic control
 * plane: it hard-deletes a partner and ALL descendant tenant data. The unit
 * test (tenantCascade.partner.test.ts) mocks the DB and can only prove call
 * ordering — it cannot see real SQL, RLS, or FK behaviour. This test exercises
 * the real thing against Postgres as the forced-RLS `breeze_app` role and
 * proves the load-bearing properties:
 *
 *   1. Every row keyed on the purged partner is gone — across the partner-axis
 *      sweep (users, roles, partner_users) AND the per-org cascade (orgs, sites,
 *      alert_templates, org-scoped audit_logs).
 *   2. A SECOND partner's data is completely untouched (no cross-tenant leak).
 *   3. `totalRowsDeleted` reflects ACTUAL rows removed, so a silent zero-row
 *      no-op (e.g. a missing-RLS-context regression, #1375) would be visible
 *      rather than masquerading as success.
 *   4. The purge_started + purged audit rows are written with org_id = NULL so
 *      they survive the cascade.
 *   5. Idempotent: a re-run on an already-purged partner deletes zero rows and
 *      does not throw.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { cascadeDeletePartner } from '../../services/tenantCascade';

// Mirrors PERFORMED_BY in routes/internal/synthetic.ts — audit_logs.actor_id is
// a uuid column, so the synthetic actor is the nil-uuid sentinel.
const SENTINEL = '00000000-0000-0000-0000-000000000000';

interface PartnerSeed {
  partnerId: string;
  userId: string;
  roleId: string;
  orgId: string;
  siteId: string;
}

async function seedPartner(label: string): Promise<PartnerSeed> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES (${`Canary ${label}`}, ${`canary-${label}-${suffix}`}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const partnerId = partner!.id;

  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partnerId}, ${`signup-canary+${label}-${suffix}@2breeze.app`}, 'Canary User', 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const userId = user!.id;

  const [role] = (await testDb.execute(sql`
    INSERT INTO roles (partner_id, scope, name)
    VALUES (${partnerId}, 'partner', ${`Canary Role ${label}`})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const roleId = role!.id;

  // partner_users links user → role → partner. It is a partner-axis table that
  // FK-references roles, so the topological sweep MUST delete it before roles.
  await testDb.execute(sql`
    INSERT INTO partner_users (partner_id, user_id, role_id, org_access)
    VALUES (${partnerId}, ${userId}, ${roleId}, 'all')
  `);

  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, created_at, updated_at)
    VALUES (${partnerId}, ${`Org ${label}`}, ${`org-${label}-${suffix}`}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const orgId = org!.id;

  const [site] = (await testDb.execute(sql`
    INSERT INTO sites (org_id, name, created_at, updated_at)
    VALUES (${orgId}, ${`Site ${label}`}, now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const siteId = site!.id;

  await testDb.execute(sql`
    INSERT INTO alert_templates (org_id, name, conditions, severity, title_template, message_template)
    VALUES (${orgId}, ${`Template ${label}`}, '{}'::jsonb, 'info', 't', 'm')
  `);

  await testDb.execute(sql`
    INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
    VALUES (${orgId}, 'user', ${userId}, 'test.seed', 'test', 'success', now())
  `);

  return { partnerId, userId, roleId, orgId, siteId };
}

async function countById(table: string, column: string, id: string): Promise<number> {
  const rows = (await getTestDb().execute(
    sql`SELECT 1 FROM ${sql.raw(`"${table}"`)} WHERE ${sql.raw(`"${column}"`)} = ${id}`,
  )) as unknown as unknown[];
  return rows.length;
}

describe('cascadeDeletePartner — end-to-end', () => {
  let purge: PartnerSeed;
  let control: PartnerSeed;

  beforeEach(async () => {
    purge = await seedPartner('purge');
    control = await seedPartner('control');
  });

  it('removes every row keyed on the purged partner and leaves the control partner intact', async () => {
    const stats = await cascadeDeletePartner(purge.partnerId, SENTINEL);

    // Real rows were deleted — not a silent zero-row no-op.
    expect(stats.totalRowsDeleted).toBeGreaterThan(0);
    expect(stats.orgsDeleted).toBe(1);
    expect(stats.tablesDeleted.partners).toBe(1);

    // Purged partner: gone across both the partner-axis sweep and the org cascade.
    expect(await countById('partners', 'id', purge.partnerId)).toBe(0);
    expect(await countById('partner_users', 'partner_id', purge.partnerId)).toBe(0);
    expect(await countById('users', 'partner_id', purge.partnerId)).toBe(0);
    expect(await countById('roles', 'partner_id', purge.partnerId)).toBe(0);
    expect(await countById('organizations', 'partner_id', purge.partnerId)).toBe(0);
    expect(await countById('sites', 'id', purge.siteId)).toBe(0);
    expect(await countById('alert_templates', 'org_id', purge.orgId)).toBe(0);
    expect(await countById('audit_logs', 'org_id', purge.orgId)).toBe(0);

    // Control partner: every row untouched (no cross-tenant leak).
    expect(await countById('partners', 'id', control.partnerId)).toBe(1);
    expect(await countById('partner_users', 'partner_id', control.partnerId)).toBe(1);
    expect(await countById('users', 'partner_id', control.partnerId)).toBe(1);
    expect(await countById('roles', 'partner_id', control.partnerId)).toBe(1);
    expect(await countById('organizations', 'partner_id', control.partnerId)).toBe(1);
    expect(await countById('sites', 'id', control.siteId)).toBe(1);
    expect(await countById('alert_templates', 'org_id', control.orgId)).toBe(1);
    expect(await countById('audit_logs', 'org_id', control.orgId)).toBe(1);
  });

  it('writes purge_started and purged audit rows with org_id = NULL', async () => {
    await cascadeDeletePartner(purge.partnerId, SENTINEL);

    const rows = (await getTestDb().execute(sql`
      SELECT action, org_id, actor_id, result
      FROM audit_logs
      WHERE resource_id = ${purge.partnerId}
        AND action LIKE 'test.synthetic_partner.%'
      ORDER BY timestamp ASC
    `)) as unknown as Array<{ action: string; org_id: string | null; actor_id: string; result: string }>;

    const actions = rows.map((r) => r.action);
    expect(actions).toContain('test.synthetic_partner.purge_started');
    expect(actions).toContain('test.synthetic_partner.purged');
    for (const r of rows) {
      expect(r.org_id).toBeNull();
      expect(r.actor_id).toBe(SENTINEL);
    }
  });

  it('is idempotent — a re-run on an already-purged partner deletes zero rows', async () => {
    await cascadeDeletePartner(purge.partnerId, SENTINEL);
    const stats = await cascadeDeletePartner(purge.partnerId, SENTINEL);

    expect(stats.totalRowsDeleted).toBe(0);
    expect(stats.orgsDeleted).toBe(0);
    expect(stats.tablesDeleted.partners ?? 0).toBe(0);

    // Control still intact after both runs.
    expect(await countById('partners', 'id', control.partnerId)).toBe(1);
  });
});
