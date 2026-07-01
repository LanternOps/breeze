/**
 * alert_rules RLS — dual-axis (org OR partner) enforcement (#2128, epic #2135).
 *
 * Migration under test: 2026-07-01-alert-rules-partner-ownership.sql.
 *
 * An alert rule is owned by EITHER an org (org_id set, partner_id NULL) OR a
 * partner (partner_id set, org_id NULL — partner-wide, targetType 'all' with
 * targetId = partner id). Fired alerts always carry the DEVICE's org — the
 * `alerts` table stays org-only. Same dual-axis contract-test blindspot as the
 * sibling suites: this functional test through the REAL postgres.js driver
 * (breeze_app role) is the guard that a partner cannot forge a partner_id for
 * another partner.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { alertRules, alertTemplates } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const createdRules: string[] = [];
const createdTemplates: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (createdRules.length === 0 && createdTemplates.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdRules) {
      await db.delete(alertRules).where(eq(alertRules.id, id));
    }
    for (const id of createdTemplates) {
      await db.delete(alertTemplates).where(eq(alertTemplates.id, id));
    }
  });
  createdRules.length = 0;
  createdTemplates.length = 0;
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

/** Partner-owned template (alert_templates is already dual-ownership). */
async function seedPartnerTemplate(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(alertTemplates)
      .values({
        orgId: null,
        partnerId,
        name: 'Partner-wide CPU template',
        conditions: { type: 'metric', metric: 'cpu', operator: '>', threshold: 95 },
        severity: 'high',
        titleTemplate: 'High CPU on {{hostname}}',
        messageTemplate: 'CPU exceeded threshold on {{hostname}}',
      })
      .returning(),
  );
  const id = rows[0]!.id;
  createdTemplates.push(id);
  return id;
}

async function seedPartnerRule(partnerId: string, templateId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(alertRules)
      .values({
        orgId: null,
        partnerId,
        templateId,
        name: 'Partner-wide CPU rule',
        targetType: 'all',
        targetId: partnerId, // NOT NULL anchor; the 'all' match ignores it
      })
      .returning(),
  );
  const id = rows[0]!.id;
  createdRules.push(id);
  return id;
}

describe('alert_rules RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide rule (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();
    const templateId = await seedPartnerTemplate(partner.id);

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(alertRules)
        .values({
          orgId: null,
          partnerId: partner.id,
          templateId,
          name: 'All-orgs rule',
          targetType: 'all',
          targetId: partner.id,
        })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) createdRules.push(rows[0].id);
  });

  it('a different partner can neither see nor forge a rule attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const templateId = await seedPartnerTemplate(partnerA.id);
    const ruleId = await seedPartnerRule(partnerA.id, templateId);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, ruleId)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the cross-partner forge (Postgres 42501 on the cause).
    // The template is RLS-invisible to partner B too, but the row-security
    // check fires before the FK lookup, so 42501 is still the signal.
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(alertRules)
          .values({
            orgId: null,
            partnerId: partnerA.id,
            templateId,
            name: 'Forged rule',
            targetType: 'all',
            targetId: partnerA.id,
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide rule owned by its partner (evaluation still covers its devices via the worker)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const templateId = await seedPartnerTemplate(partner.id);
    const ruleId = await seedPartnerRule(partner.id, templateId);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, ruleId)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('org scope can still INSERT and SELECT an org-scoped rule (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const templateId = await seedPartnerTemplate(partner.id);

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(alertRules)
        .values({
          orgId: org.id,
          partnerId: null,
          templateId, // partner-shared template readable? RLS on templates allows org read of built-in/org rows only — use system-seeded org template instead if this fails
          name: 'Org rule',
          targetType: 'org',
          targetId: org.id,
        })
        .returning(),
    );
    if (inserted[0]) createdRules.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('the one-owner CHECK rejects a rule that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const templateId = await seedPartnerTemplate(partner.id);

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(alertRules)
          .values({
            orgId: org.id,
            partnerId: partner.id,
            templateId,
            name: 'Both axes',
            targetType: 'all',
            targetId: org.id,
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(alertRules)
          .values({
            orgId: null,
            partnerId: null,
            templateId,
            name: 'No axis',
            targetType: 'all',
            targetId: partner.id,
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner scope can UPDATE and DELETE its own partner-wide rule', async () => {
    const partner = await createPartner();
    const templateId = await seedPartnerTemplate(partner.id);
    const ruleId = await seedPartnerRule(partner.id, templateId);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(alertRules)
        .set({ name: 'Renamed rule', isActive: false })
        .where(eq(alertRules.id, ruleId))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.isActive).toBe(false);

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.delete(alertRules).where(eq(alertRules.id, ruleId)).returning(),
    );
    expect(deleted).toHaveLength(1);
    createdRules.splice(createdRules.indexOf(ruleId), 1);
  });
});
