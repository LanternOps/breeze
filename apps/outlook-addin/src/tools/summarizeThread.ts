/**
 * Read tool: hand the model the open message so it can summarize the thread.
 *
 * Returns the subject and sender plus the body split into paragraphs under
 * `cells: string[][]` (one paragraph per row) so the server's per-cell DLP scan
 * fires — text under any other key downgrades DLP to a no-op.
 */
import { bodyToCells, getMailboxItem, readBodyText } from './mailbox';

export async function summarizeThread(_input: Record<string, unknown>): Promise<unknown> {
  const item = getMailboxItem();
  const bodyText = await readBodyText(item);
  return {
    subject: item.subject ?? '',
    from: item.from?.emailAddress ?? '',
    cells: bodyToCells(bodyText),
  };
}
