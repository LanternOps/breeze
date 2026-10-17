// apps/api/src/__tests__/integration/trustPageTemplatesPartnerRls.integration.test.ts
// Trust Center W2 sub-wave W02g (#8770): the partner-wide trust page template is shape 3
// (partner_id NOT NULL UNIQUE, flat breeze_has_partner_access). These are the functional
// forge proofs behind its PARTNER_TENANT_TABLES entry in rls-coverage.integration.test.ts.
import './setup';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { sql } from 'drizzle-orm';
import { cascadeDeletePartner } from '../../services/tenantCascade';

const partnerA = randomUUID();
const partnerB = randomUUID();

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

async function seedPartner(id: string, name: string) {
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO partners (id, name, slug, currency_code)
    VALUES (${id}, ${name}, ${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}, 'USD')
    ON CONFLICT (id) DO NOTHING
  `));
}

describe('trust_page_templates partner-axis RLS', () => {
  // The shared setup truncates partners before every test.
  beforeEach(async () => {
    await seedPartner(partnerA, `tpt-rls-a-${partnerA.slice(0, 8)}`);
    await seedPartner(partnerB, `tpt-rls-b-${partnerB.slice(0, 8)}`);
  });

  afterAll(async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM trust_page_templates WHERE partner_id IN (${partnerA}, ${partnerB})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM users WHERE partner_id IN (${partnerA}, ${partnerB})
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})
    `));
  });

  it('ENABLE and FORCE row level security are both on', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'trust_page_templates'
    `))) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('a partner-scoped context can insert and read its OWN template', async () => {
    const id = randomUUID();
    await withDbAccessContext(partnerContext(partnerA), () =>
      db.execute(sql`INSERT INTO trust_page_templates (id, partner_id, show_managed_by) VALUES (${id}, ${partnerA}, false)`),
    );
    const rows = (await withDbAccessContext(partnerContext(partnerA), () =>
      db.execute(sql`SELECT id, revision FROM trust_page_templates WHERE id = ${id}`),
    )) as unknown as Array<{ id: string; revision: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe(0);
  });

  it('FORGE: partner B cannot insert a template attributed to partner A (42501)', async () => {
    await expect(
      withDbAccessContext(partnerContext(partnerB), () =>
        db.execute(sql`INSERT INTO trust_page_templates (id, partner_id) VALUES (${randomUUID()}, ${partnerA})`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('FORGE: partner B cannot READ partner A\'s template (zero rows, not an error)', async () => {
    const id = randomUUID();
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO trust_page_templates (id, partner_id) VALUES (${id}, ${partnerA})`),
    );
    // CONTROL: the row exists — without it an empty result below would also pass on a failed insert.
    const control = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT id FROM trust_page_templates WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(control).toHaveLength(1);

    const rows = (await withDbAccessContext(partnerContext(partnerB), () =>
      db.execute(sql`SELECT id FROM trust_page_templates WHERE id = ${id}`),
    )) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('FORGE: partner B cannot UPDATE partner A\'s template (zero rows touched)', async () => {
    const id = randomUUID();
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO trust_page_templates (id, partner_id, show_managed_by) VALUES (${id}, ${partnerA}, true)`),
    );
    await withDbAccessContext(partnerContext(partnerB), () =>
      db.execute(sql`UPDATE trust_page_templates SET show_managed_by = false, revision = revision + 1 WHERE id = ${id}`),
    );
    const rows = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT show_managed_by, revision FROM trust_page_templates WHERE id = ${id}`),
    )) as unknown as Array<{ show_managed_by: boolean; revision: number }>;
    expect(rows[0]).toEqual({ show_managed_by: true, revision: 0 });
  });

  it('an ORG-scoped context reads ZERO templates, even for its own partner', async () => {
    const id = randomUUID();
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO trust_page_templates (id, partner_id) VALUES (${id}, ${partnerA})`),
    );
    const orgRows = (await withDbAccessContext({
      scope: 'organization',
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [],
      // An org token carries a partnerId; it still must not pass breeze_has_partner_access.
      currentPartnerId: partnerA,
      userId: null,
    } as DbAccessContext, () =>
      db.execute(sql`SELECT id FROM trust_page_templates WHERE partner_id = ${partnerA}`),
    )) as unknown as Array<{ id: string }>;
    expect(orgRows).toHaveLength(0);
  });

  it('one template per partner (partner_id UNIQUE, 23505)', async () => {
    await withSystemDbAccessContext(() =>
      db.execute(sql`INSERT INTO trust_page_templates (id, partner_id) VALUES (${randomUUID()}, ${partnerA})`),
    );
    await expect(
      withSystemDbAccessContext(() =>
        db.execute(sql`INSERT INTO trust_page_templates (id, partner_id) VALUES (${randomUUID()}, ${partnerA})`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('intro_html is bounded at 40000 characters (23514)', async () => {
    await expect(
      withSystemDbAccessContext(() =>
        db.execute(sql`INSERT INTO trust_page_templates (id, partner_id, intro_html) VALUES (${randomUUID()}, ${partnerA}, ${'x'.repeat(40001)})`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  // PARTNER ERASURE: no static registration exists for a shape-3 table — cascadeDeletePartner reaches it by its
  // partner_id column (information_schema sweep). The template references a partner user (updated_by_user_id,
  // ON DELETE SET NULL), so the sweep's order relative to users is exercised here too.
  it('cascadeDeletePartner erases the partner\'s template and leaves the other partner\'s alone', async () => {
    const user = randomUUID();
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO users (id, partner_id, email, name)
      VALUES (${user}, ${partnerA}, ${`tpt-erasure-${user}@example.test`}, 'Template erasure user')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO trust_page_templates (id, partner_id, updated_by_user_id, intro_html) VALUES (${randomUUID()}, ${partnerA}, ${user}, '<p>A</p>')
    `));
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO trust_page_templates (id, partner_id) VALUES (${randomUUID()}, ${partnerB})
    `));
    const before = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT count(*)::int AS n FROM trust_page_templates WHERE partner_id = ${partnerA}
    `))) as unknown as Array<{ n: number }>;
    expect(before[0]?.n).toBe(1);

    await expect(cascadeDeletePartner(partnerA, randomUUID())).resolves.toBeDefined();

    const after = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM trust_page_templates WHERE partner_id = ${partnerA}) AS a,
        (SELECT count(*)::int FROM trust_page_templates WHERE partner_id = ${partnerB}) AS b,
        (SELECT count(*)::int FROM partners WHERE id = ${partnerA}) AS partner_a
    `))) as unknown as Array<{ a: number; b: number; partner_a: number }>;
    expect(after[0]).toEqual({ a: 0, b: 1, partner_a: 0 });
  });
});
