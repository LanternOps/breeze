/**
 * Read tool: the open message's headers (subject / from / to / cc / date).
 *
 * Returns the typed header fields for the model AND packs every header value
 * into `cells: string[][]` for pass-1 DLP parity — the server's per-cell DLP
 * scan keys off `Array.isArray(output.cells)`, so the header values (which can
 * carry PII like email addresses) must also live under `cells`.
 */
import { getMailboxItem, type MailboxEmailAddress } from './mailbox';

function addressList(addresses: MailboxEmailAddress[] | undefined): string[] {
  return (addresses ?? []).map((a) => a.emailAddress);
}

export async function getMessageMetadata(_input: Record<string, unknown>): Promise<unknown> {
  const item = getMailboxItem();
  const subject = item.subject ?? '';
  const from = item.from?.emailAddress ?? '';
  const to = addressList(item.to);
  const cc = addressList(item.cc);
  const date = item.dateTimeCreated ? item.dateTimeCreated.toISOString() : '';

  // Pack every header value into cells so each is scanned by per-cell DLP.
  const cells: string[][] = [
    ['Subject', subject],
    ['From', from],
    ['To', to.join(', ')],
    ['Cc', cc.join(', ')],
    ['Date', date],
  ];

  return { subject, from, to, cc, date, cells };
}
