import type { AttachmentRef, ProbeResult, SourceHandle } from '../../moduleContract';
import { SourceAuthError, SourceHttpError } from '../../sourceFetch';
import { downloadAttachment, getTicket } from './api';
import { storeIdOf } from './ids';
import { rememberedFileLocation, rememberFileLocations, zammadArticles, zammadRow } from './reading';

/**
 * Files and probes of a Zammad 7.2.x source (#8313 W5; spec 2026-10-19 §4.3,
 * §5.9 deletions, §6.2).
 *
 * - **fetchAttachment** downloads `GET /ticket_attachment/:ticket/:article/:id`
 *   with no `view`: the original bytes, never the 1800 px copy of
 *   `view=inline` (Z6). The ticket is the article's current one (a merge
 *   moves articles, Z9; the route also accepts a merged ticket, Z8). At most
 *   `maxBytes`. The framework reads the failures: a 404 or 403 is permanent
 *   (`not_found`), an over-cap answer `too_large`, a timeout or 5xx
 *   transient (the next run retries the ticket), a 429 or `Retry-After` the
 *   worker's deferral, a 401 a stopped run.
 * - **probe** answers a ticket the scan did not see: 404 deleted, 403 hidden
 *   (no longer visible, Z10), else present with its row.
 */

export async function fetchZammadAttachment(src: SourceHandle<unknown>, ref: AttachmentRef, maxBytes: number): Promise<Uint8Array> {
  const storeId = storeIdOf(ref.sourceId);
  const ticketId = Number(ref.ticketKey);
  // Not an id this module minted: nothing to download, permanently.
  if (storeId === null || !Number.isSafeInteger(ticketId) || ticketId <= 0) throw new SourceHttpError(404);
  let location = rememberedFileLocation(src, ref.ticketKey, storeId);
  if (!location) {
    // Normally remembered by the ticket's load; otherwise read where the file
    // lives now, the way a load reads (the per-article path for a big ticket).
    rememberFileLocations(src, ref.ticketKey, await zammadArticles(src, ticketId));
    location = rememberedFileLocation(src, ref.ticketKey, storeId);
    if (!location) throw new SourceHttpError(404);
  }
  return downloadAttachment(src, { ...location, storeId }, maxBytes);
}

export async function probeZammad(src: SourceHandle<unknown>, sourceTicketKey: string): Promise<ProbeResult> {
  const ticketId = Number(sourceTicketKey);
  if (!/^[1-9]\d{0,15}$/.test(sourceTicketKey) || !Number.isSafeInteger(ticketId)) {
    throw new Error(`Not a Zammad ticket key: ${JSON.stringify(sourceTicketKey.slice(0, 32))}`);
  }
  try {
    return { state: 'present', row: zammadRow(await getTicket(src, ticketId)) };
  } catch (error) {
    if (error instanceof SourceHttpError && !(error instanceof SourceAuthError)) {
      if (error.status === 404) return { state: 'deleted' };
      if (error.status === 403) return { state: 'hidden' };
    }
    throw error;
  }
}
