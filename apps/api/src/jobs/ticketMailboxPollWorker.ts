import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  isConnectedMailboxSnapshotCurrent,
  listConnectedMailboxes,
  updateDeltaCursor,
  resetDeltaCursor,
  setConnectedMailboxStatus,
  listConnectedGmailMailboxes,
  isConnectedGmailMailboxCurrent,
  getConnectedGmailMailboxOrgId,
  seedGmailCursor,
  updateHistoryCursor,
  setGmailMailboxStatus,
  type ConnectedGmailMailbox,
  type GmailMailboxSnapshot,
} from '../services/ticketMailbox/connectionService';
import { getMailboxToken } from '../services/ticketMailbox/mailboxToken';
import { listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { normalizeGraphMessage } from '../services/ticketMailbox/normalizeGraphMessage';
import {
  getStartHistoryId,
  listInboxChanges,
  forEachInboxPageSince,
  getFullMessage,
  classifyGmailError,
  GmailHistoryExpiredError,
} from '../services/ticketMailbox/googleMailboxClient';
import { normalizeGmailMessage, isAddressedToMailbox } from '../services/ticketMailbox/normalizeGmailMessage';
import { getInboundMailboxSession } from '../services/googleClient';
import type { gmail_v1 } from '@googleapis/gmail';
import { loadGoogleConnection, decryptConnectionKey } from '../services/googleHelpers';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'ticket-mailbox-poll';
const SWEEP_INTERVAL_MS = 90 * 1000;
const SWEEP_JOB_ID = 'ticket-mailbox-poll-sweep';

type SweepJobData = { type: 'sweep' };

/** Process one mailbox end-to-end. Graph I/O runs outside any DB context. */
async function sweepOne(c: Awaited<ReturnType<typeof listConnectedMailboxes>>[number]): Promise<void> {
  if (!c.tenantId) return;

  let page: Awaited<ReturnType<typeof listInboxDelta>>;
  try {
    const token = await getMailboxToken(c.tenantId);
    page = await listInboxDelta(token, c.mailboxAddress, c.deltaLink);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 410) {
      await resetDeltaCursor(c);
      console.warn('[mailboxPoll] delta token gone (410); cursor reset', { id: c.id });
      return;
    }

    const next = status === 401 || status === 403 ? 'reauth_required' : 'error';
    // Raw, unsanitized text (do not prefix with MAILBOX_VERIFICATION_FAILED,
    // 'Mailbox verification failed' — connectionService.ts's listMailboxConnections
    // only exposes lastError to the client when it has that exact prefix, to
    // keep this poller's error text server-side-only; #6192).
    await setConnectedMailboxStatus(
      c,
      next,
      err instanceof Error ? err.message : 'poll failed',
    );
    return;
  }

  let lastMessageAt: Date | null = null;
  try {
    const token = await getMailboxToken(c.tenantId);
    // Graph I/O may outlive a reconnect/disable. Revalidate the exact generation
    // immediately before producing any external side effects.
    if (!await isConnectedMailboxSnapshotCurrent(c)) return;
    for (const msg of page.messages) {
      const normalized = normalizeGraphMessage(msg, c.partnerId, c.mailboxAddress);
      await enqueueInboundEmail(normalized, {
        provider: 'm365',
        connectionId: c.id,
        partnerId: c.partnerId,
        tenantId: c.tenantId,
        consentAttemptId: c.consentAttemptId,
      });
      // Enqueue can overlap a lifecycle disable/re-consent. Recheck the exact
      // generation immediately before the irreversible Microsoft markRead side
      // effect. A stale result also stops this page so no later message or cursor
      // can be produced from the obsolete snapshot.
      if (!await isConnectedMailboxSnapshotCurrent(c)) return;
      await markRead(token, c.mailboxAddress, msg.id).catch((e) => {
        console.warn('[mailboxPoll] mark-read failed', { id: msg.id, err: e instanceof Error ? e.message : e });
      });
      if (msg.receivedDateTime) lastMessageAt = new Date(msg.receivedDateTime);
    }
  } catch (err) {
    console.error('[mailboxPoll] enqueue failed; cursor not advanced', {
      id: c.id,
      err: err instanceof Error ? err.message : err,
    });
    return;
  }

  if (page.deltaLink) {
    const polledAt = new Date();
    await updateDeltaCursor(c, page.deltaLink, polledAt, lastMessageAt ?? polledAt);
  }
}

/** Exported for tests. Reads connections in system context, processes each independently. */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Process one connected Gmail mailbox. Reads via the org's domain-wide-delegation
 * service account (google_workspace_connections), impersonating the mailbox
 * address; this sweep only READS (the granted scope is gmail.readonly — see
 * googleMailboxClient). googleAccountSub holds the
 * mailbox's immutable Google account sub (captured at connect) and namespaces the
 * dedup key, so an email/alias change does not fracture dedup. Identity is
 * re-verified on EVERY sweep (session.identity().sub vs the stored sub) before any
 * read, so a mid-connected reassignment to a different account is caught here, and
 * a same-Workspace org merge can be a plain repoint instead of a forced reauth.
 */
async function sweepOneGmail(c: ConnectedGmailMailbox): Promise<void> {
  const snapshot = { id: c.id, partnerId: c.partnerId, consentAttemptId: c.consentAttemptId };

  let saKey: string;
  try {
    // google_workspace_connections has forced org RLS; the sweep runs with no
    // ambient DB context, so load the credential inside an explicit system
    // context (as the connectionService helpers do) or the row is invisible and
    // a healthy mailbox would be wrongly marked reauth_required.
    const conn = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => loadGoogleConnection(c.orgId)),
    );
    if (!conn || conn.status !== 'active') {
      // Guard the org-merge race: the credential was loaded by the org captured at
      // enumeration (c.orgId). An org merge repoints this connection's org and
      // drops the loser's Google credential (keep-survivor), so a merge committing
      // between enumeration and now leaves c.orgId's credential legitimately gone
      // while the row is healthy under the survivor. Re-read the row's CURRENT org;
      // if it changed (or the row moved out of this generation), skip this sweep so
      // the next one loads the survivor credential — do NOT falsely mark a healthy
      // mailbox reauth_required (setGmailMailboxStatus's predicate ignores org and
      // would otherwise clobber the repointed row).
      const currentOrgId = await getConnectedGmailMailboxOrgId(snapshot);
      if (currentOrgId !== c.orgId) return;
      await setGmailMailboxStatus(snapshot, 'reauth_required', 'google workspace connection missing or inactive');
      return;
    }
    saKey = decryptConnectionKey(conn);
  } catch (err) {
    // A missing/inactive credential is handled above (reauth_required). Reaching
    // here means the credential READ or decrypt threw — most often a transient DB
    // hiccup. Do NOT stamp a terminal 'error' (that status is excluded from the
    // next sweep, so a blip would permanently stop this mailbox until manual
    // intervention). Log and leave the mailbox 'connected' so the next sweep
    // retries; a persistent fault keeps surfacing here rather than going silent.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error('[mailboxPoll] gmail credential load failed; will retry next sweep', { id: c.id });
    return;
  }

  // ONE session for this sweep: verify identity and do every read through it, so
  // the account check and the mail it reads are bound to the same token.
  const session = getInboundMailboxSession(saKey, c.mailboxAddress);

  // Verify the mailbox STILL resolves to the same Google account before ingesting
  // anything. An org merge repoints org_id (and thus which credential this sweep
  // loads), and an address can be reassigned to a different account. Comparing the
  // live sub to the stored one on every sweep is the safety gate that lets the merge
  // be a plain repoint (no forced reauth, so in-flight mail is not dropped): a
  // same-account merge keeps polling seamlessly, a different account is caught here.
  let liveSub: string;
  try {
    liveSub = (await session.identity()).sub;
  } catch (err) {
    const kind = classifyGmailError(err);
    if (kind === 'reauth') await setGmailMailboxStatus(snapshot, 'reauth_required', errMsg(err));
    else if (kind === 'fatal') await setGmailMailboxStatus(snapshot, 'error', errMsg(err));
    // rate_limit / transient: leave connected, retry next sweep.
    return;
  }
  if (liveSub !== c.googleAccountSub) {
    await setGmailMailboxStatus(snapshot, 'reauth_required', 'the Google account behind this mailbox changed; reconnect required');
    return;
  }

  // No cursor yet: establish the eligibility floor (connect time) and the
  // baseline history cursor, then process nothing this tick ("new mail from now").
  if (!c.historyId) {
    try {
      const startId = await getStartHistoryId(session.gmail);
      await seedGmailCursor(snapshot, startId, new Date());
    } catch (err) {
      const kind = classifyGmailError(err);
      if (kind === 'reauth') await setGmailMailboxStatus(snapshot, 'reauth_required', errMsg(err));
      else if (kind === 'fatal') await setGmailMailboxStatus(snapshot, 'error', errMsg(err));
      // rate_limit / transient: leave connected, retry next sweep.
    }
    return;
  }

  let changes: Awaited<ReturnType<typeof listInboxChanges>>;
  try {
    changes = await listInboxChanges(session.gmail, c.historyId);
  } catch (err) {
    if (err instanceof GmailHistoryExpiredError) {
      // Cursor too old to serve. Do NOT resume at "now" (that silently skips the
      // gap). Reconcile: enumerate INBOX since the eligibility floor and ingest
      // (durable dedup drops anything already ticketed), then commit a fresh
      // cursor. Mail that arrived AND left the inbox during the gap is not
      // recoverable and is not backfilled (documented, best-effort).
      await reconcileGmailAfterExpiry(c, snapshot, session.gmail);
      return;
    }
    const kind = classifyGmailError(err);
    if (kind === 'reauth') await setGmailMailboxStatus(snapshot, 'reauth_required', errMsg(err));
    else if (kind === 'fatal') await setGmailMailboxStatus(snapshot, 'error', errMsg(err));
    // rate_limit / transient: cursor NOT advanced, retried next tick.
    return;
  }

  const lastMessageAt = await ingestGmailIds(c, snapshot, session.gmail, changes.messageIds);
  if (lastMessageAt === ABORTED) return;

  // Advance the cursor ONLY after the page's messages are durably enqueued, and
  // only if it is still at the value this sweep started from (compare-and-swap) so
  // an overlapping slow sweep cannot move it backward.
  if (changes.newHistoryId) {
    await updateHistoryCursor(snapshot, c.historyId, changes.newHistoryId, new Date(), lastMessageAt);
  }
}

/** Sentinel: the generation changed mid-ingest, so stop without advancing. */
const ABORTED = Symbol('aborted');

/** Fetch, normalize, and enqueue a set of Gmail message ids under the connection's
 * generation. Rechecks the generation before every enqueue. Returns the newest
 * message timestamp seen, or ABORTED if the generation went stale.
 *
 * No-loss policy: the cursor advances only after the whole page is durably enqueued
 * (see the callers). We do NOT silently skip a message that fails to fetch — that
 * would advance the cursor past mail that was never recorded anywhere and lose it.
 * getFullMessage returns null for a 404 (deleted between listing and fetch — a real
 * race, correctly skipped); any other error propagates, aborting the page so the
 * cursor stays put and the next sweep retries. normalizeGmailMessage is total (it
 * never throws — malformed parts degrade to best-effort), so a weird message still
 * ingests rather than wedging the mailbox. A persistent non-404 fetch error is a
 * genuine Gmail anomaly on that message: it blocks that one mailbox (surfaced via
 * the sweep's captureException) rather than dropping a customer email — matching the
 * m365 path. A durable per-message dead-letter/replay ledger is the future
 * enhancement that would let such a message be set aside without blocking.
 *
 * The eligibility floor (the connection's `eligibleAfter`, the connect instant)
 * applies on BOTH paths: a message whose Gmail receipt time predates it is
 * pre-connection mail and is never ticketed. On the incremental path that is a
 * labelAdded(INBOX) change on an old message (e.g. an old thread moved back into
 * the inbox); on the recovery path the query is one second wide (see
 * listInboxMessageIdsSince). `minInternalDateMs` overrides the floor when given. */
async function ingestGmailIds(
  c: ConnectedGmailMailbox,
  snapshot: GmailMailboxSnapshot,
  gmail: gmail_v1.Gmail,
  ids: string[],
  minInternalDateMs?: number,
): Promise<Date | null | typeof ABORTED> {
  let lastMessageAt: Date | null = null;
  const floorMs = minInternalDateMs ?? c.eligibleAfter?.getTime() ?? null;
  if (!await isConnectedGmailMailboxCurrent(snapshot)) return ABORTED;
  for (const id of ids) {
    const msg = await getFullMessage(gmail, id);
    if (!msg) continue; // deleted between listing and fetch — a normal race
    // Pre-connection mail is never ticketed, whichever path surfaced it.
    if (floorMs != null && msg.internalDate != null
        && Number(msg.internalDate) < floorMs) continue;
    // Ingestion scope (decision A): ticket ONLY mail delivered to the support
    // mailbox per the MTA-stamped Delivered-To. history.list returns the whole INBOX
    // with no recipient filter, and the mailbox may be an alias on a personal/shared
    // account, so enqueueing everything would turn that account's unrelated mail into
    // tickets. A non-recipient message is deliberately left in the inbox (not an
    // error, not lost) and the cursor advances past it. Every skip is logged for
    // observability. Gmail's Delivered-To carries the exact delivered address — the
    // ALIAS for alias mail, the PRIMARY for direct mail (live-verified against
    // support-primary@example.com, 2026-09-22) — so alias mail is captured, not skipped.
    if (!isAddressedToMailbox(msg.payload?.headers ?? undefined, c.mailboxAddress)) {
      // Observability only. Do NOT log the message's recipient/correspondent headers
      // (Delivered-To / To / X-Original-To): when the support alias shares a mailbox
      // with someone's personal mail, those are third-party addresses that must not be
      // exported to centralized application logs. The connection id + Gmail message id
      // are enough to investigate a wrongly-filtered message (fetch it out-of-band).
      console.info('[mailboxPoll] gmail message skipped: not delivered to the support mailbox', {
        id: c.id,
        messageId: id,
      });
      continue;
    }
    const normalized = normalizeGmailMessage(msg, c.partnerId, c.mailboxAddress, c.googleAccountSub);
    // Revalidate the generation immediately before the enqueue side effect.
    if (!await isConnectedGmailMailboxCurrent(snapshot)) return ABORTED;
    await enqueueInboundEmail(normalized, {
      provider: 'gmail',
      connectionId: c.id,
      partnerId: c.partnerId,
      tenantId: null,
      consentAttemptId: c.consentAttemptId,
    });
    // Track the NEWEST timestamp, not the last one enumerated: Gmail's
    // messages.list (recovery path) does not guarantee ascending internalDate
    // order, so a plain assignment could move last_message_at backward.
    if (msg.internalDate) {
      const ts = new Date(Number(msg.internalDate));
      if (!lastMessageAt || ts > lastMessageAt) lastMessageAt = ts;
    }
  }
  return lastMessageAt;
}

/** Recovery after an expired history cursor: capture a fresh baseline FIRST, then
 * enumerate INBOX since the eligibility floor and ingest, then commit the baseline.
 * Capturing the baseline before enumeration means any mail arriving during
 * enumeration is caught by the next incremental sweep (durable dedup absorbs the
 * small overlap). */
async function reconcileGmailAfterExpiry(
  c: ConnectedGmailMailbox,
  snapshot: GmailMailboxSnapshot,
  gmail: gmail_v1.Gmail,
): Promise<void> {
  // Without a durable floor we cannot bound recovery: searching "from now" would
  // permanently skip mail already in the inbox, and enumerating everything would
  // import the whole historical inbox as tickets. A seeded connection always has
  // a floor; if it is somehow absent, STOP without advancing (leave the cursor
  // expired) so the next sweep retries rather than losing mail.
  if (!c.eligibleAfter) {
    console.warn('[mailboxPoll] gmail history expired but no eligibility floor; skipping recovery', { id: c.id });
    return;
  }
  try {
    const baseline = await getStartHistoryId(gmail);
    const floorSec = Math.floor(c.eligibleAfter.getTime() / 1000);
    const floorMs = c.eligibleAfter.getTime();
    // STREAM the enumeration one page at a time so an expired mailbox with a very
    // large post-floor backlog never accumulates the whole inbox in memory. Each
    // page is ingested and released; the cursor is advanced ONCE after all pages
    // (interruption leaves the expired cursor untouched, so the next sweep replays
    // safely — dedup prevents duplicate tickets).
    let lastMessageAt: Date | null = null;
    let enumerated = 0;
    let aborted = false;
    await forEachInboxPageSince(gmail, floorSec, async (pageIds) => {
      enumerated += pageIds.length;
      // Pass the exact-millisecond floor: the query is widened by 1s so the floor
      // second is never missed, so ingest must drop anything genuinely before the
      // floor (pre-connection mail).
      const r = await ingestGmailIds(c, snapshot, gmail, pageIds, floorMs);
      if (r === ABORTED) { aborted = true; return false; }
      if (r && (!lastMessageAt || r > lastMessageAt)) lastMessageAt = r;
      return true;
    });
    if (aborted) return;
    // CAS against the expired cursor we started from: if a concurrent sweep already
    // recovered and advanced the cursor, this commit matches 0 rows rather than
    // clobbering the newer baseline. c.historyId is non-null here (an expired
    // cursor is what raised GmailHistoryExpiredError to reach this path).
    await updateHistoryCursor(snapshot, c.historyId!, baseline, new Date(), lastMessageAt);
    console.warn('[mailboxPoll] gmail history expired; reconciled', { id: c.id, enumerated });
  } catch (err) {
    const kind = classifyGmailError(err);
    if (kind === 'reauth') await setGmailMailboxStatus(snapshot, 'reauth_required', errMsg(err));
    else if (kind === 'fatal') await setGmailMailboxStatus(snapshot, 'error', errMsg(err));
    // rate_limit / transient: cursor left expired; next sweep retries reconciliation.
  }
}

export async function runMailboxSweep(): Promise<void> {
  const connections = await listConnectedMailboxes();
  for (const c of connections) {
    try {
      await sweepOne(c);
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[mailboxPoll] sweepOne crashed', { id: c.id });
    }
  }

  const gmailConnections = await listConnectedGmailMailboxes();
  // Bounded concurrency: sweeps are independent per mailbox, so a single slow (or
  // timing-out) Google request no longer serially starves every later mailbox — at
  // most GMAIL_SWEEP_CONCURRENCY are in flight and one stuck lane blocks only itself.
  // Kept small so concurrent per-sweep DB contexts stay well under the connection pool.
  await runWithConcurrency(gmailConnections, GMAIL_SWEEP_CONCURRENCY, async (c) => {
    try {
      await sweepOneGmail(c);
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[mailboxPoll] sweepOneGmail crashed', { id: c.id });
    }
  });
}

const GMAIL_SWEEP_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` in flight at once. Each task is
 * self-contained (fn swallows its own errors), so one lane never blocks another. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

let queue: Queue<SweepJobData> | null = null;
let worker: Worker<SweepJobData> | null = null;

export async function initializeTicketMailboxPollWorker(): Promise<void> {
  if (worker) return;

  queue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  await queue.add(
    'sweep',
    { type: 'sweep' },
    {
      jobId: SWEEP_JOB_ID,
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );

  worker = new Worker<SweepJobData>(
    QUEUE_NAME,
    async (_job: Job<SweepJobData>) => {
      await runMailboxSweep();
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
  attachWorkerObservability(worker, 'ticketMailboxPollWorker');

  worker.on('failed', (job, err) => {
    console.error('[mailboxPoll] sweep job failed', { id: job?.id, err: err?.message });
  });
  console.log('[mailboxPoll] worker initialized');
}

export async function shutdownTicketMailboxPollWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
