/**
 * #4248 W03 (spec §3.5, OD-7 B, OD-8 B) — delivers the weekly AI org narrative
 * BY EMAIL to the recipients whose `report_run_deliveries` rows are still
 * `pending`, one recipient at a time, behind a per-recipient live authority
 * gate.
 *
 * The gate, exactly: `resolveLiveReportAuthority(userId, orgId, 'export')`
 * must return `ok` with `scope.kind === 'unrestricted'`. `restricted` AND
 * `legacy_unscoped` both fail — an email attaches full-org data, and an
 * unprovable scope is not an unrestricted one. A transient
 * `unverifiable_scope` leaves the row `pending` with `last_error` recorded so
 * the reconciler retries it; every other refusal is permanent (`failed`).
 * Note that `unverifiable_scope` covers TWO different things (`siteScope.ts`):
 * the resolver genuinely threw (transient, self-healing), **or** the user has
 * more than one active membership row for the org — a data-integrity anomaly
 * that will NOT self-heal on retry. Both are "do not permanently refuse", but
 * a row stuck `pending` forever means the second one; don't chase a network
 * blip.
 *
 * Ordering rules that make this sound (per row):
 *   1. resolve authority + email BEFORE claiming — a refusal must not burn an
 *      attempt;
 *   2. `claimDelivery` — its own committed transaction;
 *   3. `emailReportRun` — OUTSIDE every DB context. This function refuses to
 *      run inside one: a rollback there would erase the claim after the mail
 *      had already left;
 *   4. `settleDelivery` — `sent`, `failed` (provider refused) or `unknown`
 *      (ambiguous: timeout, reset, unclassifiable throw). `unknown` is never
 *      auto-replayed.
 *
 * Recipients who fail the gate keep their in-app notification unchanged — the
 * download route re-verifies the requester's live authority itself. Only the
 * EMAIL is withheld. A run where every recipient is skipped logs a counted,
 * non-failing outcome: silence must be observable.
 *
 * Deliberately NOT the report worker (`'ai_org_narrative'` stays in
 * `WORKER_EXCLUDED_REPORT_TYPES`) and not the notification loop's
 * `inSystemDbContext` block: both call sites are documented in
 * `runFinishedNotify.ts`.
 */

import { eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import { reportRuns, reports } from '../db/schema/reports';
import { users } from '../db/schema/users';
import { getEmailService } from './email';
import { resolveOrgTimezone } from './portal/timezone';
import { loadReportBrandingForOrg } from './reportBranding';
import { emailReportRun } from './reportDelivery';
import {
  claimDelivery,
  listPendingDeliveriesForRun,
  recordTransientGateFailure,
  settleDelivery,
  summarizeDeliveries,
  type DeliveryRow,
  type DeliverySummary,
} from './reportRunDelivery';
import { resolveLiveReportAuthority } from './siteScope';

export interface NarrativeDeliveryContext {
  /** The run's org — every authority check is against THIS org. */
  orgId: string;
}

export interface NarrativeDeliveryResult extends DeliverySummary {
  /** Recipients permanently refused by the gate in this pass. */
  refused: number;
  /** Recipients left retryable in this pass (transient gate failure, no transport). */
  transient: number;
  /** Emails the provider accepted in THIS pass (the run totals above are cumulative). */
  sentNow: number;
}

interface NarrativeArtifact {
  reportRunId: string;
  reportId: string;
  orgId: string;
  reportName: string;
  reportType: string;
  format: string;
  result: { summary?: Record<string, unknown> } | null;
}

function inOwnSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function loadArtifact(reportRunId: string): Promise<NarrativeArtifact | null> {
  const [row] = await inOwnSystemContext(() =>
    db
      .select({
        reportRunId: reportRuns.id,
        reportId: reports.id,
        orgId: reports.orgId,
        reportName: reports.name,
        reportType: reports.type,
        format: reports.format,
        result: reportRuns.result,
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reports.id, reportRuns.reportId))
      .where(eq(reportRuns.id, reportRunId))
      .limit(1),
  );
  return (row as NarrativeArtifact | undefined) ?? null;
}

/**
 * The recipient's address, resolved at SEND time from `users` — it is never
 * stored on the delivery row (see the migration header). `null` when the user
 * row is gone, inactive, or carries no usable address.
 */
async function resolveRecipientEmail(userId: string): Promise<string | null> {
  const [row] = await inOwnSystemContext(() =>
    db
      .select({ email: users.email, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  );
  if (!row || row.status !== 'active') return null;
  const email = typeof row.email === 'string' ? row.email.trim() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * `failed` only when the provider DEFINITELY did not accept the message —
 * the API answered with a refusal, or the transport was never initialised.
 * Everything else (timeouts, resets, hang-ups, an unclassifiable throw) is
 * `unknown`: the mail may or may not have left, and `SendEmailParams` has no
 * idempotency key to make a retry safe.
 */
export function classifySendError(error: unknown): 'failed' | 'unknown' {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|ECONNABORTED|network/i.test(message)) return 'unknown';
  if (/transport is not initialized|config is not initialized/i.test(message)) return 'failed';
  if (/^Resend error:/i.test(message)) return /internal|unavailable|rate.?limit/i.test(message) ? 'unknown' : 'failed';
  // `services/email.ts` throws `Mailgun API error (<status>)` for ANY non-OK
  // response, so a bare 4xx match would swallow 429 — a rate limit is the
  // provider asking us to slow down, not refusing the message, and `failed`
  // is terminal (the reconciler only sweeps pending/claimed). 408 is the same
  // shape. Both stay `unknown` so a human can decide, exactly as the Resend
  // branch above already carves out.
  if (/^Mailgun API error \((?:408|429)\)/i.test(message)) return 'unknown';
  if (/^Mailgun API error \(4\d\d\)/i.test(message)) return 'failed';
  return 'unknown';
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * Attempts every `pending` delivery of `reportRunId` once. Idempotent across
 * passes: a second call finds no pending rows (they are `claimed`/settled) and
 * sends nothing — the unique index plus the pending-only claim, never an
 * in-memory guard.
 */
export async function deliverNarrativeEmails(
  reportRunId: string,
  ctx: NarrativeDeliveryContext,
): Promise<NarrativeDeliveryResult> {
  if (getCurrentDbAccessContext()) {
    throw new Error('deliverNarrativeEmails must run outside any db context: the send must not be inside a transaction');
  }

  let refused = 0;
  let transient = 0;
  let sentNow = 0;
  const pending = await listPendingDeliveriesForRun(reportRunId);
  if (pending.length === 0) {
    return { ...(await summarizeDeliveries(reportRunId)), refused, transient, sentNow };
  }

  // No transport at all: nothing can leave, so nothing is claimed. Every row
  // stays pending and retryable — the exact case a boolean "emailed" stamp
  // gets wrong (emailReportRun returns normally here).
  if (!getEmailService()) {
    console.warn('[narrativeDelivery] email service not configured; leaving deliveries pending', {
      reportRunId, orgId: ctx.orgId, pending: pending.length,
    });
    for (const delivery of pending) {
      await recordTransientGateFailure(delivery.id, 'transport:not_configured');
    }
    transient = pending.length;
    return { ...(await summarizeDeliveries(reportRunId)), refused, transient, sentNow };
  }

  const artifact = await loadArtifact(reportRunId);
  if (!artifact) {
    // The artifact is gone (FK cascade would have removed the rows too, so
    // this is a narrow race). Nothing to send; leave the rows as they are.
    console.warn('[narrativeDelivery] report run no longer exists; nothing to deliver', { reportRunId });
    return { ...(await summarizeDeliveries(reportRunId)), refused, transient, sentNow };
  }
  if (artifact.orgId !== ctx.orgId) {
    // Defence in depth: the caller's org and the artifact's org disagree.
    // Refuse the whole pass rather than gate recipients against the wrong org.
    throw new Error(`narrative delivery org mismatch for report run ${reportRunId}`);
  }

  // Timezone + branding once per run, not per recipient. Branding failure is
  // non-fatal (unbranded), exactly as the scheduled-report worker treats it.
  const timezone = await inOwnSystemContext(() => resolveOrgTimezone(ctx.orgId));
  const branding = await inOwnSystemContext(() => loadReportBrandingForOrg(ctx.orgId)).catch((error) => {
    console.error('[narrativeDelivery] branding load failed; sending unbranded', { reportRunId, error });
    return { name: null, logoDataUrl: null, logoAspect: null };
  });

  // The partner that owns this run's org — the `general` stream's sender
  // (spec §8.2). Once per pass, like the timezone and branding above, and in
  // its OWN system context: deliverNarrativeEmails refuses to run inside a db
  // context, so every read here opens and closes one.
  const [orgRow] = await inOwnSystemContext(() =>
    db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId))
      .limit(1),
  );
  const partnerId = orgRow?.partnerId ?? null;

  for (const delivery of pending) {
    const outcome = await deliverOne(delivery, artifact, ctx.orgId, timezone, branding, partnerId);
    if (outcome === 'refused') refused += 1;
    if (outcome === 'transient') transient += 1;
    if (outcome === 'sent') sentNow += 1;
  }

  const summary = await summarizeDeliveries(reportRunId);
  if (summary.sent === 0 && summary.unknown === 0) {
    console.warn('[narrativeDelivery] all recipients skipped', {
      reportRunId, orgId: ctx.orgId, refused, transient, total: summary.total,
    });
  }
  return { ...summary, refused, transient, sentNow };
}

type OneOutcome = 'sent' | 'refused' | 'transient' | 'lost_claim' | 'failed' | 'unknown';

async function deliverOne(
  delivery: DeliveryRow,
  artifact: NarrativeArtifact,
  orgId: string,
  timezone: string,
  branding: Awaited<ReturnType<typeof loadReportBrandingForOrg>>,
  partnerId: string | null,
): Promise<OneOutcome> {
  const userId = delivery.recipientUserId;

  // 1. Authority and address BEFORE the claim.
  const live = await resolveLiveReportAuthority(userId, orgId, 'export');
  if (!live.ok) {
    if (live.reason === 'unverifiable_scope') {
      // Denied-for-NOW, not denied-forever: leave the row retryable so a
      // transient DB blip does not silently kill a weekly report. See the
      // module docstring — this reason also covers a duplicate-membership
      // anomaly, which stays pending until someone fixes the data.
      await recordTransientGateFailure(delivery.id, `authority:${live.reason}`);
      return 'transient';
    }
    if (!(await claimDelivery(delivery.id))) return 'lost_claim';
    await settleDelivery(delivery.id, { state: 'failed', error: `authority:${live.reason}` });
    return 'refused';
  }
  if (live.authority.scope.kind !== 'unrestricted') {
    // 'restricted' AND 'legacy_unscoped' both fail. legacy_unscoped means the
    // scope is UNPROVABLE, and an unprovable scope is not an unrestricted one.
    // An email attaches full-org data; a site-restricted recipient must not get it.
    if (!(await claimDelivery(delivery.id))) return 'lost_claim';
    await settleDelivery(delivery.id, { state: 'failed', error: 'authority:scope_not_unrestricted' });
    return 'refused';
  }

  const email = await resolveRecipientEmail(userId);
  if (!email) {
    if (!(await claimDelivery(delivery.id))) return 'lost_claim';
    await settleDelivery(delivery.id, { state: 'failed', error: 'authority:no_email' });
    return 'refused';
  }

  // 2. The claim — committed before any network call.
  if (!(await claimDelivery(delivery.id))) return 'lost_claim';

  // 3. The send — outside every DB context (asserted at the top of the pass).
  try {
    await emailReportRun({
      reportName: artifact.reportName,
      reportType: artifact.reportType,
      format: artifact.format,
      recipients: [email],
      rows: [],
      summary: artifact.result?.summary,
      timezone,
      branding,
      partnerId,
    });
  } catch (error) {
    const state = classifySendError(error);
    console.error('[narrativeDelivery] send did not complete', {
      reportRunId: artifact.reportRunId, deliveryId: delivery.id, state, error,
    });
    // 4a. Settle the ambiguity or the refusal.
    await settleDelivery(delivery.id, { state, error: errorText(error) });
    return state;
  }

  // 4b. Settle as sent.
  await settleDelivery(delivery.id, { state: 'sent' });
  return 'sent';
}
