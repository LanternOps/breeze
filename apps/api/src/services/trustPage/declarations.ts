// Owner: W02b (declared controls). Declare / re-declare / withdraw a declared control (spec §14 W2, §18.2,
// amendment 27). Every write runs inside withTrustPageRevision (amendment 34): the page row is locked, a stale
// expectedRevision is a 409, and publication_revision is bumped in the same transaction. That lock also
// serializes two concurrent declarations of the same control, so the active-row partial unique index never
// sees a race. Runs in the CALLER's db context (route: the requester's RLS context).
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { TRUST_DECLARATION_TTL_DAYS, type DeclaredControlId } from '@breeze/shared';
import { db } from '../../db';
import { orgDocuments, trustPageDeclarations } from '../../db/schema';
import type { TrustPageDeclarationRow, TrustPageRow } from '../../db/schema/trustPages';
import { TrustPageError } from './publication';
import { withTrustPageRevision } from './revision';

const DAY_MS = 86_400_000;
/** Exactly TRUST_DECLARATION_TTL_DAYS × 24 h. Matches trust_page_declarations_expiry_chk (`+ interval '8760 hours'`). */
export const TRUST_DECLARATION_TTL_MS = TRUST_DECLARATION_TTL_DAYS * DAY_MS;
export const TRUST_DECLARATION_HISTORY_LIMIT = 50;

export const EVIDENCE_UNAVAILABLE_MESSAGE = 'That evidence document is no longer available. Choose a current document from the library.';

const isActive = and(isNull(trustPageDeclarations.supersededAt), isNull(trustPageDeclarations.withdrawnAt));

export async function declareTrustControl(a: {
  page: TrustPageRow; controlId: DeclaredControlId; statement: string; evidenceDocumentId: string | null;
  actorUserId: string; partnerName: string; expectedRevision: number; now?: Date;
}): Promise<{ declaration: TrustPageDeclarationRow; superseded: string | null; publicationRevision: number }> {
  // One `now` for declared_at, expires_at and the supersede stamp. declared_at is written explicitly: the
  // expiry CHECK compares the two columns exactly, so a DEFAULT now() beside a JS expires_at would fail (23514).
  const declaredAt = a.now ?? new Date();
  const expiresAt = new Date(declaredAt.getTime() + TRUST_DECLARATION_TTL_MS);

  const { result, publicationRevision } = await withTrustPageRevision(
    { pageId: a.page.id, expectedRevision: a.expectedRevision, actorUserId: a.actorUserId },
    async (tx) => {
      let evidenceDocumentSha256: string | null = null;
      if (a.evidenceDocumentId) {
        // Same liveness rule as the trust page's document links: this org, not deleted, not superseded.
        const successor = alias(orgDocuments, 'successor');
        const [doc] = await tx.select({ id: orgDocuments.id, sha256: orgDocuments.sha256 }).from(orgDocuments)
          .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
          .where(and(eq(orgDocuments.id, a.evidenceDocumentId), eq(orgDocuments.orgId, a.page.orgId), isNull(orgDocuments.deletedAt), isNull(successor.id)))
          .limit(1);
        if (!doc) throw new TrustPageError(EVIDENCE_UNAVAILABLE_MESSAGE, 422, 'EVIDENCE_UNAVAILABLE');
        evidenceDocumentSha256 = doc.sha256;
      }

      const [previous] = await tx.select({ id: trustPageDeclarations.id }).from(trustPageDeclarations)
        .where(and(eq(trustPageDeclarations.trustPageId, a.page.id), eq(trustPageDeclarations.controlId, a.controlId), isActive))
        .limit(1).for('update');
      if (previous) {
        // Stamp the old row FIRST so the one-active-per-control partial unique index holds for the insert.
        const stamped = await tx.update(trustPageDeclarations).set({ supersededAt: declaredAt })
          .where(and(eq(trustPageDeclarations.id, previous.id), isActive)).returning({ id: trustPageDeclarations.id });
        if (stamped.length === 0) {
          throw new TrustPageError('This declaration changed since you loaded it. Reload and try again.', 409, 'REVISION_MISMATCH');
        }
      }

      const [declaration] = await tx.insert(trustPageDeclarations).values({
        trustPageId: a.page.id, orgId: a.page.orgId, controlId: a.controlId, statement: a.statement,
        evidenceDocumentId: a.evidenceDocumentId, evidenceDocumentSha256,
        declaredByPartnerName: a.partnerName, declaredByUserId: a.actorUserId, declaredAt, expiresAt,
      }).returning();
      if (!declaration) throw new Error('trust_page_declarations insert returned no row');
      return { declaration, superseded: previous?.id ?? null };
    },
  );
  return { ...result, publicationRevision };
}

/**
 * Withdraws the ACTIVE declaration `declarationId` (404 when it is unknown, already withdrawn or superseded).
 * Its superseded predecessors for the same control are withdrawn with it: a page published before a
 * re-declaration still freezes the predecessor's id, and the refresh drops only withdrawn rows — without this,
 * withdrawing after a re-declare would leave the older statement on the public page until a republish.
 */
export async function withdrawTrustDeclaration(a: {
  page: TrustPageRow; declarationId: string; actorUserId: string; expectedRevision: number; now?: Date;
}): Promise<{ publicationRevision: number; controlId: string; withdrawnPredecessorIds: string[] }> {
  const withdrawnAt = a.now ?? new Date();
  const { result, publicationRevision } = await withTrustPageRevision(
    { pageId: a.page.id, expectedRevision: a.expectedRevision, actorUserId: a.actorUserId },
    async (tx) => {
      const [row] = await tx.update(trustPageDeclarations).set({ withdrawnAt, withdrawnByUserId: a.actorUserId })
        .where(and(eq(trustPageDeclarations.id, a.declarationId), eq(trustPageDeclarations.trustPageId, a.page.id), isActive))
        .returning({ id: trustPageDeclarations.id, controlId: trustPageDeclarations.controlId });
      // Throwing inside the callback rolls the revision bump back with it.
      if (!row) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
      const predecessors = await tx.update(trustPageDeclarations).set({ withdrawnAt, withdrawnByUserId: a.actorUserId })
        .where(and(
          eq(trustPageDeclarations.trustPageId, a.page.id), eq(trustPageDeclarations.controlId, row.controlId),
          isNotNull(trustPageDeclarations.supersededAt), isNull(trustPageDeclarations.withdrawnAt),
        ))
        .returning({ id: trustPageDeclarations.id });
      return { controlId: row.controlId, withdrawnPredecessorIds: predecessors.map((p) => p.id) };
    },
  );
  return { publicationRevision, ...result };
}

/** Active rows (neither superseded nor withdrawn; expired ones included) and the latest 50 others, newest first. */
export async function listTrustDeclarations(page: TrustPageRow): Promise<{ active: TrustPageDeclarationRow[]; history: TrustPageDeclarationRow[] }> {
  // Two reads: the partial unique index bounds active rows to one per control, while history is unbounded, so
  // a single LIMITed query could drop an old active row behind many newer re-declarations of another control.
  const [active, history] = await Promise.all([
    db.select().from(trustPageDeclarations)
      .where(and(eq(trustPageDeclarations.trustPageId, page.id), isActive))
      .orderBy(desc(trustPageDeclarations.declaredAt)),
    db.select().from(trustPageDeclarations)
      .where(and(eq(trustPageDeclarations.trustPageId, page.id), or(isNotNull(trustPageDeclarations.supersededAt), isNotNull(trustPageDeclarations.withdrawnAt))))
      .orderBy(desc(trustPageDeclarations.declaredAt))
      .limit(TRUST_DECLARATION_HISTORY_LIMIT),
  ]);
  return { active, history };
}
