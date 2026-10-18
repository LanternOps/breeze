// Owner: W02f (FAQ).
import { asc, eq } from 'drizzle-orm';
import { TRUST_FAQ_ANSWER_MAX_CHARS, type TrustPagePublicPayload, type TrustPublishedConfig } from '@breeze/shared';
import { db } from '../../../db';
import { trustPageFaqItems } from '../../../db/schema';
import { sanitizeFlowRichTextHtml } from '../../richTextSanitize';
import type { SectionBuildContext, SectionDraftContext } from './types';

/**
 * Re-sanitize (the builder never trusts stored HTML, W1 Ruling 10) and bound it. Returns null, dropping the item
 * (never throwing), for an answer over the stored cap or a blank question; questions are cut to 300 characters.
 * The PUT route already rejects over-long answers, so the drop is a defensive path.
 */
function cleanItem(question: string, answerHtml: string): { question: string; answerHtml: string } | null {
  const answer = sanitizeFlowRichTextHtml(answerHtml).trim();
  if (answer.length > TRUST_FAQ_ANSWER_MAX_CHARS) {
    console.warn('[trustPage] FAQ answer exceeded the payload bound after sanitization; omitted');
    return null;
  }
  return question.trim() ? { question: question.trim().slice(0, 300), answerHtml: answer } : null;
}

/** Publish/preview: copy the draft items in sort order. */
export async function freezeFaq(ctx: SectionDraftContext): Promise<TrustPublishedConfig['faq']> {
  const rows = await db.select().from(trustPageFaqItems)
    .where(eq(trustPageFaqItems.trustPageId, ctx.page.id)).orderBy(asc(trustPageFaqItems.sortOrder));
  return rows.map((r) => cleanItem(r.question, r.answerHtml)).filter((i): i is NonNullable<typeof i> => i !== null);
}

export function buildFaq(ctx: SectionBuildContext): TrustPagePublicPayload['faq'] {
  return ctx.config.faq.map((i) => cleanItem(i.question, i.answerHtml)).filter((i): i is NonNullable<typeof i> => i !== null);
}
