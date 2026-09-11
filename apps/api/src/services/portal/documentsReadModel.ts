import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  PortalDocumentCategory,
  PortalDocumentDto,
  PortalDocumentGroupDto,
  PortalDocumentsDto,
} from '@breeze/shared';
import { db } from '../../db';
import { orgDocuments } from '../../db/schema';

/**
 * Customer-portal document library read model (spec #5573 §8).
 *
 * Deliberately NOT a call into `orgDocumentService.listDocuments` / `getDocument`:
 * those are the MSP surface — they return `uploadedByUserId` and do not filter on
 * `portal_visible`, which is right for a technician and wrong for a customer.
 * Keeping the query here puts `portal_visible = true AND deleted_at IS NULL` in
 * the SQL rather than in a caller's `.filter()`, and selects only customer-safe
 * columns. The BYTES are not duplicated: the content route delegates to W03's
 * `streamDocument`.
 *
 * Runs inside the portal session's org-scoped RLS transaction; the explicit
 * `org_id` predicate is defence in depth, never the only fence.
 */

/** Fixed presentation order so the page never reshuffles between loads. */
const CATEGORY_ORDER: readonly PortalDocumentCategory[] =
  ['baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other'];

export async function documentsForOrg(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<PortalDocumentsDto> {
  const rows = await db
    .select({
      id: orgDocuments.id,
      title: orgDocuments.title,
      description: orgDocuments.description,
      category: orgDocuments.category,
      contentType: orgDocuments.contentType,
      byteSize: orgDocuments.byteSize,
      originalFilename: orgDocuments.originalFilename,
      createdAt: orgDocuments.createdAt,
    })
    .from(orgDocuments)
    .where(and(
      // Predicate order and shape match W03's partial index
      // org_documents_org_portal_idx (org_id) WHERE portal_visible AND deleted_at IS NULL.
      eq(orgDocuments.orgId, orgId),
      eq(orgDocuments.portalVisible, true),
      isNull(orgDocuments.deletedAt),
      // Chain heads only: a replaced version stays downloadable through a
      // delivery record, but the library lists the current one.
      //
      // The successor must itself be portal-visible. Without that clause a
      // replacement uploaded as a draft (portal_visible = false) hides the
      // version the customer could still read, and shows nothing in its place
      // — the document silently disappears from the library.
      sql`NOT EXISTS (
        SELECT 1 FROM ${orgDocuments} AS successor
        WHERE successor.supersedes_document_id = ${orgDocuments.id}
          AND successor.org_id = ${orgId}
          AND successor.deleted_at IS NULL
          AND successor.portal_visible = true
      )`,
    ))
    .orderBy(asc(orgDocuments.category), desc(orgDocuments.createdAt)) as unknown as Array<{
      id: string; title: string; description: string | null; category: PortalDocumentCategory;
      contentType: string; byteSize: number; originalFilename: string; createdAt: Date;
    }>;

  const byCategory = new Map<PortalDocumentCategory, PortalDocumentDto[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push({
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      contentType: row.contentType,
      byteSize: row.byteSize,
      originalFilename: row.originalFilename,
      createdAt: row.createdAt.toISOString(),
    });
    byCategory.set(row.category, list);
  }

  const groups: PortalDocumentGroupDto[] = CATEGORY_ORDER
    .filter((category) => (byCategory.get(category)?.length ?? 0) > 0)
    .map((category) => ({ category, documents: byCategory.get(category)! }));

  return {
    asOf: args.now.toISOString(),
    timezone: args.timezone,
    groups,
  };
}

/** Metadata only — no `data`, no `storage_key`. Enough to answer a conditional
 *  request without opening the bytes; the bytes come from W03's streamDocument. */
export interface PortalDocumentHandle {
  id: string; contentType: string; byteSize: number;
  sha256: string; originalFilename: string;
}

/** The portal's own visibility predicate for one document. No chain-head
 *  condition: a delivery record points at the exact version it was delivered
 *  with (spec §4.4). `null` becomes a bare 404 at the route. */
export async function portalVisibleDocument(
  orgId: string,
  documentId: string,
): Promise<PortalDocumentHandle | null> {
  const [row] = await db
    .select({
      id: orgDocuments.id,
      contentType: orgDocuments.contentType,
      byteSize: orgDocuments.byteSize,
      sha256: orgDocuments.sha256,
      originalFilename: orgDocuments.originalFilename,
    })
    .from(orgDocuments)
    .where(and(
      eq(orgDocuments.orgId, orgId),
      eq(orgDocuments.id, documentId),
      eq(orgDocuments.portalVisible, true),
      isNull(orgDocuments.deletedAt),
    ))
    .limit(1) as unknown as PortalDocumentHandle[];

  return row ?? null;
}
