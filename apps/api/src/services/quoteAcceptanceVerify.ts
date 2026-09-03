// Re-verification of a stored quote acceptance hash (#3777 follow-up).
//
// quote_acceptances.quote_sha256 is computed ONCE at accept time
// (quoteAcceptService) over the quote's billable content plus, for a quote that
// embeds contract blocks, the fully-resolved variable set — whose money values
// are formatted in a render locale. That locale is persisted on the acceptance
// row (`render_locale`) so a later recompute uses the locale the signature was
// actually taken under, never the quote's (backfilled) document_locale and never
// the partner's live language.
//
// Rows that predate the 2026-09-01-b backfill carry NULL: at that time the
// accept path called resolveAutoVariables without a locale, i.e. the 'en'
// fallback — acceptanceRenderLocale encodes exactly that.

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { quotes, quoteBlocks, quoteLines, quoteAcceptances } from '../db/schema/quotes';
import { loadContractBlockRenderData } from './contractTemplateRender';
import { buildContractHashParts } from './contractDocumentService';
import { computeQuoteSha256, type QuoteHashVersion } from './quoteContentHash';
import { QuoteServiceError } from './quoteTypes';

/** The locale a stored acceptance hash was computed under. NULL (pre-backfill
 *  row) means the pre-#3777 fallback that was in force: 'en'. */
export function acceptanceRenderLocale(acceptance: { renderLocale: string | null | undefined }): string {
  return acceptance.renderLocale ?? 'en';
}

export interface AcceptanceHashVerification {
  acceptanceId: string;
  quoteId: string;
  renderLocale: string;
  hashVersion: QuoteHashVersion;
  storedSha256: string;
  recomputedSha256: string;
  matches: boolean;
}

/**
 * Recompute the content hash for a recorded acceptance from the CURRENT quote
 * rows and compare it with the stored one. Runs under the caller's DB access
 * context for the quote/acceptance reads; the pinned template versions are
 * read through loadContractBlockRenderData's own system context, so call this
 * outside any org-scoped transaction (same contract as the accept route).
 */
export async function verifyQuoteAcceptanceHash(acceptanceId: string): Promise<AcceptanceHashVerification> {
  const [acceptance] = await db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, acceptanceId)).limit(1);
  if (!acceptance) throw new QuoteServiceError('Acceptance not found', 404, 'QUOTE_NOT_FOUND');
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, acceptance.quoteId)).limit(1);
  if (!quote) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quote.id)).orderBy(quoteBlocks.sortOrder);
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id)).orderBy(quoteLines.sortOrder);

  // The accept path pins {{dates.effective}} to the accept moment (quotes.accepted_at,
  // the same `now` the acceptance was recorded with), date-only UTC.
  const acceptedAt = quote.acceptedAt ?? acceptance.signedAt;
  const effectiveDate = acceptedAt.toISOString().slice(0, 10);
  const renderLocale = acceptanceRenderLocale(acceptance);

  const renderData = await loadContractBlockRenderData(blocks);
  const parts = buildContractHashParts(blocks, renderData, quote, effectiveDate, renderLocale);
  // Same widening the accept path uses (quoteAcceptService.ts:148): the raw
  // Drizzle rows are structurally wider than HashableLine/QuoteRow (nullable
  // description et al.), and the hash canonicaliser reads only the fields it
  // declares. Recompute MUST mirror the accept path exactly or hashes diverge.
  // Read, never inferred. Deriving it ("does any line have a descriptor?")
  // re-creates the fragility the version exists to remove: a v1 quote whose
  // line later ACQUIRED a descriptor through a migration or a support edit
  // would silently verify under the wrong algorithm.
  const hashVersion = (acceptance.hashVersion ?? 1) as QuoteHashVersion;
  const recomputedSha256 = computeQuoteSha256(quote as any, blocks as any, lines as any, parts, hashVersion);
  return {
    acceptanceId: acceptance.id,
    quoteId: quote.id,
    renderLocale,
    hashVersion,
    storedSha256: acceptance.quoteSha256,
    recomputedSha256,
    matches: recomputedSha256 === acceptance.quoteSha256,
  };
}
