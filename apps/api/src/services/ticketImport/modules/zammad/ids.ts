import type { LoadedTicket } from '../../moduleContract';
import type { ZammadLoadedData } from './shapes';

/**
 * The Zammad module's id grammar (#8313 W5; spec 2026-10-19 §5.2, §6.5).
 * Zammad ticket, article and store (attachment) ids are global (Z8), so
 * every id below is unique across the source and stable between passes:
 * they are resume keys per import principal.
 *
 * | Id | Used for |
 * |---|---|
 * | `<ticket id>` | the ticket key |
 * | `article:<article id>` | a source article (`isSourceArticleId`) |
 * | `article-files:<article id>` | the description's files comment |
 * | `note:<ticket id>:owner:<user id>` | the historic-owner note |
 * | `note:<ticket id>:pending:<state id>:<pending_time or none>` | the pending note |
 * | `note:<ticket id>:merged:<survivor id or none>` | the merge note |
 * | `note:<ticket id>:time:<time_unit>` | the time note |
 * | `attachment:<store id>` | a file |
 *
 * A note's id carries the value it states, so a changed value appends a new
 * note and the old one stays as history: comments are append-only.
 */

export const zammadIds = {
  ticket: (ticketId: number) => String(ticketId),
  article: (articleId: number) => `article:${articleId}`,
  articleFiles: (articleId: number) => `article-files:${articleId}`,
  ownerNote: (ticketId: number, userId: number) => `note:${ticketId}:owner:${userId}`,
  pendingNote: (ticketId: number, stateId: number, pendingTime: string | null) => `note:${ticketId}:pending:${stateId}:${pendingTime ?? 'none'}`,
  mergeNote: (ticketId: number, survivorId: number | null) => `note:${ticketId}:merged:${survivorId ?? 'none'}`,
  timeNote: (ticketId: number, timeUnit: string) => `note:${ticketId}:time:${timeUnit}`,
  attachment: (storeId: number) => `attachment:${storeId}`,
} as const;

const ARTICLE_ID = /^article:([1-9]\d{0,15})$/;
const ATTACHMENT_ID = /^attachment:([1-9]\d{0,15})$/;

export function articleIdOf(commentSourceId: string): number | null {
  const m = ARTICLE_ID.exec(commentSourceId);
  return m ? Number(m[1]) : null;
}

export function storeIdOf(attachmentSourceId: string): number | null {
  const m = ATTACHMENT_ID.exec(attachmentSourceId);
  return m ? Number(m[1]) : null;
}

function loadedData(loaded: LoadedTicket | undefined): ZammadLoadedData | null {
  const data = loaded?.data as Partial<ZammadLoadedData> | undefined;
  return data && Array.isArray(data.articles) && data.state ? data as ZammadLoadedData : null;
}

/**
 * A stored comment id this pass no longer sends: a source article deleted in
 * the source? (§5.3 item 3; the writer asks only about ids absent from the
 * input.) Only `article:<id>` can be. With the loaded ticket, two more cases
 * are not deletions:
 *
 * - **a merged ticket**: Zammad moved every article to the survivor (Z9), so
 *   none of its stored articles was deleted (W0's note on moved articles);
 * - **an article the ticket still holds** but did not send as a comment: it is
 *   now the description, it is a System article the options skip, or it is
 *   the merge marker.
 */
export function isZammadSourceArticleId(commentSourceId: string, loaded?: LoadedTicket): boolean {
  const articleId = articleIdOf(commentSourceId);
  if (articleId === null) return false;
  const data = loadedData(loaded);
  if (!data) return true;
  if (data.state.type === 'merged') return false;
  return !data.articles.some((a) => a.id === articleId);
}
