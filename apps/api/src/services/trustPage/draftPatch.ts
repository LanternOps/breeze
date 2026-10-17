// Trust Center W3d (#8771): the draft subset a customer org admin may edit from
// the portal (plan Open Decision 2). Five fields only — no intro HTML, no
// documents, no partner-home flag, no embed allowlist, no publishing settings.
// Edits change the DRAFT; the public page changes only on the MSP's next
// publish (Ruling 20). Every write bumps publication_revision under a row lock,
// so an MSP publish that loaded the older revision 409s (REVISION_MISMATCH)
// instead of freezing a draft the MSP never saw (W3 Review Focus 3).
//
// Field handling mirrors the staff PUT /orgs/:orgId/trust-page
// (routes/trustPage.ts); switching that route onto this helper is a W03
// follow-up (it is W03a's file).
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { TELEMETRY_CONTROL_IDS, telemetryControlIdSchema, trustPageUpdateSchema } from '@breeze/shared';
import { db } from '../../db';
import { trustPages, type TrustPageRow } from '../../db/schema';
import { TrustPageError } from './publication';
import { REVISION_MISMATCH_MESSAGE } from './revision';

const PORTAL_FIELDS = ['securityContactEmail', 'websiteUrl', 'hiddenControlIds', 'showPercentages', 'showDeviceCount'] as const;

export const trustPagePortalDraftPatchSchema = trustPageUpdateSchema
  // Same email (≤320) and https-only URL rules as the staff editor; null clears the value.
  .pick({ securityContactEmail: true, websiteUrl: true })
  .extend({
    hiddenControlIds: z.array(telemetryControlIdSchema).max(TELEMETRY_CONTROL_IDS.length).optional(),
    // Explicit values only: "inherit the partner template" stays an MSP decision.
    showPercentages: z.boolean().optional(),
    showDeviceCount: z.boolean().optional(),
    // Required from the portal: a customer edit never silently overwrites a newer draft.
    expectedRevision: z.number().int().min(0),
  })
  .strict()
  .refine((v) => PORTAL_FIELDS.some((k) => v[k] !== undefined), { message: 'No updates provided' });

export type TrustPagePortalDraftPatch = z.infer<typeof trustPagePortalDraftPatchSchema>;

/**
 * Applies the portal subset to the draft columns. `actor` is not written to the row: `updated_by_user_id`
 * references `users`, and a portal user is not one. The caller records the portal user in the audit entry.
 */
export async function applyTrustPageDraftPatch(
  pageId: string,
  patch: TrustPagePortalDraftPatch,
  _actor: { kind: 'portal_user'; id: string },
): Promise<TrustPageRow> {
  const body = trustPagePortalDraftPatchSchema.parse(patch);
  const set: Partial<typeof trustPages.$inferInsert> = {};
  for (const k of PORTAL_FIELDS) if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];

  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ rev: trustPages.publicationRevision, isPartnerHome: trustPages.isPartnerHome })
      .from(trustPages).where(eq(trustPages.id, pageId)).for('update');
    if (!locked) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
    // The partner home is the MSP's own page; a customer admin never edits it.
    if (locked.isPartnerHome) throw new TrustPageError('Only your provider can edit this page.', 403, 'PORTAL_TRUST_EDITOR_REQUIRED');
    if (locked.rev !== body.expectedRevision) throw new TrustPageError(REVISION_MISMATCH_MESSAGE, 409, 'REVISION_MISMATCH');
    const [row] = await tx.update(trustPages)
      .set({ ...set, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date() })
      .where(eq(trustPages.id, pageId))
      .returning();
    if (!row) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
    return row;
  });
}

/**
 * Customer withdrawal of consent from the portal: unpublish. Same effect as the staff
 * unpublish (W1 unpublishTrustPage), done here because that helper stamps updated_by_user_id
 * with a users.id and a portal user is not one (follow-up: let it take a portal actor).
 * Locks the row, refuses the partner home, clears published_at and bumps the revision so an
 * MSP publish holding the older revision 409s. An already-unpublished page is a no-op that
 * returns the locked (current) row. The caller refreshes the serving set after COMMIT.
 */
export async function withdrawTrustPageFromPortal(pageId: string): Promise<{ changed: boolean; row: TrustPageRow; partnerId: string }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(trustPages).where(eq(trustPages.id, pageId)).for('update');
    if (!locked) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
    if (locked.isPartnerHome) throw new TrustPageError('Only your provider can edit this page.', 403, 'PORTAL_TRUST_EDITOR_REQUIRED');
    if (!locked.publishedAt) return { changed: false, row: locked, partnerId: locked.partnerId };
    const [row] = await tx.update(trustPages)
      .set({ publishedAt: null, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date() })
      .where(eq(trustPages.id, pageId))
      .returning();
    if (!row) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
    return { changed: true, row, partnerId: row.partnerId };
  });
}
