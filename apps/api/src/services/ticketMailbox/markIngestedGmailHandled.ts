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
import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tightenLockTimeout, tightenStatementTimeout } from '../../db/lockTimeout';
import { googleWorkspaceConnections, ticketEmailInbound, ticketMailboxConnections } from '../../db/schema';
import type { NormalizedInboundEmail } from '../inboundEmail/types';
import type { MailboxGenerationContext } from '../inboundEmailQueue';
import { decryptConnectionKey } from '../googleHelpers';
import { getInboundModifyGmailClient, type InboundMailboxSession } from '../googleClient';
import { classifyGmailError, markGmailHandled } from './googleMailboxClient';
import { gmailHandledConfig } from './gmailHandledConfig';

const TICKETED_STATUSES = new Set(['created', 'matched']);
const RETRY_DELAYS_MS = [500, 2000];
/** Hard deadline for the whole mark operation, retries included: every Gmail
 *  request of an attempt is aborted when it passes, and no attempt starts after. */
const MARK_BUDGET_MS = 15_000;

export interface MarkIngestedDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test hook: override MARK_BUDGET_MS. */
  budgetMs?: number;
  modifyClient?: (saKey: string, mailbox: string, signal?: AbortSignal) => InboundMailboxSession;
}

/** The account sub and Gmail message id from a normalized provider message id
 *  (`gmail:<accountSub>:<gmailId>`), or null for any other shape. */
/** SET LOCAL lock and statement timeouts for this transaction (never widening a
 *  stricter caller), so a blocked lock or slow statement fails at the deadline. */
async function boundDbWaits(ms: number): Promise<void> {
  const bound = Math.max(1, Math.floor(ms));
  await tightenLockTimeout(db, bound);
  await tightenStatementTimeout(db, bound);
}

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
  // The deadline covers the whole operation, from the first DB read on.
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetMs = deps.budgetMs ?? MARK_BUDGET_MS;
  const remainingMs = () => budgetMs - (now() - startedAt);
  const cfg = gmailHandledConfig();
  if (!cfg.enabled || email.provider !== 'gmail' || generation?.provider !== 'gmail') return 'skipped';
  const parsed = parseGmailProviderMessageId(email.providerMessageId);
  if (!parsed) return 'skipped';
  const { sub, gmailId } = parsed;

  // The SAME generation that authorized ingestion, in a status ingestion itself
  // accepts for that generation (inboundEmailService: connected, reauth_required,
  // error), still the same Google account: a reconnect to a different account
  // rotates consent_attempt_id / google_account_sub, and that account's mail must
  // never be modified with an id taken from the old one. Disabled stops marking.
  const sameGeneration = and(
    eq(ticketMailboxConnections.id, generation.connectionId),
    eq(ticketMailboxConnections.partnerId, generation.partnerId),
    eq(ticketMailboxConnections.provider, 'gmail'),
    inArray(ticketMailboxConnections.status, ['connected', 'reauth_required', 'error']),
    eq(ticketMailboxConnections.consentAttemptId, generation.consentAttemptId),
    eq(ticketMailboxConnections.googleAccountSub, sub),
  );

  let ticketed = false;
  try {
    ticketed = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await boundDbWaits(remainingMs());
      const [log] = await db.select({ parseStatus: ticketEmailInbound.parseStatus })
        .from(ticketEmailInbound)
        .where(and(
          eq(ticketEmailInbound.partnerId, generation.partnerId),
          eq(ticketEmailInbound.providerMessageId, email.providerMessageId),
        ))
        .limit(1);
      return !!log && TICKETED_STATUSES.has(log.parseStatus);
    }));
  } catch (err) {
    console.warn('[gmailHandled] lookup failed; message stays in the inbox', {
      connectionId: generation.connectionId, err: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
  if (!ticketed) return 'not_ticketed';

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const build = deps.modifyClient ?? getInboundModifyGmailClient;
  for (let attempt = 0; ; attempt++) {
    const remaining = remainingMs();
    if (remaining <= 0) {
      console.warn('[gmailHandled] mark-handled deadline reached; message stays in the inbox', { connectionId: generation.connectionId });
      return 'failed';
    }
    try {
      // Each attempt re-checks the generation AND re-reads the org credential
      // under FOR SHARE locks held across the Gmail calls: a reconnect or an
      // in-place credential replacement (both update these rows) either commits
      // first, so this attempt uses the current state, or waits until the calls
      // have finished. Each call is bounded by GMAIL_MODIFY_REQUEST_TIMEOUT_MS;
      // no lock is held while sleeping between attempts.
      const marked = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        // DB waits (row locks, statements) are bounded by the same deadline.
        await boundDbWaits(remaining);
        const [live] = await db.select({
          orgId: ticketMailboxConnections.orgId,
          mailboxAddress: ticketMailboxConnections.mailboxAddress,
        })
          .from(ticketMailboxConnections)
          .where(sameGeneration)
          .limit(1)
          .for('share');
        if (!live?.orgId || !live.mailboxAddress) return false;
        const [cred] = await db.select()
          .from(googleWorkspaceConnections)
          .where(eq(googleWorkspaceConnections.orgId, live.orgId))
          .limit(1)
          .for('share');
        if (!cred || cred.status !== 'active') return false;
        // Prove through the SAME token that will modify that the mailbox is
        // still the account the message came from.
        const session = build(decryptConnectionKey(cred), live.mailboxAddress, AbortSignal.timeout(remaining));
        const liveSub = (await session.identity()).sub;
        if (liveSub !== sub) {
          console.warn('[gmailHandled] mailbox now resolves to a different Google account; not modifying', {
            connectionId: generation.connectionId,
          });
          return false;
        }
        await markGmailHandled(session.gmail, live.mailboxAddress, gmailId, { ...cfg, accountSub: sub });
        return true;
      }, 'gmailHandled.mark'));
      return marked ? 'marked' : 'not_ticketed';
    } catch (err) {
      const kind = classifyGmailError(err);
      const delay = RETRY_DELAYS_MS[attempt];
      // Retries stop once the deadline would pass.
      if ((kind === 'rate_limit' || kind === 'transient') && delay !== undefined && delay < remainingMs()) {
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
