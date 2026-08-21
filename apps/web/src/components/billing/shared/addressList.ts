import { isValidEmail } from '@/lib/email';

/** Mirrors the send routes' `.max(10)` on both `to` and `cc`
 *  (apps/api/src/lib/sendComposer.ts) — shared by the quote and invoice
 *  composers, which post to that one schema. */
export const MAX_RECIPIENTS = 10;

/** Split a comma/semicolon/newline-separated address list into valid + invalid
 *  entries (case-insensitively deduped, first-seen order kept). The server
 *  re-validates every address; this only powers the pre-submit UX guard. */
export function parseAddressList(raw: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]+/)) {
    const addr = part.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (isValidEmail(addr) ? emails : invalid).push(addr);
  }
  return { emails, invalid };
}
