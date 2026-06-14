/**
 * Outlook context-chip payload: the user controls per-message data egress.
 *   none      → { kind: 'none' }
 *   selection → the open message (subject + body) as linear text. Outlook has no
 *               cell selection, so we reuse the neutral 'selection' kind to mean
 *               "this message" and carry it under `WorkbookContext.text` (the
 *               grid-less text channel Word also uses) — NOT the grid-shaped
 *               `cells`/`address` Excel uses.
 *
 * There is no 'sheet' analog for mail (the message IS the document), so the only
 * data-bearing kind is 'selection'; the composer offers just "This email" /
 * "No email data" (see host/outlook.ts contextOptions).
 */
import type { WorkbookContext, WorkbookContextKind } from '@breeze/office-addin-core';
import { getMailboxItem, readBodyText } from '../tools/mailbox';

/**
 * The open message subject, captured at session create so the per-user history
 * list can tag/filter by message. Returns undefined when no item/subject can be
 * read — capture must never block session creation.
 */
export async function captureOutlookSubject(): Promise<string | undefined> {
  try {
    const subject = getMailboxItem().subject?.trim();
    return subject ? subject : undefined;
  } catch {
    return undefined;
  }
}

export async function captureOutlookContext(
  kind: WorkbookContextKind,
): Promise<WorkbookContext | undefined> {
  if (kind !== 'selection') return { kind: 'none' };
  const item = getMailboxItem();
  const subject = item.subject ?? '';
  const bodyText = await readBodyText(item);
  const text = subject ? `${subject}\n\n${bodyText}` : bodyText;
  return { kind: 'selection', text };
}
