// W02a-owned. Revision discipline for every trust page write (amendment 34): lock the page row, refuse a stale
// expectedRevision, run the write, bump publication_revision — all in one transaction, so a publish racing the
// write 409s instead of freezing a half-edited draft.
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { trustPages } from '../../db/schema';
import { TrustPageError } from './publication';

export type TrustPageTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const REVISION_MISMATCH_MESSAGE = 'This page changed since you loaded it. Reload and try again.';

export async function withTrustPageRevision<T>(
  args: { pageId: string; expectedRevision: number | undefined; actorUserId: string },
  fn: (tx: TrustPageTx) => Promise<T>,
): Promise<{ result: T; publicationRevision: number }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ rev: trustPages.publicationRevision }).from(trustPages)
      .where(eq(trustPages.id, args.pageId)).for('update');
    if (!locked) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
    if (args.expectedRevision !== undefined && locked.rev !== args.expectedRevision) {
      throw new TrustPageError(REVISION_MISMATCH_MESSAGE, 409, 'REVISION_MISMATCH');
    }
    const result = await fn(tx);
    const [bumped] = await tx.update(trustPages).set({
      publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: args.actorUserId,
    }).where(eq(trustPages.id, args.pageId)).returning({ publicationRevision: trustPages.publicationRevision });
    // The row is locked in this transaction, so the bump always matches; never report a guessed revision.
    if (!bumped) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
    return { result, publicationRevision: bumped.publicationRevision };
  });
}
