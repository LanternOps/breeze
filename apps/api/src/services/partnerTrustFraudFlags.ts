/**
 * Billing fraud flags → partner restriction (billing#51).
 *
 * breeze-billing (one instance per region) decides that a partner must be
 * restricted and publishes that verdict as a "billing fraud flag" on its
 * internal feed. Core never interprets the flag: it restricts the named
 * partner with the flag's restrict reason, from `trusted` or `probation`,
 * records what it did in `partner_billing_fraud_flags`, alerts the operator,
 * and only then consumes the flag.
 *
 * Retry safety:
 *  - The ledger row of a `restricted` outcome is written in the SAME
 *    transaction as the trust-state CAS (setTrustState's withinWrite), so a
 *    restriction can never land without its ledger row, and vice versa.
 *  - The flag is consumed only after that transaction committed. A crash or a
 *    consume failure leaves the flag pending; the next run finds its ledger
 *    row, finishes any post-commit effects, and consumes it with the recorded
 *    outcome. Nothing is restricted twice.
 *  - The non-restricting outcomes are classified under a row lock on the
 *    partner, so they serialize with a concurrent admin restore.
 *
 * Restore: a platform admin returns the partner to the trust state it had
 * before the restriction. The restore is bound to that exact trust transition
 * (trust_changed_at) and to the exact set of ledger rows the admin saw, and it
 * stamps those rows restored. A later flag for the same partner and the same
 * Stripe object is then consumed as `suppressed`, never re-restricted.
 */
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import { billingFraudFlagsEnabled } from '../config/env';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partnerBillingFraudFlags, partners } from '../db/schema';
import type { PartnerTrustState } from '../db/schema/orgs';
import {
  getBreezeBillingClient,
  type BillingFraudFlag,
  type MalformedBillingFraudFlag,
} from './breezeBillingClient';
import { isOpsAlertingConfigured, opsText, sendOpsAlert } from './opsAlerts';
import { setTrustState } from './partnerTrust';
import { closeOpenCheckoutsAfterRestrict } from './partnerTrustPromotion';
import { captureException } from './sentry';

export const FRAUD_FLAG_PAGE_LIMIT = 100;
const FRAUD_FLAG_MAX_PAGES = 5;
/** Consecutive unreadable-feed runs before the operator is paged. */
const FEED_FAILURE_ALERT_THRESHOLD = 3;
export const FRAUD_FLAG_RESTORE_REASON = 'admin:fraud_flag_restore';

type LedgerOutcome = 'restricted' | 'already_restricted' | 'suppressed';
export type FraudFlagConsumeOutcome = LedgerOutcome | 'partner_missing';

type LedgerRow = typeof partnerBillingFraudFlags.$inferSelect;

export interface FraudFlagSweepResult {
  skipped?: 'disabled' | 'not_enforcing' | 'billing_not_configured';
  restricted: number;
  consumed: number;
  leftPending: number;
  malformed: number;
}

/** Thrown inside a write transaction to roll it back and leave the flag pending. */
class RetryLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

let consecutiveFeedFailures = 0;
/**
 * Flags left pending on purpose (malformed, partner mismatch, consume
 * refused), alerted once per process so a stuck flag does not page the ops
 * channel every run. A restart alerts again, once.
 */
const alertedStuckFlagKeys = new Set<string>();

/** Test seam: reset the in-process alert bookkeeping. */
export function resetFraudFlagSweepStateForTests(): void {
  consecutiveFeedFailures = 0;
  alertedStuckFlagKeys.clear();
}

async function alertStuckOnce(key: string, title: string, lines: string[]): Promise<void> {
  if (alertedStuckFlagKeys.has(key)) return;
  alertedStuckFlagKeys.add(key);
  captureException(new Error(`[partnerTrustFraudFlags] ${title} (${key})`));
  await alertOperator(title, lines);
}

function systemDb<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function trustQueueUrl(): string | null {
  const base = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL)?.trim();
  return base ? `${base.replace(/\/+$/, '')}/admin/trust-queue` : null;
}

async function alertOperator(title: string, lines: string[]): Promise<void> {
  const url = trustQueueUrl();
  const delivered = await sendOpsAlert({
    title,
    body: [...lines, ...(url ? [`Trust queue: ${url}`] : [])].join('\n'),
  });
  // Never gates the consume: the ledger and the audit trail already hold the
  // outcome. A configured channel that failed is a fault worth a Sentry event.
  if (!delivered && isOpsAlertingConfigured()) {
    captureException(new Error(`[partnerTrustFraudFlags] ops alert not delivered: ${title}`));
  }
}

async function partnerName(partnerId: string): Promise<string> {
  const [row] = await systemDb(() => db.select({ name: partners.name }).from(partners)
    .where(eq(partners.id, partnerId)).limit(1), 'partnerTrustFraudFlags.partnerName');
  // The partner name is tenant-controlled and lands in a chat-rendered alert.
  return opsText(row?.name ?? partnerId);
}

async function readLedgerByFlag(billingFlagId: string): Promise<LedgerRow | null> {
  const [row] = await systemDb(() => db.select().from(partnerBillingFraudFlags)
    .where(eq(partnerBillingFraudFlags.billingFlagId, billingFlagId)).limit(1), 'partnerTrustFraudFlags.ledger');
  return row ?? null;
}

function ledgerValues(flag: BillingFraudFlag, outcome: LedgerOutcome) {
  return {
    partnerId: flag.partnerId,
    billingFlagId: flag.id,
    flagKind: flag.kind,
    restrictReason: flag.restrictReason,
    stripeObjectId: flag.stripeObjectId,
    stripeChargeId: flag.stripeChargeId,
    billingFlaggedAt: flag.flaggedAt,
    outcome,
    // clock_timestamp(), not the transaction-start now(): a row inserted after
    // waiting on the partner lock must sort after the restriction it waited on
    // (the restore episode is "rows created at or after the restricting row").
    createdAt: sql`clock_timestamp()`,
  };
}

/** Ambient-db suppression check; call only inside a held system transaction. */
async function isSuppressed(partnerId: string, stripeObjectId: string): Promise<boolean> {
  const rows = await db.select({ id: partnerBillingFraudFlags.id }).from(partnerBillingFraudFlags).where(and(
    eq(partnerBillingFraudFlags.partnerId, partnerId),
    eq(partnerBillingFraudFlags.stripeObjectId, stripeObjectId),
    sql`${partnerBillingFraudFlags.restoredAt} IS NOT NULL`,
  )).limit(1);
  return rows.length > 0;
}

type Classification =
  | { kind: 'partner_missing' }
  | { kind: 'recorded'; row: LedgerRow }
  | { kind: 'restrict'; from: Exclude<PartnerTrustState, 'restricted'> };

/**
 * Decides a flag that has no ledger row yet, holding the partner row lock so
 * the decision serializes with a restore (whose trust UPDATE takes the same
 * lock). Records the non-restricting outcomes in the same transaction.
 */
async function classifyFlag(flag: BillingFraudFlag): Promise<Classification> {
  return systemDb(async () => {
    const rows = (await db.execute(sql`
      SELECT trust_state FROM partners WHERE id = ${flag.partnerId} FOR UPDATE
    `)) as unknown as Array<{ trust_state: PartnerTrustState }>;
    const partner = rows[0];
    if (!partner) return { kind: 'partner_missing' };
    let outcome: LedgerOutcome | null = null;
    if (await isSuppressed(flag.partnerId, flag.stripeObjectId)) outcome = 'suppressed';
    else if (partner.trust_state === 'restricted') outcome = 'already_restricted';
    if (!outcome) return { kind: 'restrict', from: partner.trust_state as Exclude<PartnerTrustState, 'restricted'> };
    const [inserted] = await db.insert(partnerBillingFraudFlags)
      .values(ledgerValues(flag, outcome))
      .onConflictDoNothing({ target: partnerBillingFraudFlags.billingFlagId })
      .returning();
    if (!inserted) throw new RetryLaterError('ledger row appeared concurrently');
    return { kind: 'recorded', row: inserted };
  }, 'partnerTrustFraudFlags.classify');
}

async function markEffectsDone(rowId: string): Promise<void> {
  await systemDb(() => db.update(partnerBillingFraudFlags).set({ effectsDoneAt: new Date() })
    .where(eq(partnerBillingFraudFlags.id, rowId)), 'partnerTrustFraudFlags.effectsDone');
}

/**
 * Post-commit effects of a ledger row: close open checkouts (restricted only)
 * and alert the operator. Best effort; never throws for a delivery failure.
 * Skipped for a restriction that was already restored, or superseded by a
 * later trust change, so a delayed retry never acts on a newer state.
 */
async function runEffects(row: LedgerRow): Promise<void> {
  const name = await partnerName(row.partnerId);
  if (row.outcome === 'restricted') {
    const [current] = await systemDb(() => db.select({ trustState: partners.trustState, trustChangedAt: partners.trustChangedAt })
      .from(partners).where(eq(partners.id, row.partnerId)).limit(1), 'partnerTrustFraudFlags.effectsState');
    const stillThisRestriction = !row.restoredAt && current?.trustState === 'restricted'
      && current.trustChangedAt?.getTime() === row.restrictedTrustChangedAt?.getTime();
    if (stillThisRestriction) {
      await closeOpenCheckoutsAfterRestrict(row.partnerId, row.restrictReason);
      await alertOperator(`Partner restricted on a billing fraud flag: ${name}`, [
        `Partner: ${name} (${row.partnerId})`,
        `Flag kind: ${row.flagKind}`,
        `Previous trust state: ${row.previousTrustState}`,
        `Stripe object: ${row.stripeObjectId}`,
        'Review the partner. If the restriction is wrong, use Restore in the trust queue: it returns the partner to its previous state and stops this Stripe object from restricting it again.',
      ]);
    }
  } else {
    await alertOperator(`Billing fraud flag recorded (${row.outcome}): ${name}`, [
      `Partner: ${name} (${row.partnerId})`,
      `Flag kind: ${row.flagKind}`,
      `Stripe object: ${row.stripeObjectId}`,
      row.outcome === 'suppressed'
        ? 'Not restricted: an admin restore already cleared this Stripe object for this partner.'
        : 'Not changed: the partner was already restricted.',
    ]);
  }
  await markEffectsDone(row.id);
}

async function restrictFromFlag(
  flag: BillingFraudFlag,
  from: Exclude<PartnerTrustState, 'restricted'>,
): Promise<LedgerRow | null> {
  let ledgerRow: LedgerRow | null = null;
  let landed: boolean;
  try {
    landed = await setTrustState(
      flag.partnerId,
      'restricted',
      flag.restrictReason,
      null,
      {
        matchedAxes: ['billing.fraud_flag'],
        billingFraudFlagId: flag.id,
        flagKind: flag.kind,
        stripeObjectId: flag.stripeObjectId,
      },
      {
        expectedFrom: from,
        withinWrite: async ({ trustChangedAt }) => {
          // Re-checked under the partner row lock the UPDATE now holds: a
          // restore that committed after classifyFlag released its lock may
          // have suppressed this object.
          if (await isSuppressed(flag.partnerId, flag.stripeObjectId)) {
            throw new RetryLaterError('object suppressed concurrently');
          }
          const [inserted] = await db.insert(partnerBillingFraudFlags).values({
            ...ledgerValues(flag, 'restricted'),
            previousTrustState: from,
            restrictedTrustChangedAt: trustChangedAt,
          }).onConflictDoNothing({ target: partnerBillingFraudFlags.billingFlagId }).returning();
          if (!inserted) throw new RetryLaterError('ledger row appeared concurrently');
          ledgerRow = inserted;
        },
      },
    );
  } catch (error) {
    if (error instanceof RetryLaterError) return null;
    throw error;
  }
  return landed ? ledgerRow : null;
}

/** Processes one flag. Returns the consumed outcome, or null when left pending. */
async function processFlag(flag: BillingFraudFlag): Promise<FraudFlagConsumeOutcome | null> {
  const billing = getBreezeBillingClient();
  const existing = await readLedgerByFlag(flag.id);
  if (existing) {
    if (existing.partnerId !== flag.partnerId) {
      // Billing re-pointed a flag id at another partner. Never act on it.
      await alertStuckOnce(`mismatch:${flag.id}`, 'Billing fraud flag left pending: partner mismatch', [
        `Flag id: ${flag.id}`,
        `Ledger partner: ${existing.partnerId}`,
        `Feed partner: ${flag.partnerId}`,
      ]);
      return null;
    }
    if (!existing.effectsDoneAt) await runEffects(existing);
    await billing.consumeFraudFlag(flag.id, existing.outcome);
    return existing.outcome;
  }

  let classification: Classification;
  try {
    classification = await classifyFlag(flag);
  } catch (error) {
    if (error instanceof RetryLaterError) return null;
    throw error;
  }

  if (classification.kind === 'partner_missing') {
    await alertOperator('Billing fraud flag for a partner not in this region', [
      `Partner id: ${flag.partnerId}`,
      `Flag id: ${flag.id}`,
      `Flag kind: ${flag.kind}`,
      'Consumed as partner_missing. If this repeats, check that this API points at its own region\'s billing service.',
    ]);
    await billing.consumeFraudFlag(flag.id, 'partner_missing');
    return 'partner_missing';
  }

  const row = classification.kind === 'recorded'
    ? classification.row
    : await restrictFromFlag(flag, classification.from);
  if (!row) return null; // CAS lost or raced a restore: retry next run.
  await runEffects(row);
  await billing.consumeFraudFlag(flag.id, row.outcome);
  return row.outcome;
}

async function reportMalformed(malformed: MalformedBillingFraudFlag[]): Promise<void> {
  for (const entry of malformed) {
    const key = `malformed:${entry.id ?? `no-id:${entry.problem}`}`;
    await alertStuckOnce(key, 'Billing fraud flag left pending: malformed', [
      `Flag id: ${entry.id ?? 'unknown'}`,
      `Invalid field: ${entry.problem}`,
      'Core did not act on it and did not consume it. Fix or consume it on the billing side.',
    ]);
  }
}

/**
 * One run of the partner-trust-fraud-flags job. Gated by
 * PARTNER_TRUST_FRAUD_FLAGS_ENABLED and by PARTNER_TRUST_MODE=enforce: a
 * stored `restricted` state blocks real checkouts even when no gate enforces
 * it, so nothing is written outside enforce.
 *
 * Throws when the billing feed cannot be read or a consume fails, so the job
 * is marked failed; flags already acted on are finished by the next run.
 */
export async function runBillingFraudFlagSweep(): Promise<FraudFlagSweepResult> {
  const result: FraudFlagSweepResult = { restricted: 0, consumed: 0, leftPending: 0, malformed: 0 };
  if (!billingFraudFlagsEnabled()) return { ...result, skipped: 'disabled' };
  if (partnerTrustMode() !== 'enforce') return { ...result, skipped: 'not_enforcing' };
  if (!process.env.BREEZE_BILLING_URL?.trim()) return { ...result, skipped: 'billing_not_configured' };

  for (let page = 0; page < FRAUD_FLAG_MAX_PAGES; page += 1) {
    let feed: Awaited<ReturnType<ReturnType<typeof getBreezeBillingClient>['listPendingFraudFlags']>>;
    try {
      feed = await getBreezeBillingClient().listPendingFraudFlags(FRAUD_FLAG_PAGE_LIMIT);
      consecutiveFeedFailures = 0;
    } catch (error) {
      consecutiveFeedFailures += 1;
      if (consecutiveFeedFailures === FEED_FAILURE_ALERT_THRESHOLD) {
        await alertOperator('Billing fraud flag feed unreadable', [
          `${consecutiveFeedFailures} consecutive runs could not read the billing fraud flag feed.`,
          `Last error: ${error instanceof Error ? error.message : String(error)}`,
          'No partner is restricted on a billing fraud flag until it recovers.',
        ]);
      }
      throw error;
    }
    result.malformed += feed.malformed.length;
    await reportMalformed(feed.malformed);

    let consumedThisPage = 0;
    for (const flag of feed.flags) {
      let outcome: FraudFlagConsumeOutcome | null;
      try {
        outcome = await processFlag(flag);
      } catch (error) {
        // Billing unreachable (5xx/transport): stop this run, the ledger lets
        // the next one finish. Billing refusing THIS flag's consume (4xx):
        // the action is recorded, so skip it and keep going rather than let
        // it block every newer flag. Anything else skips just this flag.
        const code = error instanceof Error && 'code' in error ? (error as { code?: string }).code : undefined;
        if (code === 'BILLING_UNAVAILABLE') throw error;
        if (code === 'FRAUD_FLAG_REJECTED') {
          await alertStuckOnce(`rejected:${flag.id}`, 'Billing fraud flag left pending: consume refused', [
            `Flag id: ${flag.id}`,
            `Partner id: ${flag.partnerId}`,
            `Billing answered: ${error instanceof Error ? error.message : String(error)}`,
            'Core has recorded its outcome; the flag stays pending on the billing side until it is consumed there.',
          ]);
        } else {
          console.warn(`[partnerTrustFraudFlags] flag ${flag.id} failed; left pending`, error);
          captureException(error instanceof Error ? error : new Error(String(error)));
        }
        outcome = null;
      }
      if (outcome === null) {
        result.leftPending += 1;
        continue;
      }
      consumedThisPage += 1;
      result.consumed += 1;
      if (outcome === 'restricted') result.restricted += 1;
    }
    const pageSize = feed.flags.length + feed.malformed.length;
    if (pageSize < FRAUD_FLAG_PAGE_LIMIT || consumedThisPage === 0) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface FraudRestoreEpisode {
  partnerId: string;
  /** The `restricted` ledger row that created the current restriction. */
  restrictingFlagId: string;
  previousTrustState: Exclude<PartnerTrustState, 'restricted'>;
  restrictedAt: string;
  /** Every unrestored ledger row of this restriction; a restore must name exactly these. */
  flags: Array<{ id: string; kind: string; stripeObjectId: string; outcome: LedgerOutcome; flaggedAt: string | null }>;
}

/**
 * The restorable fraud-flag restriction of each partner, if any: the partner
 * is restricted, and its current trust transition (trust_changed_at) is the
 * one a `restricted` ledger row created and no restore has cleared. A later
 * admin re-restrict, or any other trust write, changes trust_changed_at, so
 * the episode stops being restorable and the admin uses promote-with-override.
 * The admin queue and the restore route share this predicate.
 */
export async function loadFraudRestoreEpisodes(partnerIds: string[]): Promise<Map<string, FraudRestoreEpisode>> {
  const episodes = new Map<string, FraudRestoreEpisode>();
  if (partnerIds.length === 0) return episodes;
  const rows = await systemDb(() => db.execute(sql`
    SELECT
      r.partner_id::text AS partner_id,
      r.id::text AS restricting_id,
      r.previous_trust_state AS previous_trust_state,
      r.restricted_trust_changed_at AS restricted_at,
      f.id::text AS flag_row_id,
      f.flag_kind AS flag_kind,
      f.stripe_object_id AS stripe_object_id,
      f.outcome AS outcome,
      f.billing_flagged_at AS flagged_at
    FROM partners p
    JOIN partner_billing_fraud_flags r
      ON r.partner_id = p.id
     AND r.outcome = 'restricted'
     AND r.restored_at IS NULL
     AND r.restricted_trust_changed_at = p.trust_changed_at
    JOIN partner_billing_fraud_flags f
      ON f.partner_id = p.id
     AND f.restored_at IS NULL
     AND f.created_at >= r.created_at
    WHERE p.trust_state = 'restricted'
      AND p.id IN (${sql.join(partnerIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY p.id, f.created_at, f.id
  `), 'partnerTrustFraudFlags.episodes') as unknown as Array<{
    partner_id: string;
    restricting_id: string;
    previous_trust_state: Exclude<PartnerTrustState, 'restricted'>;
    restricted_at: Date | string;
    flag_row_id: string;
    flag_kind: string;
    stripe_object_id: string;
    outcome: LedgerOutcome;
    flagged_at: Date | string | null;
  }>;
  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
  for (const row of rows) {
    let episode = episodes.get(row.partner_id);
    if (!episode) {
      episode = {
        partnerId: row.partner_id,
        restrictingFlagId: row.restricting_id,
        previousTrustState: row.previous_trust_state,
        restrictedAt: iso(row.restricted_at)!,
        flags: [],
      };
      episodes.set(row.partner_id, episode);
    }
    episode.flags.push({
      id: row.flag_row_id,
      kind: row.flag_kind,
      stripeObjectId: row.stripe_object_id,
      outcome: row.outcome,
      flaggedAt: iso(row.flagged_at),
    });
  }
  return episodes;
}

export type RestoreResult =
  | { status: 'restored'; trustState: Exclude<PartnerTrustState, 'restricted'>; restoredFlagIds: string[] }
  | { status: 'not_restorable' }
  | { status: 'stale' };

/**
 * Returns a partner restricted by a billing fraud flag to the trust state it
 * had before, and stamps the restriction's ledger rows restored so each of
 * their Stripe objects is suppressed from now on. `flagIds` must be exactly
 * the episode's rows as the admin saw them (FraudRestoreEpisode.flags[].id);
 * a flag that arrived since makes the restore `stale`, and so does any trust
 * write since the restriction. Audited by setTrustState's trust audit row.
 */
export async function restoreBillingFraudRestriction(input: {
  partnerId: string;
  actorUserId: string;
  flagIds: string[];
  operatorReason?: string | null;
}): Promise<RestoreResult> {
  const episode = (await loadFraudRestoreEpisodes([input.partnerId])).get(input.partnerId);
  if (!episode) return { status: 'not_restorable' };
  const expected = new Set(episode.flags.map((f) => f.id));
  const requested = new Set(input.flagIds.map((id) => id.toLowerCase()));
  if (expected.size !== requested.size || [...requested].some((id) => !expected.has(id))) {
    return { status: 'stale' };
  }
  const ids = [...expected];
  const restrictedAt = new Date(episode.restrictedAt);
  const operatorReason = input.operatorReason?.trim() || null;

  let landed: boolean;
  try {
    landed = await setTrustState(
      input.partnerId,
      episode.previousTrustState,
      FRAUD_FLAG_RESTORE_REASON,
      input.actorUserId,
      {
        // Not `reason`: setTrustState spreads evidence over its own `reason`.
        operatorReason,
        restoredLedgerIds: ids,
        stripeObjectIds: [...new Set(episode.flags.map((f) => f.stripeObjectId))],
      },
      {
        expectedFrom: 'restricted',
        expectedTrustChangedAt: restrictedAt,
        withinWrite: async () => {
          const stamped = await db.update(partnerBillingFraudFlags).set({
            restoredAt: new Date(),
            restoredBy: input.actorUserId,
            restoreReason: operatorReason,
          }).where(and(
            eq(partnerBillingFraudFlags.partnerId, input.partnerId),
            inArray(partnerBillingFraudFlags.id, ids),
            isNull(partnerBillingFraudFlags.restoredAt),
          )).returning({ id: partnerBillingFraudFlags.id });
          if (stamped.length !== ids.length) throw new RetryLaterError('episode rows changed');
          // A flag recorded after the admin loaded the queue (it waited on the
          // partner lock this UPDATE now holds) must not be cleared unseen.
          const [restricting] = await db.select({ createdAt: partnerBillingFraudFlags.createdAt })
            .from(partnerBillingFraudFlags).where(eq(partnerBillingFraudFlags.id, episode.restrictingFlagId)).limit(1);
          const newer = await db.select({ id: partnerBillingFraudFlags.id }).from(partnerBillingFraudFlags).where(and(
            eq(partnerBillingFraudFlags.partnerId, input.partnerId),
            isNull(partnerBillingFraudFlags.restoredAt),
            gte(partnerBillingFraudFlags.createdAt, restricting?.createdAt ?? restrictedAt),
          )).orderBy(asc(partnerBillingFraudFlags.createdAt)).limit(1);
          if (newer.length > 0) throw new RetryLaterError('a newer flag joined the episode');
        },
      },
    );
  } catch (error) {
    if (error instanceof RetryLaterError) return { status: 'stale' };
    throw error;
  }
  if (!landed) return { status: 'stale' };
  return { status: 'restored', trustState: episode.previousTrustState, restoredFlagIds: ids };
}
