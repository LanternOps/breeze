// Text extraction for the content layer.
// This module extracts text ONLY; it stores nothing. DLP runs downstream in
// contentIngestService, between extraction and persistence: the text returned
// here is inspected there before anything is stored — 'redact' hits rewrite it,
// a 'block' hit drops it (no text, no chunks).
import { createHash } from 'node:crypto';
import { simpleParser, type AddressObject } from 'mailparser';

export interface EmailMeta {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  date?: string;
  /** RFC 5322 Message-ID, angle brackets stripped and lowercased. Absent when
   * the source mail carries no Message-ID header — the demo corpus fixture
   * (PO-4021) is exactly this case, which is why the matcher (Task 6) never
   * relies on tier 1 alone. */
  messageId?: string;
}

export type ExtractionResult =
  | { status: 'extracted'; text: string; contentHash: string; emailMeta: EmailMeta | null }
  | { status: 'skipped_binary' }
  | { status: 'skipped_too_large' }
  | { status: 'failed'; errorReason: string };

// Extraction allowlist. Everything else is skipped_binary — this is what keeps
// non-text estate content (and anything unexpected on the share) out of the
// content store entirely.
const TEXT_EXTS = new Set(['md', 'txt', 'text', 'markdown']);
const EMAIL_EXTS = new Set(['eml']);

const addressText = (a: AddressObject | AddressObject[] | undefined): string[] => {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list.map((x) => x.text).filter(Boolean);
};

export async function extractContent(
  name: string,
  bytes: Buffer,
  maxBytes: number,
): Promise<ExtractionResult> {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const isText = TEXT_EXTS.has(ext);
  const isEmail = EMAIL_EXTS.has(ext);
  if (!isText && !isEmail) return { status: 'skipped_binary' };
  if (bytes.length > maxBytes) return { status: 'skipped_too_large' };

  const contentHash = createHash('sha256').update(bytes).digest('hex');
  try {
    if (isText) {
      return { status: 'extracted', text: bytes.toString('utf8'), contentHash, emailMeta: null };
    }
    const parsed = await simpleParser(bytes);
    const from = parsed.from?.text;
    const to = addressText(parsed.to);
    const cc = addressText(parsed.cc);
    const subject = parsed.subject ?? undefined;
    const body = (parsed.text && parsed.text.trim().length > 0)
      ? parsed.text
      // html-only mail: crude tag strip is enough for search text
      : (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '');
    // Searchable text carries the headers inline so subject/participant terms
    // match without a separate field search.
    const text = [
      subject ? `Subject: ${subject}` : null,
      from ? `From: ${from}` : null,
      to.length ? `To: ${to.join(', ')}` : null,
      cc.length ? `Cc: ${cc.join(', ')}` : null,
      '',
      body,
    ].filter((l): l is string => l !== null).join('\n');
    const messageId = parsed.messageId
      ? parsed.messageId.trim().replace(/^<+|>+$/g, '').toLowerCase() || undefined
      : undefined;
    const emailMeta: EmailMeta = {
      from,
      to: to.length ? to : undefined,
      cc: cc.length ? cc : undefined,
      subject,
      date: parsed.date?.toISOString(),
      messageId,
    };
    return { status: 'extracted', text, contentHash, emailMeta };
  } catch (error) {
    return {
      status: 'failed',
      errorReason: error instanceof Error ? error.message : String(error),
    };
  }
}
