/**
 * Opt-in Gmail mark-handled, applied AFTER the inbound pipeline has turned a
 * polled Gmail message into a ticket (created a new one or threaded onto an
 * existing one). Mail the pipeline quarantined, dropped, ignored or failed is
 * never labelled or archived, so the support inbox keeps everything that still
 * needs a human.
 *
 * Off unless GMAIL_HANDLED_LABEL is set. Uses a separate gmail.modify-only client
 * (the read session stays read-only), retries a rate-limited/transient failure a
 * bounded number of times, and never throws: the ticket already exists, so a
 * failed label is a cosmetic miss (the message stays in the inbox), not lost mail.
 */
import { and, eq } from 'drizzle-orm';
import type { gmail_v1 } from '@googleapis/gmail';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { ticketEmailInbound, ticketMailboxConnections } from '../../db/schema';
import type { NormalizedInboundEmail } from '../inboundEmail/types';
import type { MailboxGenerationContext } from '../inboundEmailQueue';
import { loadGoogleConnection, decryptConnectionKey } from '../googleHelpers';
import { getInboundModifyGmailClient } from '../googleClient';
import { classifyGmailError, markGmailHandled } from './googleMailboxClient';
import { gmailHandledConfig } from './gmailHandledConfig';

const TICKETED_STATUSES = new Set(['created', 'matched']);
const RETRY_DELAYS_MS = [500, 2000];

export interface MarkIngestedDeps {
  sleep?: (ms: number) => Promise<void>;
  modifyClient?: (saKey: string, mailbox: string) => gmail_v1.Gmail;
}

/** The account sub and Gmail message id from a normalized provider message id
 *  (`gmail:<accountSub>:<gmailId>`), or null for any other shape. */
export function parseGmailProviderMessageId(providerMessageId: string): { sub: string; gmailId: string } | null {
  const parts = providerMessageId.split(':');
  if (parts.length !== 3 || parts[0] !== 'gmail' || !parts[1] || !parts[2]) return null;
  return { sub: parts[1], gmailId: parts[2] };
}

export async function markIngestedGmailHandled(
  email: NormalizedInboundEmail,
  generation: MailboxGenerationContext | undefined,
  deps: MarkIngestedDeps = {},
): Promise<'skipped' | 'not_ticketed' | 'marked' | 'failed'> {
  const cfg = gmailHandledConfig();
  if (!cfg.enabled || email.provider !== 'gmail' || generation?.provider !== 'gmail') return 'skipped';
  const parsed = parseGmailProviderMessageId(email.providerMessageId);
  if (!parsed) return 'skipped';
  const { sub, gmailId } = parsed;

  // The SAME generation that authorized ingestion, still connected, still the
  // same Google account: a reconnect to a different account rotates
  // consent_attempt_id / google_account_sub, and that account's mail must never
  // be modified with an id taken from the old one.
  const sameGeneration = and(
    eq(ticketMailboxConnections.id, generation.connectionId),
    eq(ticketMailboxConnections.partnerId, generation.partnerId),
    eq(ticketMailboxConnections.provider, 'gmail'),
    eq(ticketMailboxConnections.status, 'connected'),
    eq(ticketMailboxConnections.consentAttemptId, generation.consentAttemptId),
    eq(ticketMailboxConnections.googleAccountSub, sub),
  );

  let ctx: { saKey: string; mailbox: string } | null = null;
  try {
    ctx = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [log] = await db.select({ parseStatus: ticketEmailInbound.parseStatus })
        .from(ticketEmailInbound)
        .where(and(
          eq(ticketEmailInbound.partnerId, generation.partnerId),
          eq(ticketEmailInbound.providerMessageId, email.providerMessageId),
        ))
        .limit(1);
      if (!log || !TICKETED_STATUSES.has(log.parseStatus)) return null;
      const [conn] = await db.select({
        orgId: ticketMailboxConnections.orgId,
        mailboxAddress: ticketMailboxConnections.mailboxAddress,
      }).from(ticketMailboxConnections)
        .where(sameGeneration)
        .limit(1);
      if (!conn?.orgId || !conn.mailboxAddress) return null;
      const cred = await loadGoogleConnection(conn.orgId);
      if (!cred || cred.status !== 'active') return null;
      return { saKey: decryptConnectionKey(cred), mailbox: conn.mailboxAddress };
    }));
  } catch (err) {
    console.warn('[gmailHandled] lookup failed; message stays in the inbox', {
      connectionId: generation.connectionId, err: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
  if (!ctx) return 'not_ticketed';
  const { saKey, mailbox } = ctx;

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const build = deps.modifyClient ?? getInboundModifyGmailClient;
  for (let attempt = 0; ; attempt++) {
    try {
      // Each attempt re-checks the generation under a FOR SHARE lock held across
      // the Gmail call, so a reconnect (which updates this row) either commits
      // first and this attempt stops, or waits until the call has finished. The
      // call is bounded by GMAIL_REQUEST_TIMEOUT_MS; no lock is held while
      // sleeping between attempts.
      const marked = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        const [live] = await db.select({ id: ticketMailboxConnections.id })
          .from(ticketMailboxConnections)
          .where(sameGeneration)
          .limit(1)
          .for('share');
        if (!live) return false;
        await markGmailHandled(build(saKey, mailbox), mailbox, gmailId, cfg);
        return true;
      }, 'gmailHandled.mark'));
      return marked ? 'marked' : 'not_ticketed';
    } catch (err) {
      const kind = classifyGmailError(err);
      const delay = RETRY_DELAYS_MS[attempt];
      if ((kind === 'rate_limit' || kind === 'transient') && delay !== undefined) {
        await sleep(delay);
        continue;
      }
      console.warn('[gmailHandled] mark-handled failed; message stays in the inbox', {
        connectionId: generation.connectionId, kind, err: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  }
}
