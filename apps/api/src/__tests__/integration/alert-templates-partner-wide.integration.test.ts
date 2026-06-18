/**
 * Integration test for #1425 — partner-wide alert templates.
 *
 * #1357 gave alert_templates a partner_id axis + dual-axis RLS:
 *   SELECT  USING (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id) OR is_built_in)
 *   INSERT  WITH CHECK (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id))
 * A partner-wide template is org_id NULL + partner_id set. This proves the
 * route's new partner-wide create path produces rows the RLS actually accepts,
 * that they stay isolated to the owning partner, and that an org-scope caller
 * cannot forge one — the dual-axis breeze_app checks a mocked-db unit test
 * can't cover (the custom_field_definitions / #633 class of bug).
 *
 * Runs as the unprivileged breeze_app role so RLS is enforced.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { alertTemplates } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';

const baseValues = (name: string) => ({
  name,
  conditions: { metric: 'cpu', operator: '>', threshold: 90 },
  severity: 'high' as const,
  titleTemplate: '{{deviceName}}: ' + name,
  messageTemplate: 'Alert: ' + name,
  isBuiltIn: false,
});

describe('alert_templates partner-wide RLS — #1425', () => {
  it('partner scope can INSERT and read back a partner-wide template (org_id NULL)', async () => {
    const partner = await createPartner();
    const name = `pw-template-${Date.now()}`;

    const rows = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [partner.id] },
      async () => {
        await db.insert(alertTemplates).values({ orgId: null, partnerId: partner.id, ...baseValues(name) });
        return db.select().from(alertTemplates).where(eq(alertTemplates.name, name));
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBeNull();
    expect(rows[0]!.partnerId).toBe(partner.id);
  });

  it('a different partner cannot see another partner’s partner-wide template', async () => {
    const owner = await createPartner();
    const other = await createPartner();
    const name = `pw-isolated-${Date.now()}`;

    await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [owner.id] },
      async () => { await db.insert(alertTemplates).values({ orgId: null, partnerId: owner.id, ...baseValues(name) }); },
    );

    const seen = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [other.id] },
      async () => db.select().from(alertTemplates).where(eq(alertTemplates.name, name)),
    );
    expect(seen).toHaveLength(0);

    // Superuser confirms the row really exists — the empty read above is RLS,
    // not a failed insert.
    const truth = await getTestDb().select().from(alertTemplates).where(eq(alertTemplates.name, name));
    expect(truth).toHaveLength(1);
  });

  it('org scope cannot forge a partner-wide template (RLS rejects the INSERT)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const name = `pw-forge-${Date.now()}`;

    let caught: unknown;
    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => {
          await db.insert(alertTemplates).values({ orgId: null, partnerId: partner.id, ...baseValues(name) });
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(/new row violates row-level security policy for table "alert_templates"/);

    const truth = await getTestDb().select().from(alertTemplates).where(eq(alertTemplates.name, name));
    expect(truth).toHaveLength(0);
  });
});
