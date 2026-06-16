/**
 * The ONE place the Outlook tool/host layer reaches the live mailbox surface.
 *
 * Outlook is the mail-model outlier: there is no `Word.run`/`Excel.run`. The
 * surface is `Office.context.mailbox.item`, which the host REPLACES per selection
 * when a pinned pane sees an item switch. Every reader therefore re-reads
 * `getMailboxItem()` at call time — caching the item object once would bind the
 * STALE message after a switch (the item-changed rebinding the manifest's
 * `SupportsPinning` enables; proved by the officeMock's `switchItem()`).
 *
 * `@types/office-js` types `mailbox.item` as a broad read/compose union where the
 * mode-specific members (`body.setAsync`, `displayReplyForm`) are conditional, so
 * we narrow to the subset the tools actually touch and let each call site guard
 * which path exists at runtime.
 */

/** The Outlook EmailAddressDetails subset the read tools surface. */
export type MailboxEmailAddress = { displayName: string; emailAddress: string };

/** The live `mailbox.item` surface the tools narrow to (read OR compose). */
export type MailboxItem = {
  subject: string;
  from?: MailboxEmailAddress;
  to?: MailboxEmailAddress[];
  cc?: MailboxEmailAddress[];
  dateTimeCreated?: Date;
  body: {
    getAsync: (coercionType: string, cb: (r: AsyncResult<string>) => void) => void;
    setAsync?: (data: string, options: unknown, cb?: (r: AsyncResult<void>) => void) => void;
  };
  displayReplyForm?: (formData: string | { htmlBody?: string }) => void;
  displayReplyAllForm?: (formData: string | { htmlBody?: string }) => void;
};

type AsyncResult<T> = {
  status: 'succeeded' | 'failed';
  value: T;
  error?: { name: string; message: string; code: number };
};

/**
 * Read the CURRENT mailbox item. Throws if the host isn't Outlook (no mailbox) —
 * callers in tool executors run only inside the pane, where it's always present.
 */
export function getMailboxItem(): MailboxItem {
  const mailbox = (globalThis as { Office?: typeof Office }).Office?.context?.mailbox;
  const item = mailbox?.item as MailboxItem | undefined;
  if (!item) throw new Error('No mailbox item is open (Office.context.mailbox.item is unavailable)');
  return item;
}

/** Coercion type for the plain-text body read (DLP-friendly; no markup). */
export function textCoercionType(): string {
  return (globalThis as { Office?: typeof Office }).Office?.CoercionType?.Text ?? 'text';
}

/** Read the item body as plain text via the async callback API, promisified.
 *  On a failed getAsync, reject with the host error rather than collapsing to
 *  '' — otherwise the model is told to summarize an email it never read. */
export function readBodyText(item: MailboxItem): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    item.body.getAsync(textCoercionType(), (result) => {
      if (result.status === 'succeeded') {
        resolve(result.value ?? '');
      } else {
        reject(new Error(result.error?.message ?? 'Failed to read the message body (getAsync failed).'));
      }
    });
  });
}

/**
 * Split a plain-text body into one paragraph per non-empty line, returned as a
 * `cells` matrix (one paragraph per row). Reads MUST return text under `cells`:
 * the server's per-cell DLP scan keys off `Array.isArray(output.cells)`, so text
 * under any other key downgrades DLP to a no-op.
 */
export function bodyToCells(bodyText: string): string[][] {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => [line]);
}
