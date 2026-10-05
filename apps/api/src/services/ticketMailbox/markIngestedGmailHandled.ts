/**
 * Opt-in Gmail mark-handled, applied AFTER the inbound pipeline has turned a
 * polled Gmail message into a ticket (created a new one or threaded onto an
 * existing one). Mail the pipeline quarantined, dropped, ignored or failed is
 * never labelled or archived, so the support inbox keeps everything that still
 * needs a human.
 *
 * Per mailbox connection: off unless `ticket_mailbox_connections.gmail_handled_label`
 * is set (edited on the Gmail mailbox settings card). Uses a separate
 * gmail.modify session (the read session stays read-only), retries a
 * rate-limited/transient failure a bounded number of times, and never throws:
 * the ticket already exists, so a failed label is a cosmetic miss (the message
 * stays in the inbox), not lost mail. A failure is recorded on the connection as
 * a fixed code the mailbox card shows, and reported to Sentry when that code
 * changes.
 *
 * No Gmail call runs inside a DB transaction (the #6348 pool-wedge shape). Each
 * attempt reads the generation, settings and credential in one short
 * transaction, closes it, and only then talks to Gmail. A reconnect to another
 * account in between is caught by reading the account sub through the same
 * token that modifies.
 */
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tightenLockTimeout, tightenStatementTimeout } from '../../db/lockTimeout';
import { googleWorkspaceConnections, ticketEmailInbound, ticketMailboxConnections } from '../../db/schema';
import type { NormalizedInboundEmail } from '../inboundEmail/types';
import type { MailboxGenerationContext } from '../inboundEmailQueue';
import { decryptConnectionKey } from '../googleHelpers';
import { getInboundModifyGmailClient, type InboundMailboxSession } from '../googleClient';
import { captureException } from '../sentry';
import { classifyGmailError, markGmailHandled } from './googleMailboxClient';
import { HandledLabelError, isUsableHandledLabelName } from './handledLabel';

const TICKETED_STATUSES = new Set(['created', 'matched']);
const RETRY_DELAYS_MS = [500, 2000];
/** Hard deadline for the whole mark operation, retries included: every Gmail
 *  request of an attempt is aborted when it passes, and no attempt starts after. */
const MARK_BUDGET_MS = 15_000;
/** How long the resolved label id is cached per account and mailbox. */
export const HANDLED_LABEL_CACHE_TTL_MS = 10 * 60 * 1000;
/** A repeated identical failure refreshes gmail_handled_error_at at most this often,
 *  so a mailbox that fails on every message does not write once per message. */
const ERROR_REFRESH_MS = 10 * 60 * 1000;

/** Fixed failure codes stored on the connection (CHECK-constrained in the DB). */
export const GMAIL_HANDLED_ERROR_CODES = ['access_denied', 'rate_limited', 'unavailable', 'label_invalid', 'failed'] as const;
export type GmailHandledErrorCode = typeof GMAIL_HANDLED_ERROR_CODES[number];

/**
 * - skipped: not a Gmail generation-bound message, or the mailbox has no label set
 * - not_ticketed: the pipeline did not create or match a ticket for it
 * - stale: the mailbox was disconnected, reconnected or now resolves to another account
 * - no_credential: the org's Google Workspace credential is missing or inactive
 * - marked / failed
 */
export type MarkIngestedResult = 'skipped' | 'not_ticketed' | 'stale' | 'no_credential' | 'marked' | 'failed';

export interface MarkIngestedDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test hook: override MARK_BUDGET_MS. */
  budgetMs?: number;
  modifyClient?: (saKey: string, mailbox: string, signal?: AbortSignal) => InboundMailboxSession;
}

/** The account sub and Gmail message id from a normalized provider message id
 *  (`gmail:<accountSub>:<gmailId>`), or null for any other shape. */
export function parseGmailProviderMessageId(providerMessageId: string): { sub: string; gmailId: string } | null {
  const parts = providerMessageId.split(':');
  if (parts.length !== 3 || parts[0] !== 'gmail' || !parts[1] || !parts[2]) return null;
  return { sub: parts[1], gmailId: parts[2] };
}

/** SET LOCAL lock and statement timeouts for this transaction (never widening a
 *  stricter caller), so a blocked lock or slow statement fails at the deadline. */
async function boundDbWaits(ms: number): Promise<void> {
  const bound = Math.max(1, Math.floor(ms));
  await tightenLockTimeout(db, bound);
  await tightenStatementTimeout(db, bound);
}

/** Map a marking error to the code stored on the connection. */
export function handledErrorCode(err: unknown): GmailHandledErrorCode {
  if (err instanceof HandledLabelError) return 'label_invalid';
  switch (classifyGmailError(err)) {
    case 'reauth': return 'access_denied';
    case 'rate_limit': return 'rate_limited';
    case 'transient': return 'unavailable';
    default: return 'failed';
  }
}

type MarkContext =
  | { kind: 'stale' | 'skipped' | 'not_ticketed' | 'no_credential' }
  | {
    kind: 'ready';
    mailboxAddress: string;
    labelName: string;
    archive: boolean;
    priorError: string | null;
    saKey: string;
  };

export async function markIngestedGmailHandled(
  email: NormalizedInboundEmail,
  generation: MailboxGenerationContext | undefined,
  deps: MarkIngestedDeps = {},
): Promise<MarkIngestedResult> {
  // The deadline covers the whole operation, from the first DB read on.
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetMs = deps.budgetMs ?? MARK_BUDGET_MS;
  const remainingMs = () => budgetMs - (now() - startedAt);
  if (email.provider !== 'gmail' || generation?.provider !== 'gmail') return 'skipped';
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
  // Result bookkeeping targets the same row and generation only, so a reconnect
  // in between never inherits a result from the previous binding.
  const sameRowAndGeneration = and(
    eq(ticketMailboxConnections.id, generation.connectionId),
    eq(ticketMailboxConnections.partnerId, generation.partnerId),
    eq(ticketMailboxConnections.consentAttemptId, generation.consentAttemptId),
  );

  // One short transaction, plain reads, no row locks; closed before any Gmail call.
  const loadContext = (deadlineMs: number): Promise<MarkContext> =>
    runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await boundDbWaits(deadlineMs);
      const [live] = await db.select({
        orgId: ticketMailboxConnections.orgId,
        mailboxAddress: ticketMailboxConnections.mailboxAddress,
        labelName: ticketMailboxConnections.gmailHandledLabel,
        archive: ticketMailboxConnections.gmailArchiveOnHandle,
        priorError: ticketMailboxConnections.gmailHandledError,
      })
        .from(ticketMailboxConnections)
        .where(sameGeneration)
        .limit(1);
      if (!live?.orgId || !live.mailboxAddress) return { kind: 'stale' };
      if (!live.labelName) return { kind: 'skipped' };
      const [log] = await db.select({ parseStatus: ticketEmailInbound.parseStatus })
        .from(ticketEmailInbound)
        .where(and(
          eq(ticketEmailInbound.partnerId, generation.partnerId),
          eq(ticketEmailInbound.providerMessageId, email.providerMessageId),
        ))
        .limit(1);
      if (!log || !TICKETED_STATUSES.has(log.parseStatus)) return { kind: 'not_ticketed' };
      const [cred] = await db.select()
        .from(googleWorkspaceConnections)
        .where(eq(googleWorkspaceConnections.orgId, live.orgId))
        .limit(1);
      if (!cred || cred.status !== 'active') return { kind: 'no_credential' };
      return {
        kind: 'ready',
        mailboxAddress: live.mailboxAddress,
        labelName: live.labelName,
        archive: live.archive,
        priorError: live.priorError,
        saKey: decryptConnectionKey(cred),
      };
    }, 'gmailHandled.load'));

  const recordFailure = async (code: GmailHandledErrorCode, priorError: string | null, err: unknown) => {
    console.warn('[gmailHandled] mark-handled failed; message stays in the inbox', {
      connectionId: generation.connectionId, code, err: err instanceof Error ? err.message : String(err),
    });
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        await boundDbWaits(Math.max(remainingMs(), 2_000));
        const at = new Date();
        await db.update(ticketMailboxConnections)
          .set({ gmailHandledError: code, gmailHandledErrorAt: at })
          .where(and(
            sameRowAndGeneration,
            or(
              sql`${ticketMailboxConnections.gmailHandledError} IS DISTINCT FROM ${code}`,
              sql`${ticketMailboxConnections.gmailHandledErrorAt} IS NULL`,
              lt(ticketMailboxConnections.gmailHandledErrorAt, new Date(at.getTime() - ERROR_REFRESH_MS)),
            ),
          ));
      }, 'gmailHandled.recordFailure'));
    } catch (dbErr) {
      console.warn('[gmailHandled] could not record the failure on the connection', {
        connectionId: generation.connectionId, err: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    // Sentry once per change of failure code, not once per message.
    if (priorError !== code) {
      captureException(err, undefined, { component: 'gmailHandled', code }, { fingerprint: ['gmail-handled', code] });
    }
  };

  const clearFailure = async () => {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        await boundDbWaits(Math.max(remainingMs(), 2_000));
        await db.update(ticketMailboxConnections)
          .set({ gmailHandledError: null, gmailHandledErrorAt: null })
          .where(and(sameRowAndGeneration, isNotNull(ticketMailboxConnections.gmailHandledError)));
      }, 'gmailHandled.clearFailure'));
    } catch (dbErr) {
      console.warn('[gmailHandled] could not clear the recorded failure', {
        connectionId: generation.connectionId, err: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
  };

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const build = deps.modifyClient ?? getInboundModifyGmailClient;
  let priorError: string | null = null;
  for (let attempt = 0; ; attempt++) {
    const remaining = remainingMs();
    if (remaining <= 0) {
      await recordFailure('unavailable', priorError, new Error('mark-handled deadline reached'));
      return 'failed';
    }
    let ctx: MarkContext;
    try {
      // Re-read on every attempt: a disconnect, reconnect, settings change or
      // credential replacement since the last attempt takes effect here.
      ctx = await loadContext(remaining);
    } catch (err) {
      console.warn('[gmailHandled] lookup failed; message stays in the inbox', {
        connectionId: generation.connectionId, err: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
    if (ctx.kind !== 'ready') return ctx.kind;
    priorError = ctx.priorError;
    if (!isUsableHandledLabelName(ctx.labelName)) {
      await recordFailure('label_invalid', priorError, new HandledLabelError('stored label name is not a usable user label'));
      return 'failed';
    }

    try {
      // No transaction is open here. Prove through the SAME token that will
      // modify that the mailbox is still the account the message came from.
      const session = build(ctx.saKey, ctx.mailboxAddress, AbortSignal.timeout(remaining));
      const liveSub = (await session.identity()).sub;
      if (liveSub !== sub) {
        console.warn('[gmailHandled] mailbox now resolves to a different Google account; not modifying', {
          connectionId: generation.connectionId,
        });
        return 'stale';
      }
      await markGmailHandled(session.gmail, ctx.mailboxAddress, gmailId, {
        accountSub: sub,
        labelName: ctx.labelName,
        archive: ctx.archive,
        labelCacheTtlMs: HANDLED_LABEL_CACHE_TTL_MS,
      });
      if (priorError) await clearFailure();
      return 'marked';
    } catch (err) {
      const code = handledErrorCode(err);
      const delay = RETRY_DELAYS_MS[attempt];
      // Retries stop once the deadline would pass.
      if ((code === 'rate_limited' || code === 'unavailable') && delay !== undefined && delay < remainingMs()) {
        await sleep(delay);
        continue;
      }
      await recordFailure(code, priorError, err);
      return 'failed';
    }
  }
}
