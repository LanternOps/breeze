/**
 * Email identity reader: the thread-linking identifiers a ticketing add-in
 * needs to match an inbound message to an existing ticket (or create one) —
 * `internetMessageId` / `References` / `In-Reply-To` — plus the represented
 * sender ("from", which drives contact resolution) kept distinct from the
 * message's provenance ("sender", populated on send-on-behalf-of mail).
 *
 * Mailbox 1.8 gate: `internetMessageId` and `getAllInternetHeadersAsync` are
 * Mailbox 1.8+ APIs. Below 1.8 (an older Outlook build) those reads are
 * unavailable — `headerCapable` reports this so callers degrade to
 * subject/from-based ticket matching rather than crashing or silently
 * fabricating identifiers.
 *
 * Never throws: a null item (a pinned pane transiting an ItemChanged) resolves
 * to `mode: 'none'` with every field at its empty default, matching
 * captureOutlookSelectionLabel's "never block the UI" contract.
 */
import { getMailboxItemOrNull, type MailboxItem } from '../tools/mailbox';

export interface EmailIdentity {
  mode: 'read' | 'compose' | 'none';
  subject: string;
  /** Represented from — drives contact/ticket resolution. */
  from: { email: string; name: string | null } | null;
  /** Provenance only (send-on-behalf); do not use for resolution. */
  sender: { email: string; name: string | null } | null;
  conversationId: string | null;
  /** null below Mailbox 1.8, in compose mode (the header APIs are read-mode
   *  only), or when the host has no id for this item. */
  internetMessageId: string | null;
  /** [] below Mailbox 1.8 or in compose mode. */
  references: string[];
  /** null below Mailbox 1.8 or in compose mode. */
  inReplyTo: string | null;
  /** Mailbox 1.8+ (and mode === 'read' — the header APIs are read-mode only). */
  headerCapable: boolean;
  /** Detected only (getSharedPropertiesAsync presence) — v1 does not read the
   *  shared-mailbox properties, it just flags & disables downstream behavior. */
  sharedMailbox: boolean;
}

const EMPTY_IDENTITY: EmailIdentity = {
  mode: 'none',
  subject: '',
  from: null,
  sender: null,
  conversationId: null,
  internetMessageId: null,
  references: [],
  inReplyTo: null,
  headerCapable: false,
  sharedMailbox: false,
};

/** Runtime Mailbox 1.8 capability check (manifest requirement sets stay put —
 *  this is a live capability probe, not a manifest change). */
export function hasMailbox18(): boolean {
  const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
  return officeGlobal?.context?.requirements?.isSetSupported?.('Mailbox', '1.8') ?? false;
}

function toAddress(
  addr: { displayName?: string; emailAddress?: string } | undefined,
): { email: string; name: string | null } | null {
  if (!addr?.emailAddress) return null;
  return { email: addr.emailAddress, name: addr.displayName ? addr.displayName : null };
}

/**
 * Mirrors draftReply.ts's mode duck-type exactly: a writable `body.setAsync`
 * exists only in compose mode (the read-mode body is immutable).
 */
function detectMode(item: MailboxItem | undefined): 'read' | 'compose' | 'none' {
  if (!item) return 'none';
  return typeof item.body?.setAsync === 'function' ? 'compose' : 'read';
}

/**
 * Unfolds RFC 5322 header folding (CRLF/LF followed by leading whitespace is a
 * continuation of the previous line, not a new header) and extracts every
 * `<...>` message-id token in order.
 */
export function parseReferences(headerValue: string): string[] {
  const unfolded = headerValue.replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  return unfolded.match(/<[^<>]+>/g) ?? [];
}

/** Reads one unfolded header's raw value (everything after `Name:`) out of the
 *  raw block returned by getAllInternetHeadersAsync. Case-insensitive name
 *  match; returns null when the header isn't present. */
function extractHeaderValue(rawHeaders: string, name: string): string | null {
  const unfolded = rawHeaders.replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  const prefix = `${name.toLowerCase()}:`;
  for (const line of unfolded.split(/\r\n|\n/)) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function readRawHeaderBlock(item: MailboxItem): Promise<string> {
  return new Promise((resolve) => {
    if (typeof item.getAllInternetHeadersAsync !== 'function') {
      resolve('');
      return;
    }
    item.getAllInternetHeadersAsync((result) => {
      if (result.status !== 'succeeded') {
        // Never-block contract: degrade to subject/from-based matching — but
        // leave a trace, since headerCapable stays true and the degradation is
        // otherwise invisible.
        console.warn('readEmailIdentity: getAllInternetHeadersAsync failed', result.error);
        resolve('');
        return;
      }
      resolve(result.value ?? '');
    });
  });
}

export async function readEmailIdentity(): Promise<EmailIdentity> {
  const item = getMailboxItemOrNull();
  const mode = detectMode(item);

  if (mode === 'none' || !item) {
    return { ...EMPTY_IDENTITY };
  }

  const subject = item.subject ?? '';
  const from = toAddress(item.from);
  const sender = toAddress(item.sender) ?? from;
  const conversationId = item.conversationId ? item.conversationId : null;
  const sharedMailbox = typeof item.getSharedPropertiesAsync === 'function';

  // The header-reading APIs (internetMessageId, getAllInternetHeadersAsync)
  // are Mailbox 1.8+, read-mode-only. Below that gate, degrade cleanly rather
  // than surfacing fabricated/undefined identifiers.
  const headerCapable = mode === 'read' && hasMailbox18();
  if (!headerCapable) {
    return {
      mode,
      subject,
      from,
      sender,
      conversationId,
      internetMessageId: null,
      references: [],
      inReplyTo: null,
      headerCapable: false,
      sharedMailbox,
    };
  }

  const internetMessageId = item.internetMessageId ? item.internetMessageId : null;
  const rawHeaders = await readRawHeaderBlock(item);
  const referencesValue = extractHeaderValue(rawHeaders, 'References');
  const references = referencesValue ? parseReferences(referencesValue) : [];
  const inReplyToValue = extractHeaderValue(rawHeaders, 'In-Reply-To');
  const inReplyTo = inReplyToValue ? (parseReferences(inReplyToValue)[0] ?? inReplyToValue) : null;

  return {
    mode,
    subject,
    from,
    sender,
    conversationId,
    internetMessageId,
    references,
    inReplyTo,
    headerCapable: true,
    sharedMailbox,
  };
}
