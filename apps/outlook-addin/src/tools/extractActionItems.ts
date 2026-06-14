/**
 * Read tool: hand the model the open message so it can pull out action items.
 *
 * Same body read as summarize_thread; returns the subject and the body
 * paragraphs under `cells: string[][]` (one paragraph per row) so the server's
 * per-cell DLP scan fires (text under any other key downgrades DLP to a no-op).
 */
import { bodyToCells, getMailboxItem, readBodyText } from './mailbox';

export async function extractActionItems(_input: Record<string, unknown>): Promise<unknown> {
  const item = getMailboxItem();
  const bodyText = await readBodyText(item);
  return {
    subject: item.subject ?? '',
    cells: bodyToCells(bodyText),
  };
}
