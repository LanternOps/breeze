/**
 * Gmail read-only mailbox client for the inbound ticket connector.
 *
 * Thin wrapper over @googleapis/gmail (already a dependency). Uses the inbound
 * DWD client (getInboundGmailClient). Every method here is read-only in BEHAVIOR
 * — it never mutates the mailbox, so there is no mark-read; the historyId cursor
 * is the incremental mechanism. Note the granted scope is broader than the
 * behavior: GMAIL_INBOUND_SCOPES is gmail.modify (see googleClient.ts for why),
 * so the authorization boundary permits label/read-state changes even though this
 * client performs none.
 *
 * Cursor model (Gmail is NOT a Graph delta URL):
 *  - historyId is an opaque STRING. Never parse it as a number.
 *  - users.history.list(startHistoryId) returns changes SINCE that id. We ask
 *    for messageAdded AND labelAdded(INBOX) so we catch both freshly-delivered
 *    mail and mail moved INTO the inbox (e.g. released from Spam).
 *  - A 404 means the startHistoryId is too old to serve — history is not
 *    retained indefinitely. The caller must reconcile (re-seed from the current
 *    profile historyId); it must NOT silently resume, which would skip the gap.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import { getInboundMailboxSession } from '../googleClient';
import { MAX_BODY_B64_CHARS, MAX_BODY_BYTES } from './normalizeGmailMessage';

/** Which half of the connect-time probe failed, so the caller maps it to the right
 *  error code (a mailbox read failure vs a missing identity grant). */
export class MailboxProbeError extends Error {
  constructor(public readonly kind: 'read' | 'identity', message: string) {
    super(message);
    this.name = 'MailboxProbeError';
  }
}

export interface MailboxConnectProbe {
  /** Baseline Gmail history cursor (opaque STRING). */
  historyId: string;
  /** The mailbox's immutable Google account sub. */
  sub: string;
  /** The account's primary email as Google reports it (diagnostic). */
  email: string | null;
}

/**
 * Connect-time probe: ONE DWD session (one JWT / one token) reads BOTH the baseline
 * history cursor AND the immutable account identity, so the cursor and the sub are
 * bound to the SAME credential and cannot straddle an address reassignment between
 * two separately-minted requests. Throws MailboxProbeError with the failing half.
 */
export async function probeMailboxForConnect(saKeyJson: string, mailbox: string): Promise<MailboxConnectProbe> {
  const session = getInboundMailboxSession(saKeyJson, mailbox);
  let historyId: string;
  try {
    const res = await session.gmail.users.getProfile({ userId: 'me' });
    if (!res.data.historyId) throw new Error('Gmail getProfile returned no historyId');
    historyId = String(res.data.historyId);
  } catch (err) {
    throw new MailboxProbeError('read', err instanceof Error ? err.message : String(err));
  }
  let sub: string;
  let email: string | null;
  try {
    ({ sub, email } = await session.identity());
  } catch (err) {
    throw new MailboxProbeError('identity', err instanceof Error ? err.message : String(err));
  }
  // Cross-check the returned principal. A different primary email is legitimate for
  // an ALIAS mailbox (Google returns the account's primary), so this is a
  // diagnostic warning, not a hard failure — the immutable sub is authoritative.
  if (email && email.toLowerCase() !== mailbox.toLowerCase()) {
    // Diagnostic only: the impersonated address is an alias, so UserInfo returns the
    // account's primary. Do NOT log either address — both are customer addresses and
    // must not be exported to centralized logs. The immutable sub is authoritative.
    console.warn('[gmailConnect] connected mailbox is an alias (UserInfo returned the account primary)');
  }
  return { historyId, sub, email };
}

/** Read an HTTP status off a googleapis/gaxios error structurally, without
 * importing the transitive gaxios package (keeps the dependency surface to the
 * declared @googleapis/gmail). */
function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const raw = e?.response?.status ?? e?.status ?? e?.code;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function errorReason(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    | { error?: { errors?: { reason?: string }[] } }
    | undefined;
  return String(data?.error?.errors?.[0]?.reason ?? '');
}

/** Raised when the stored historyId is too old for users.history.list (HTTP 404). */
export class GmailHistoryExpiredError extends Error {
  constructor() {
    super('Gmail history cursor expired (404)');
    this.name = 'GmailHistoryExpiredError';
  }
}

/** Classify a Gmail API error so the worker can react correctly. Gmail 403 is
 * NOT always auth: the usage-limit reasons (rateLimitExceeded,
 * userRateLimitExceeded, sharingRateLimitExceeded, dailyLimitExceeded,
 * quotaExceeded) are transient and clear on their own — a 'reauth' verdict for
 * any of them would set status='reauth_required' and permanently drop an
 * otherwise-healthy mailbox from polling (which selects only 'connected' rows)
 * until a manual reconnect, so daily-quota exhaustion must NOT read as auth. */
export type GmailErrorKind = 'rate_limit' | 'reauth' | 'transient' | 'fatal';

// `rateLimit` (case-insensitive) covers rateLimitExceeded, userRateLimitExceeded
// and sharingRateLimitExceeded; dailyLimitExceeded and quotaExceeded need naming.
const GMAIL_QUOTA_REASON = /rateLimit|dailyLimitExceeded|quotaExceeded/i;

export function classifyGmailError(err: unknown): GmailErrorKind {
  const status = httpStatus(err);
  const reason = errorReason(err);
  if (status === 429) return 'rate_limit';
  if (status === 403 && GMAIL_QUOTA_REASON.test(reason)) return 'rate_limit';
  if (status === 401 || status === 403) return 'reauth';
  if (status !== undefined && status >= 500) return 'transient';
  // No HTTP status at all = a transport failure (ECONNRESET, DNS, timeout,
  // socket hang-up). Treat as transient/retryable, NOT fatal: a fatal verdict
  // sets the mailbox status='error', and the sweep only selects 'connected' rows,
  // so a momentary network blip would permanently remove the mailbox from polling.
  if (status === undefined) return 'transient';
  return 'fatal';
}

/**
 * The mailbox's current historyId — the baseline cursor captured at connect
 * time (and after an expiry, the re-seed point). Takes a caller-built Gmail client
 * so a sweep can bind this read to the SAME session (token) it used to verify the
 * mailbox's account identity.
 */
export async function getStartHistoryId(gmail: gmail_v1.Gmail): Promise<string> {
  const res = await gmail.users.getProfile({ userId: 'me' });
  const id = res.data.historyId;
  if (!id) throw new Error('Gmail getProfile returned no historyId');
  return String(id);
}

export interface InboxChanges {
  /** De-duplicated Gmail message ids that entered the inbox since startHistoryId. */
  messageIds: string[];
  /**
   * The terminal historyId to persist — the caller advances the cursor to it only
   * AFTER the page's messages are durably ENQUEUED on BullMQ (not after tickets are
   * created). This matches the Microsoft delta-cursor path. Consumer-side ingestion
   * happens later; the mailbox cursor does NOT re-list an already-enqueued message.
   * A message whose consumer processing fails records a durable
   * `ticket_email_inbound` row with parse_status='failed' (independent of the
   * poisoned request transaction — see logInboundFailedDurable), which surfaces in
   * the review queue for manual convert/dismiss, so an ordinary processing failure
   * is not lost.
   *
   * KNOWN LIMITATION (shared with the Microsoft path, pre-dating this connector):
   * because the cursor advances after ENQUEUE rather than after a durable per-message
   * record, a failure that ALSO prevents writing the failed row — e.g. Postgres
   * unreachable through all of BullMQ's `attempts` retries — loses the message once
   * the job is evicted, since Gmail will not re-list it. Closing this fully needs a
   * durable pre-enqueue "pending" ledger with replay; that is the tracked future
   * enhancement, not something this connector changes. It does not widen the M365
   * exposure — it extends the same accepted behavior to Gmail.
   */
  newHistoryId: string | null;
}

/**
 * Message ids added to the inbox since `startHistoryId`, following pagination to
 * completion before returning the terminal historyId. Throws
 * GmailHistoryExpiredError on 404 so the caller reconciles rather than resumes.
 */
export async function listInboxChanges(
  gmail: gmail_v1.Gmail,
  startHistoryId: string,
): Promise<InboxChanges> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;

  try {
    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded', 'labelAdded'],
        labelId: 'INBOX',
        pageToken,
      });
      if (res.data.historyId) latestHistoryId = String(res.data.historyId);
      for (const h of res.data.history ?? []) {
        for (const m of h.messagesAdded ?? []) {
          if (m.message?.id) ids.add(m.message.id);
        }
        // labelId=INBOX filters which history records are RETURNED, but a
        // labelsAdded record's own labelIds says which labels were added — a
        // message already in INBOX that later gains STARRED also appears here.
        // Only treat it as an inbox arrival when INBOX is the label added.
        for (const l of h.labelsAdded ?? []) {
          if (l.message?.id && (l.labelIds ?? []).includes('INBOX')) ids.add(l.message.id);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (httpStatus(err) === 404) throw new GmailHistoryExpiredError();
    throw err;
  }

  return { messageIds: [...ids], newHistoryId: latestHistoryId };
}

/**
 * Enumerate INBOX message ids received at/after `afterEpochSec` (the eligibility
 * floor). Used for recovery after an expired history cursor.
 *
 * Boundary safety: Gmail's `after:<epoch>` is second-granular, but Google does NOT
 * document whether the exact floor second is inclusive or exclusive. If it were
 * strictly exclusive, a message that arrived in the SAME whole second as the floor
 * would be missed here and then skipped forever once recovery advances the cursor.
 * So we query one second EARLIER (`after:floor-1`) to guarantee the floor second is
 * always covered regardless of Gmail's boundary semantics. The over-inclusion is at
 * most the sub-second window before the floor: any such message is either already
 * ingested (the caller's durable dedup drops it) or a genuine at/after-floor arrival
 * — never the historical inbox, which lies whole seconds before the floor. Choosing
 * to over-include by <1s beats losing mail on an undocumented boundary.
 * Follows pagination to completion.
 */
export async function forEachInboxPageSince(
  gmail: gmail_v1.Gmail,
  afterEpochSec: number,
  onPage: (ids: string[]) => Promise<boolean>,
): Promise<void> {
  let pageToken: string | undefined;
  // Widen by one second so the floor second is included even if `after:` is
  // strictly exclusive; never go below 0.
  const afterQuery = Math.max(0, Math.floor(afterEpochSec) - 1);
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      q: `after:${afterQuery}`,
      maxResults: 500,
      pageToken,
    });
    const ids: string[] = [];
    for (const m of res.data.messages ?? []) {
      if (m.id) ids.push(m.id);
    }
    // Hand each page to the caller as it arrives so recovery never holds the whole
    // (potentially huge) inbox in memory. The callback returns false to STOP early
    // (e.g. the mailbox generation went stale mid-recovery).
    if (ids.length > 0 && !(await onPage(ids))) return;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

/**
 * Collects EVERY matching id into one array. Convenience for callers that need the
 * full list; recovery uses {@link forEachInboxPageSince} directly so it processes
 * and releases each page and never accumulates an unbounded array.
 */
export async function listInboxMessageIdsSince(
  gmail: gmail_v1.Gmail,
  afterEpochSec: number,
): Promise<string[]> {
  const ids: string[] = [];
  await forEachInboxPageSince(gmail, afterEpochSec, async (page) => {
    ids.push(...page);
    return true;
  });
  return ids;
}

/**
 * Fetch a message in FULL form (parsed headers + MIME parts). We use `full`
 * rather than `raw` so we mirror the structured Graph mapping and avoid pulling
 * in a standalone MIME parser. Returns null if the message no longer exists
 * (deleted between the history read and this fetch — a normal race, not an error).
 */
export async function getFullMessage(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<gmail_v1.Schema$Message | null> {
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    await resolveReferencedTextBodies(gmail, id, res.data);
    return res.data;
  } catch (err) {
    if (httpStatus(err) === 404) return null;
    throw err;
  }
}

/**
 * `format: 'full'` inlines a part's body in `body.data` only when it is small
 * enough; above Gmail's threshold the body is returned by REFERENCE as
 * `body.attachmentId` with no `data`
 * (https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).
 * The pure normalizer reads only `body.data`, so a large text/plain or text/html
 * body would otherwise be silently dropped. Fetch each referenced TEXT body and
 * inline it back onto the part so the normalizer sees a uniform `data` field.
 * Real file attachments are left by reference — the normalizer keeps only their
 * metadata, so there is nothing to fetch.
 */
export async function resolveReferencedTextBodies(
  gmail: gmail_v1.Gmail,
  messageId: string,
  message: gmail_v1.Schema$Message,
): Promise<void> {
  const pending: Array<{ part: gmail_v1.Schema$MessagePart; attachmentId: string }> = [];
  const collect = (part: gmail_v1.Schema$MessagePart | undefined, depth: number): void => {
    if (!part || depth > 20) return;
    const mime = (part.mimeType ?? '').toLowerCase();
    // Mirror the normalizer's attachment test: a part with a filename OR a
    // Content-Disposition: attachment is an attachment, never a text body to
    // fetch — even an unnamed one (RFC 2183 makes filename optional).
    const disposition = (part.headers ?? [])
      .find((h) => (h.name ?? '').toLowerCase() === 'content-disposition')?.value ?? '';
    const isAttachment = !!part.filename || disposition.trim().toLowerCase().startsWith('attachment');
    const isTextBody =
      !isAttachment && (mime === 'text/plain' || mime === 'text/html');
    const attachmentId = part.body?.attachmentId;
    // Refuse to fetch a referenced text body whose DECLARED decoded size already
    // exceeds the cap. attachments.get returns the whole part in one response
    // (the Gmail API has no range fetch), so the only place we can bound PEAK
    // allocation is here, before the call. An over-cap text body is not inlined;
    // the normalizer then falls back to the snippet / the alternative part. A body
    // with an UNDERSTATED size is a residual limitation of the API (it is still
    // received whole once); the retained copy is bounded below regardless.
    const declaredSize = Number(part.body?.size ?? 0);
    if (isTextBody && attachmentId && !part.body?.data && declaredSize <= MAX_BODY_BYTES) {
      pending.push({ part, attachmentId });
    }
    for (const child of part.parts ?? []) collect(child, depth + 1);
  };
  collect(message.payload ?? undefined, 0);

  for (const { part, attachmentId } of pending) {
    let data: string | null | undefined;
    try {
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      });
      data = att.data.data;
    } catch (err) {
      // A per-attachment failure must NOT discard the whole message. getFullMessage
      // treats a 404 as "the message was deleted" and skips it (advancing the
      // cursor past it) — but a 404 HERE means only this referenced text PART is
      // gone, while the message still exists. Leave this part without inline data
      // (the normalizer falls back to the snippet / the alternative part) and
      // continue, so the email is still ingested. Re-throw non-404 so a transient
      // fault still aborts the sweep without advancing the cursor.
      if (httpStatus(err) === 404) continue;
      throw err;
    }
    // Bound the RETAINED encoded body to the same cap the normalizer decodes to.
    // (Peak allocation of the response itself is bounded by the declared-size
    // guard in collect() above, not here.)
    if (data && part.body) {
      part.body.data = data.length > MAX_BODY_B64_CHARS
        ? data.slice(0, MAX_BODY_B64_CHARS)
        : data;
    }
  }
}
