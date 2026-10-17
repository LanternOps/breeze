// Owner: W02b (declared controls). The declarations section of the trust page payload (amendment 27).
// Publish freezes the ids of the active, unexpired declarations (Ruling 20). Every build — publish, preview and
// the hourly refresh — re-reads those frozen rows, so a withdrawal drops out and an expiry flips to `expired`
// at the next refresh. A re-declaration (a new id) reaches the public page only through a republish
// (Open Decision 5), so a superseded frozen row keeps rendering until then.
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { DECLARED_CONTROL_IDS, declaredControlById, type DeclaredControlId, type TrustPagePublicPayload } from '@breeze/shared';
import { db } from '../../../db';
import { trustPageDeclarations } from '../../../db/schema';
import type { SectionBuildContext, SectionDraftContext } from './types';

const CATALOG_RANK = new Map<string, number>(DECLARED_CONTROL_IDS.map((id, i) => [id, i]));
const isDeclaredControlId = (id: string): id is DeclaredControlId => CATALOG_RANK.has(id);
const byCatalog = (a: { controlId: string }, b: { controlId: string }) => CATALOG_RANK.get(a.controlId)! - CATALOG_RANK.get(b.controlId)!;

/** The active (neither superseded nor withdrawn), unexpired declaration ids to freeze at publish, in catalog order. */
export async function freezeDeclarationIds(ctx: SectionDraftContext): Promise<string[]> {
  const rows = await db.select({ id: trustPageDeclarations.id, controlId: trustPageDeclarations.controlId, expiresAt: trustPageDeclarations.expiresAt })
    .from(trustPageDeclarations)
    .where(and(
      eq(trustPageDeclarations.trustPageId, ctx.page.id),
      isNull(trustPageDeclarations.supersededAt), isNull(trustPageDeclarations.withdrawnAt),
      gt(trustPageDeclarations.expiresAt, ctx.asOf),
    ));
  // The SQL already filters; re-checked here so the rule lives in one readable place.
  return rows
    .filter((r) => isDeclaredControlId(r.controlId) && r.expiresAt.getTime() > ctx.asOf.getTime())
    .sort(byCatalog)
    .map((r) => r.id);
}

/** Frozen declaration ids → public entries; withdrawn rows drop out, expired ones render `expired` (re-read at refresh). */
export async function buildDeclaredControls(ctx: SectionBuildContext): Promise<TrustPagePublicPayload['declaredControls']> {
  const ids = ctx.config.declarationIds;
  if (ids.length === 0) return [];
  // Scoped to this page: a frozen id can never pull another page's row. An id deleted since publish (org
  // cascade) simply does not come back.
  const rows = await db.select().from(trustPageDeclarations)
    .where(and(inArray(trustPageDeclarations.id, ids), eq(trustPageDeclarations.trustPageId, ctx.page.id)));
  const onPage = new Set(ctx.documents.map((d) => d.id));
  const out: TrustPagePublicPayload['declaredControls'] = [];
  for (const r of rows.filter((x) => x.withdrawnAt === null).sort(byCatalog)) {
    if (!isDeclaredControlId(r.controlId)) continue;
    const def = declaredControlById(r.controlId);
    if (!def) continue;
    out.push({
      id: def.id,
      category: def.category,
      source: 'declared',
      status: r.expiresAt.getTime() > ctx.asOf.getTime() ? 'current' : 'expired',
      statement: r.statement,
      declaredBy: r.declaredByPartnerName,
      declaredAt: r.declaredAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      // Only a document this page actually lists; never a link to something the page does not expose.
      evidenceDocumentId: r.evidenceDocumentId && onPage.has(r.evidenceDocumentId) ? r.evidenceDocumentId : null,
      frameworkRefs: def.frameworkRefs.map((f) => ({ framework: f.framework, ref: f.ref })),
    });
  }
  return out;
}
