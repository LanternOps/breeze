/**
 * client_ai_prompt_templates RLS — dual-axis (org OR partner) enforcement.
 *
 * Migration under test: 2026-06-12-b-client-ai-foundation.sql (§5).
 *
 * Partner-wide template rows carry org_id NULL + partner_id set — exactly the
 * custom_field_definitions failure mode (fixed 2026-06-11-i), where org-only
 * Shape-1 policies made every partner-wide row structurally uncreatable
 * (breeze_has_org_access(NULL) = FALSE → 42501 on INSERT). The rls-coverage
 * contract test does NOT catch a missing second axis, so this functional test
 * through the REAL postgres.js driver (breeze_app role) is the required guard
 * (spec §10).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(clientAiPromptTemplates).where(eq(clientAiPromptTemplates.id, id));
      }
    },
  );
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

async function seedPartnerTemplate(partnerId: string, track = true): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(clientAiPromptTemplates)
      .values({
        orgId: null,
        partnerId,
        name: 'Seed template',
        promptBody: 'Summarize the selected range.',
        category: 'finance',
      })
      .returning(),
  );
  const id = rows[0]!.id;
  if (track) created.push(id);
  return id;
}

describe('client_ai_prompt_templates RLS — dual-axis (2026-06-12-b migration)', () => {
  it('partner scope can INSERT a partner-wide template (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(clientAiPromptTemplates)
        .values({
          orgId: null,
          partnerId: partner.id,
          name: 'Quarterly variance walkthrough',
          promptBody: 'Explain the variance between the selected columns.',
        })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) created.push(rows[0].id);
  });

  it('partner scope can SELECT back its own partner-wide template', async () => {
    const partner = await createPartner();
    const id = await seedPartnerTemplate(partner.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: clientAiPromptTemplates.id })
        .from(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.partnerId, partner.id)),
    );

    expect(visible.map((r) => r.id)).toContain(id);
  });

  it('a different partner can neither see nor forge a template attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerTemplate(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: clientAiPromptTemplates.id })
        .from(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the forge. Drizzle wraps the driver error, so the RLS
    // signal is Postgres code 42501 on the cause (custom-fields-rls precedent).
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(clientAiPromptTemplates)
          .values({ orgId: null, partnerId: partnerA.id, name: 'Forged', promptBody: 'x' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can INSERT and SELECT an org-scoped template', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(clientAiPromptTemplates)
        .values({ orgId: org.id, partnerId: null, name: 'Org template', promptBody: 'y' })
        .returning(),
    );
    if (inserted[0]) created.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: clientAiPromptTemplates.id })
        .from(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('partner scope can UPDATE and DELETE its own partner-wide template', async () => {
    const partner = await createPartner();
    const id = await seedPartnerTemplate(partner.id, false);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(clientAiPromptTemplates)
        .set({ name: 'Renamed' })
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Renamed');

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .delete(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(deleted).toHaveLength(1);
  });

  it('a different partner UPDATE/DELETE silently match zero rows', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerTemplate(partnerA.id);

    const updatedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .update(clientAiPromptTemplates)
        .set({ name: 'Hijacked' })
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(updatedByB).toEqual([]);

    const deletedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .delete(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(deletedByB).toEqual([]);
  });

  it('stays fail-closed without a DB access context (scope "none")', async () => {
    const partner = await createPartner();
    const id = await seedPartnerTemplate(partner.id);

    const rows = await db
      .select({ id: clientAiPromptTemplates.id })
      .from(clientAiPromptTemplates)
      .where(eq(clientAiPromptTemplates.id, id));

    expect(rows).toEqual([]);
  });
});
