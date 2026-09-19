import { eq, sql } from 'drizzle-orm';
import type { SendingDomainStatusReason } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerSendingDomains, partners } from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLogAsync } from '../auditService';
import { captureException, captureMessage } from '../sentry';
import { ProviderDomainConflictError, ProviderDomainRejectedError, ProviderQuotaExhaustedError } from './provider';
import type { EmailDomainProvider, ProviderDomain, SendingDomainStatus } from './provider';
import { getEmailDomainProvider } from './providerRegistry';
import { sendSendingDomainStatusEmail, type SendingDomainStatusEvent } from './statusMail';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Attempts served at the 2-minute cadence before stepping down (spec §6.2). */
const PENDING_FAST_ATTEMPTS = 5;
/** Attempts served at the 10-minute cadence after that, before going hourly. */
const PENDING_MEDIUM_ATTEMPTS = 6;

/**
 * Row-level poll cadence (spec §6.2). Returned as a DELAY, not an absolute
 * time, so the caller owns `now` and every test can pin it.
 *
 *   pending   2 min x5, then 10 min x6, then hourly until the provider fails it
 *   at_risk   hourly (the provider's own 72 h grace is what ends this state)
 *   verified  every 24 h +/- 10% jitter, PER ROW
 *   failed    hourly, purely so the 72 h `failed_expired` check runs
 *
 * The jitter is the whole reason `verified` is not a daily cron: without it
 * every row verified in the same tick re-checks in the same minute forever,
 * and the fleet re-converges. Same helper shape as
 * `services/m365Sync/cadence.ts`'s `nextSyncAt` — `rng` exists only so a test
 * can pin it.
 */
export function nextCheckDelayMs(
  status: SendingDomainStatus,
  checkAttempts: number,
  rng: () => number = Math.random,
): number {
  switch (status) {
    case 'provisioning':
    case 'removing':
      // Both are "the worker still owes this row an external call". The job's
      // own BullMQ retry is the primary recovery; this is the sweep's backstop.
      return MINUTE_MS;
    case 'pending': {
      const attempts = Math.max(0, Math.trunc(checkAttempts));
      if (attempts < PENDING_FAST_ATTEMPTS) return 2 * MINUTE_MS;
      if (attempts < PENDING_FAST_ATTEMPTS + PENDING_MEDIUM_ATTEMPTS) return 10 * MINUTE_MS;
      return HOUR_MS;
    }
    case 'at_risk':
    case 'failed':
      return HOUR_MS;
    case 'verified': {
      const jitter = 0.9 + rng() * 0.2;
      return Math.round(DAY_MS * jitter);
    }
    case 'suspended':
      // No provider calls at all (spec §6.1); the row is only revisited so an
      // unsuspend that raced the sweep is not stuck behind a stale next_check_at.
      return DAY_MS;
  }
}

/**
 * How long a `failed` row is kept so "Retry" reuses the SAME DNS records
 * (spec §4.3, §6.1). Past it the worker moves the row to `removing` with
 * `failed_expired`, which is also the bound on how long a squatter can hold a
 * name.
 */
export const FAILED_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;

export type SyncOutcome =
  | 'no_provider' | 'not_found' | 'provisioned' | 'provision_failed'
  | 'polled' | 'expired' | 'released' | 'deleted' | 'suspended_noop';

export interface SyncOptions {
  /** The refusal text from a partner-lane send (spec §8.4). Written HERE, never by the send path. */
  lastSendError?: string;
  now?: Date;
  rng?: () => number;
}

type DomainRow = typeof partnerSendingDomains.$inferSelect;
type DomainPatch = Partial<typeof partnerSendingDomains.$inferInsert>;

/** Status changes that earn a notice + an audit row (spec §6.3). */
const MAIL_EVENT: Partial<Record<SendingDomainStatus, SendingDomainStatusEvent>> = {
  verified: 'verified',
  at_risk: 'at_risk',
  failed: 'failed',
  suspended: 'suspended',
};

/**
 * Map a provisioning failure onto a `status_reason` from
 * SENDING_DOMAIN_STATUS_REASONS. W02's adapters throw the two typed classes;
 * anything else is an unclassified provider refusal.
 */
/**
 * The reason to commit a TERMINAL `failed`, or `null` when the error proves
 * nothing about the domain and the attempt should simply be retried.
 *
 * Only a classified provider verdict is terminal. The old version returned
 * `provider_rejected` for everything, so a transient network error told the
 * partner "the provider refused this domain" and never tried again.
 */
function terminalStatusReasonOf(err: unknown): SendingDomainStatusReason | null {
  if (err instanceof ProviderDomainConflictError) return 'provider_conflict';
  if (err instanceof ProviderDomainRejectedError) return 'provider_rejected';
  if (err instanceof ProviderQuotaExhaustedError) return 'quota_exhausted';
  // The classes may not survive a structured-clone round trip through BullMQ,
  // so match by name too — the same defence classifyM365SyncFailure uses.
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'ProviderDomainConflictError') return 'provider_conflict';
  if (name === 'ProviderDomainRejectedError') return 'provider_rejected';
  if (name === 'ProviderQuotaExhaustedError') return 'quota_exhausted';
  return null;
}

/** Spec §5.2, keyed on whether SENDING is usable. An unknown state can never send. */
function mapProviderState(state: ProviderDomain['state']): SendingDomainStatus {
  switch (state) {
    case 'verified': return 'verified';
    case 'at_risk': return 'at_risk';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
    default:
      // `pending` keeps the row unable to send, which is the safe half. The
      // other half is that nobody finds out: an unmapped provider state is a
      // real status the partner can never see, and only reaches us here.
      console.warn(`[SendingDomains] unknown provider state ${String(state)} — treating as pending`);
      captureMessage('email-domain provider reported an unmapped domain state', {
        eventCode: 'sending_domain_provider_state_unknown',
        level: 'warning',
      });
      return 'pending';
  }
}

async function loadRow(domainId: string): Promise<DomainRow | undefined> {
  const found = await db
    .select()
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.id, domainId))
    .limit(1);
  return found[0];
}

async function patchRow(domainId: string, patch: DomainPatch): Promise<void> {
  await db
    .update(partnerSendingDomains)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(partnerSendingDomains.id, domainId));
}

/**
 * The partner's slug, in its own short system transaction. Both the `static`
 * adapter's `createDomain` and its `getDomain` bind their allow-list entry by
 * slug (`domain:partner-slug`), so the same value is needed on the provisioning
 * and the polling path. Read on its own so no connection is held across the
 * provider round trip that follows (#1105).
 */
async function loadPartnerSlug(partnerId: string, label: string): Promise<string | null> {
  return withSystemDbAccessContext(async () => {
    const [p] = await db
      .select({ slug: partners.slug })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    return p?.slug ?? null;
  }, label);
}

/**
 * Commit the status change, its audit row and (after the transaction) its
 * notice. Called only when `next` actually differs from the row's current
 * status — a re-run of the same job must be silent, or a hourly `at_risk` poll
 * would mail the partner every hour.
 */
async function commitTransition(
  row: DomainRow,
  next: SendingDomainStatus,
  reason: string | null,
  extra: DomainPatch,
  now: Date,
  rng?: () => number,
): Promise<void> {
  const changed = row.status !== next;
  const patch: DomainPatch = {
    ...extra,
    status: next,
    statusReason: reason,
    lastCheckedAt: now,
    nextCheckAt: new Date(now.getTime() + nextCheckDelayMs(next, (row.checkAttempts ?? 0) + 1, rng)),
  };
  if (changed) patch.statusChangedAt = now;
  if (next === 'verified' && !row.verifiedAt) patch.verifiedAt = now;

  await withSystemDbAccessContext(async () => {
    await patchRow(row.id, patch);
    if (changed) {
      await createAuditLogAsync({
        orgId: null,
        actorType: 'system',
        actorId: ANONYMOUS_ACTOR_ID,
        action: 'partner_sending_domain.status_changed',
        resourceType: 'partner_sending_domain',
        resourceId: row.id,
        resourceName: row.domain,
        details: { partnerId: row.partnerId, from: row.status, to: next, reason },
        result: 'success',
      });
    }
  }, 'sendingDomainTransition');

  // OUTSIDE the transaction: the notice makes a transport round trip and must
  // never hold a pooled connection (#1105). It also never throws.
  const event = changed ? MAIL_EVENT[next] : undefined;
  if (event) {
    await sendSendingDomainStatusEmail({
      partnerId: row.partnerId,
      domain: row.domain,
      event,
      statusReason: reason,
      createdBy: row.createdBy,
    });
  }
}

/**
 * Provisioning, spec §5.1. The `provision_attempted_at` stamp is committed in
 * its own transaction BEFORE any provider call, and only when it is still null:
 *
 *   - null on entry  -> first attempt; stamp = now
 *   - already set    -> a previous attempt crashed somewhere after the stamp
 *
 * That is the ONLY thing that distinguishes "a domain object we created and
 * then lost" from "a domain object that pre-existed in the account". Re-stamping
 * on every retry would make our own object look older than the attempt and
 * adopt it as `provider_managed = false`, which is the one classification the
 * whole feature must not get wrong: an unmanaged row is never deleted at the
 * provider, so we would leak a domain object forever.
 */
async function provision(
  row: DomainRow,
  provider: EmailDomainProvider,
  now: Date,
  rng?: () => number,
): Promise<SyncOutcome> {
  let attemptedAt = row.provisionAttemptedAt;
  if (!attemptedAt) {
    attemptedAt = now;
    await withSystemDbAccessContext(
      () => patchRow(row.id, { provisionAttemptedAt: attemptedAt! }),
      'sendingDomainProvisionStamp',
    );
  }

  // The `static` allow-list binds entries by SLUG (`domain:partner-slug`,
  // spec §2.1), and W02's `createDomain` takes `partnerSlug` for exactly that
  // (its amendment 4). Read in its own short transaction, so the provider call
  // below still holds no connection.
  const partnerSlug = await loadPartnerSlug(row.partnerId, 'sendingDomainProvisionSlug');

  let found: ProviderDomain | null;
  let managed: boolean;
  try {
    // NO DB context held across these calls.
    found = await provider.findDomainByName(row.domain);
    if (!found) {
      found = await provider.createDomain({
        domain: row.domain,
        region: row.providerRegion ?? undefined,
        partnerRef: row.partnerId,
        partnerSlug,
      });
      managed = true;
    } else {
      // Ambiguity resolves to NOT managed: leaking one provider domain is
      // recoverable, deleting an operator's primary sending domain is not
      // (spec §5.1).
      managed = found.createdAt instanceof Date && found.createdAt.getTime() > attemptedAt.getTime();
    }
  } catch (err) {
    const reason = terminalStatusReasonOf(err);
    if (!reason) {
      // TRANSIENT. `failed` is terminal: it stops the retry cadence and mails
      // the partner that the provider refused their domain. Committing it for a
      // 503, a timeout or an ECONNRESET permanently failed a perfectly good
      // domain on the FIRST attempt and made BullMQ's `attempts: 5` dead code,
      // because the job returned normally instead of throwing. Leave the row in
      // `provisioning` and rethrow so the retry actually happens.
      console.error(`[SendingDomains] provisioning ${row.domain} hit a transient provider failure — retrying:`, err instanceof Error ? err.message : err);
      throw err;
    }
    console.error(`[SendingDomains] provisioning ${row.domain} failed: ${reason}`);
    captureException(err instanceof Error ? err : new Error(String(err)));
    await commitTransition(row, 'failed', reason, {}, now, rng);
    return 'provision_failed';
  }

  const next = mapProviderState(found.state);
  await commitTransition(row, next, null, {
    providerDomainId: found.providerDomainId,
    providerRegion: found.region ?? row.providerRegion,
    providerManaged: managed,
    dnsRecords: found.records,
  }, now, rng);

  // A `static` adapter has verifiesByDns = false and verifies through an
  // accepted test send instead (spec §5.1); asking it to verify is meaningless.
  if (next === 'pending' && provider.verifiesByDns && found.providerDomainId) {
    await provider.requestVerification(found.providerDomainId);
  }
  return 'provisioned';
}

/**
 * Poll one live row. `check_requested_at` newer than `last_checked_at` is the
 * "Check now" signal and asks the provider to re-verify first.
 */
async function poll(
  row: DomainRow,
  provider: EmailDomainProvider,
  now: Date,
  rng?: () => number,
): Promise<SyncOutcome> {
  if (!row.providerDomainId && provider.verifiesByDns) {
    // A DNS-verifying row with no provider object never got provisioned —
    // send it back round rather than calling getDomain(null).
    await commitTransition(row, 'provisioning', row.statusReason, {}, now, rng);
    return 'polled';
  }

  const requested = row.checkRequestedAt?.getTime() ?? 0;
  const checked = row.lastCheckedAt?.getTime() ?? 0;
  if (requested > checked && provider.verifiesByDns && row.providerDomainId) {
    await provider.requestVerification(row.providerDomainId);
  }

  // `static` has no provider object, so its key is the DOMAIN NAME
  // (W02 amendment 5); every other adapter takes its provider domain id. The
  // slug goes with it because a `static` entry is bound as `domain:partner-slug`
  // — without it a domain RE-BOUND to a different partner would keep reporting
  // as listed for the old one. `resend` and `fake` ignore the option, so the
  // lookup is skipped entirely for a DNS-verifying adapter.
  const partnerSlug = provider.verifiesByDns
    ? null
    : await loadPartnerSlug(row.partnerId, 'sendingDomainPollSlug');
  const observed = await provider.getDomain(row.providerDomainId ?? row.domain, { partnerSlug });

  let next = mapProviderState(observed.state);
  if (!provider.verifiesByDns && next === 'pending') {
    // W02 amendment 5, and it is load-bearing: a `static` adapter reports
    // `pending` for "still listed in EMAIL_DOMAINS_STATIC_ALLOWED" and NEVER
    // `verified` — only an accepted test send moves a static row to verified
    // (spec §5.1). Taking `pending` at face value would demote every verified
    // static domain on the daily re-check and silently stop the operator's mail.
    // `failed` (the operator delisted it) is the only state that acts here.
    next = row.status as SendingDomainStatus;
  }
  const reason = next === 'at_risk' ? 'dns_removed'
    : next === 'failed' ? (provider.verifiesByDns
        ? (row.status === 'pending' ? 'dns_not_detected' : 'provider_rejected')
        : 'provider_rejected')
    : row.status === next ? row.statusReason
    : null;

  await commitTransition(row, next, reason, {
    checkAttempts: (row.checkAttempts ?? 0) + 1,
    dnsRecords: observed.records.length > 0 ? observed.records : row.dnsRecords,
    providerRegion: observed.region ?? row.providerRegion,
  }, now, rng);
  return 'polled';
}

/**
 * `removing`, spec §6.1 + §3.5. The order is load-bearing and W02's
 * `BEFORE DELETE` trigger enforces it: the row cannot be deleted while
 * `provider_domain_id IS NOT NULL`, so a path that forgot to release the
 * provider handle fails loudly instead of leaking it.
 *
 * `provider_managed = false` short-circuits every provider interaction — no
 * `deleteDomain`, and no outbox row either. The provider object pre-existed
 * Breeze (it is typically the operator's primary `EMAIL_FROM` domain) and
 * removing our local row must not touch it (spec §5.1, §13, §14).
 */
async function release(row: DomainRow, provider: EmailDomainProvider): Promise<SyncOutcome> {
  if (row.providerManaged && row.providerDomainId) {
    // 404 is success in the adapter contract; anything else throws and the job
    // retries with the row still in `removing` and its handle intact.
    await provider.deleteDomain(row.providerDomainId);
  }
  await withSystemDbAccessContext(async () => {
    await patchRow(row.id, { providerDomainId: null });
    await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row.id));
  }, 'sendingDomainRelease');
  return 'deleted';
}

/**
 * Advance ONE row ONE step, idempotently. Every provider call sits between two
 * short system-scoped transactions, never inside one (#1105) — the
 * `jobs/ticketOutboxPublisher.ts` phase shape.
 */
export async function syncSendingDomain(domainId: string, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const provider = getEmailDomainProvider();
  if (!provider) return 'no_provider';
  const now = opts.now ?? new Date();

  const row = await withSystemDbAccessContext(async () => {
    const found = await loadRow(domainId);
    if (found && opts.lastSendError) {
      // Recorded here because the send path may be running in a context that
      // cannot write this partner-axis table at all (spec §3.1).
      await patchRow(domainId, { lastSendError: opts.lastSendError.slice(0, 2000), lastSendErrorAt: now });
    }
    return found;
  }, 'sendingDomainLoad');

  if (!row) return 'not_found';

  switch (row.status as SendingDomainStatus) {
    case 'suspended':
      // The kill switch. No provider call of any kind (spec §6.1).
      await withSystemDbAccessContext(
        () => patchRow(row.id, { nextCheckAt: new Date(now.getTime() + nextCheckDelayMs('suspended', 0, opts.rng)) }),
        'sendingDomainSuspendedTouch',
      );
      return 'suspended_noop';

    case 'provisioning':
      return provision(row, provider, now, opts.rng);

    case 'removing':
      return release(row, provider);

    case 'failed': {
      const age = now.getTime() - (row.statusChangedAt?.getTime() ?? now.getTime());
      if (age > FAILED_RETRY_WINDOW_MS) {
        await commitTransition(row, 'removing', 'failed_expired', {}, now, opts.rng);
        await sendSendingDomainStatusEmail({
          partnerId: row.partnerId, domain: row.domain, event: 'auto_removed',
          statusReason: 'failed_expired', createdBy: row.createdBy,
        });
        return 'expired';
      }
      // Inside the window: leave the row (and its DNS records) exactly as they
      // are so "Retry" does not hand the partner a second set of records.
      await withSystemDbAccessContext(
        () => patchRow(row.id, { nextCheckAt: new Date(now.getTime() + nextCheckDelayMs('failed', 0, opts.rng)) }),
        'sendingDomainFailedTouch',
      );
      return 'polled';
    }

    case 'pending':
    case 'verified':
    case 'at_risk':
      return poll(row, provider, now, opts.rng);
  }
}

/**
 * The ONE way a `static` row reaches `verified` (spec §5.1, §6.1).
 *
 * It cannot happen in `poll`: a `static` adapter reports `pending` for "still
 * listed" and never `verified`, and `poll` treats that as no change precisely so
 * a daily re-check cannot demote a working domain. So the worker's `test-send`
 * job calls this after the relay has ACCEPTED a message from the domain, which
 * is the only evidence Breeze can obtain that it may send as it.
 *
 * Returns false — not an error — when it does not apply, so the caller can
 * invoke it unconditionally after a successful test send.
 */
export async function markStaticDomainVerified(domainId: string, now: Date = new Date()): Promise<boolean> {
  const provider = getEmailDomainProvider();
  if (!provider || provider.verifiesByDns) return false;

  const row = await withSystemDbAccessContext(() => loadRow(domainId), 'sendingDomainStaticVerifyLoad');
  if (!row || row.status !== 'pending') return false;

  await commitTransition(row, 'verified', null, {}, now);
  return true;
}
