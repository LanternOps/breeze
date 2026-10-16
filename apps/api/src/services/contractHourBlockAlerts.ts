import { and, eq, gte, isNotNull, isNull, lte, notExists, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  contractBillingPeriods, contractHourPeriods, contractLines, contracts, organizations, users,
} from '../db/schema';
import { computeOpenHourBlockPeriod } from './contractHourBlockEstimate';
import { emitContractEvent } from './contractEvents';
import { PERMISSIONS } from './permissions';
import { getRedis } from './redis';
import { captureException } from './sentry';
import { buildAutomationEligibleOrgPredicate } from './tenantStatus';
import { createNotification } from './userNotifications';
import { resolveUsersWithPermissionForOrg } from './usersWithPermission';

type ContractRow = typeof contracts.$inferSelect;
type LineRow = typeof contractLines.$inferSelect;

export interface HourBlockAlertSweepResult {
  lines: number;
  crossed: number;
  notified: number;
  skippedBacklog: number;
  errors: number;
}

/**
 * Has `consumed` reached `alertPct` percent of `opening` hours?
 * Hours are 2-dp by construction, so compare in integer cents:
 * round(consumed*100)*100 >= pct * round(opening*100). No float comparison
 * ever decides whether a person is notified.
 */
export function hasCrossedThreshold(consumedHours: number, openingHours: number, alertPct: number): boolean {
  const consumed = Math.round(consumedHours * 100);
  const opening = Math.round(openingHours * 100);
  if (opening <= 0) return false;
  return consumed * 100 >= alertPct * opening;
}

const hoursText = (n: number): string => String(Number(n.toFixed(2)));

/**
 * A claimed, ENDED period at/after the block's first period with no
 * contract_hour_periods row = the close has not caught up (cap hit, failure).
 * The open period's carriedInHours is the previous close's carried_out, so
 * until the backlog clears the opening balance is stale.
 */
async function hasCloseBacklog(contract: ContractRow, line: LineRow, todayISO: string): Promise<boolean> {
  const first = line.hourBlockFirstPeriodStart;
  if (!first) return false;
  const rows = await db
    .select({ id: contractBillingPeriods.id })
    .from(contractBillingPeriods)
    .where(
      and(
        eq(contractBillingPeriods.contractId, contract.id),
        gte(contractBillingPeriods.periodStart, first),
        lte(contractBillingPeriods.periodEnd, todayISO),
        notExists(
          db
            .select({ one: sql`1` })
            .from(contractHourPeriods)
            .where(
              and(
                eq(contractHourPeriods.contractLineId, line.id),
                eq(contractHourPeriods.periodStart, contractBillingPeriods.periodStart),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function resolveRecipients(contract: ContractRow): Promise<string[]> {
  // contracts:read holders of the owning partner with access to THIS org (plus
  // org members whose role grants it). Deliberately NOT contractRenewal's
  // private resolveMspRecipients, which has no permission filter.
  const holders = await resolveUsersWithPermissionForOrg(contract.orgId, PERMISSIONS.CONTRACTS_READ);
  if (holders.length > 0) return holders;
  if (!contract.createdBy) return [];
  const [creator] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, contract.createdBy), eq(users.status, 'active')))
    .limit(1);
  return creator ? [creator.id] : [];
}

/**
 * Durable "already alerted" marker. Dismissing a notification DELETES its
 * user_notifications row (routes/notifications.ts), so the (user_id,
 * dedupe_key) index forgets; this marker does not. true = newly set (this run
 * owns the alert), false = already alerted, null = Redis unavailable (degraded).
 */
async function claimMarker(key: string, periodEnd: string, now: Date): Promise<boolean | null> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[HourBlockAlerts] Redis unavailable: relying on the notification dedupe key only', key);
    return null;
  }
  const secondsToPeriodEnd = Math.ceil((new Date(`${periodEnd}T00:00:00Z`).getTime() - now.getTime()) / 1000);
  const ttl = Math.max(3600, secondsToPeriodEnd) + 86_400;
  return (await redis.set(key, '1', 'EX', ttl, 'NX')) === 'OK';
}

async function releaseMarker(key: string): Promise<void> {
  try {
    await getRedis()?.del(key);
  } catch (err) {
    console.error('[HourBlockAlerts] failed to release marker', key, err instanceof Error ? err.message : err);
  }
}

type LineOutcome =
  | { status: 'backlog' }
  | { status: 'below' }
  | { status: 'crossed'; created: number; emit: boolean; periodStart: string; alertPct: number };

/** One block line, inside the caller's per-line system transaction. */
async function evaluateLine(
  contract: ContractRow,
  line: LineRow,
  asOf: Date,
  claimedKeys: string[],
): Promise<LineOutcome> {
  const alertPct = line.hourBlockAlertPct as number; // the candidate query guarantees non-null
  const todayISO = asOf.toISOString().slice(0, 10);

  if (await hasCloseBacklog(contract, line, todayISO)) {
    console.warn(
      '[HourBlockAlerts] close backlog: judging deferred. contract=%s line=%s',
      contract.id, line.id,
    );
    return { status: 'backlog' };
  }

  const estimate = await computeOpenHourBlockPeriod(contract, line, asOf);
  const opening = estimate.includedHours + estimate.carriedInHours;
  if (!hasCrossedThreshold(estimate.consumedHours, opening, alertPct)) return { status: 'below' };

  const markerKey = `hour_block_alert:${line.id}:${estimate.periodStart}:${alertPct}`;
  const claimed = await claimMarker(markerKey, estimate.periodEnd, asOf);
  const crossed = (created: number, emit: boolean): LineOutcome => ({
    status: 'crossed', created, emit, periodStart: estimate.periodStart, alertPct,
  });
  if (claimed === true) claimedKeys.push(markerKey);
  if (claimed === false) return crossed(0, false); // alerted before, whether or not the inbox row still exists

  try {
    const recipients = await resolveRecipients(contract);
    if (recipients.length === 0) {
      console.warn(
        '[HourBlockAlerts] threshold crossed but nobody to notify: contract=%s org=%s line=%s',
        contract.id, contract.orgId, line.id,
      );
      if (claimed) await releaseMarker(markerKey); // let a later run alert once someone has access
      return crossed(0, false);
    }

    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, contract.orgId))
      .limit(1);
    const orgName = Array.from((org?.name ?? 'a customer').replace(/[\r\n]+/g, ' ')).slice(0, 120).join('');
    const usedPct = Math.floor((Math.round(estimate.consumedHours * 100) * 100) / Math.max(1, Math.round(opening * 100)));
    const title = `Block hours ${usedPct}% used: ${orgName}`;
    const message =
      `${orgName}: ${hoursText(estimate.consumedHours)} of ${hoursText(opening)} block hours used ` +
      `for ${estimate.periodStart} – ${estimate.periodEnd} (alert threshold ${alertPct}%).`;
    const dedupeKey = `hour_block:${line.id}:${estimate.periodStart}:${alertPct}`;

    let created = 0;
    for (const userId of recipients) {
      const id = await createNotification({
        userId,
        orgId: contract.orgId,
        type: 'system',
        priority: 'high',
        title,
        message,
        link: `/contracts/${contract.id}`,
        metadata: {
          event: 'contract.hour_block_threshold',
          contractId: contract.id,
          contractLineId: line.id,
          periodStart: estimate.periodStart,
          alertPct,
        },
        dedupeKey,
      });
      if (id) created++;
    }
    // Marker newly set => this run owns the event. Degraded (no Redis) => only
    // when a row was actually created, so the dedupe_key still bounds it.
    return crossed(created, claimed === true ? true : created > 0);
  } catch (err) {
    if (claimed) await releaseMarker(markerKey); // the line's transaction rolls back: retry next run
    throw err;
  }
}

/**
 * Threshold alerts for live block lines. Runs LAST in the contract
 * billing-sweep job (renewal -> billing -> close-out -> alerts) so the open
 * period's carried-in balance reflects the close that just ran.
 *
 * Candidates: a live (non-retired) hour_block line with a non-NULL alert pct
 * on an ACTIVE contract of an automation-eligible org (the same archived/
 * purging/merging gate as the billing and renewal sweeps).
 *
 * ONE system transaction per line: a failed statement poisons every later
 * statement in a transaction, so a try/catch inside a shared context would not
 * isolate failures (same shape as runContractBillingSweep). The bus event is
 * emitted after the line's transaction commits.
 */
export async function runHourBlockAlertSweep(asOf: Date = new Date()): Promise<HourBlockAlertSweepResult> {
  const candidates = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ contract: contracts, line: contractLines })
        .from(contractLines)
        .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
        .where(
          and(
            eq(contractLines.lineType, 'hour_block'),
            isNull(contractLines.hourBlockRetiredAt),
            isNotNull(contractLines.hourBlockAlertPct),
            eq(contracts.status, 'active'),
            buildAutomationEligibleOrgPredicate(contracts.orgId),
          ),
        ),
    ),
  );

  const result: HourBlockAlertSweepResult = {
    lines: candidates.length, crossed: 0, notified: 0, skippedBacklog: 0, errors: 0,
  };

  for (const { contract, line } of candidates) {
    // Markers this line newly set. If the line's transaction fails AFTER
    // evaluateLine returned (e.g. at commit), its notification rows roll back,
    // so the markers must be released or the alert is lost for the period.
    const claimedKeys: string[] = [];
    try {
      const outcome = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => evaluateLine(contract, line, asOf, claimedKeys)),
      );
      if (outcome.status === 'backlog') { result.skippedBacklog++; continue; }
      if (outcome.status === 'below') continue;
      result.crossed++;
      result.notified += outcome.created;
      if (outcome.emit) {
        await emitContractEvent({
          type: 'contract.hour_block_threshold',
          contractId: contract.id,
          orgId: contract.orgId,
          partnerId: contract.partnerId,
          contractLineId: line.id,
          periodStart: outcome.periodStart,
          alertPct: outcome.alertPct,
        });
      }
    } catch (err) {
      for (const key of claimedKeys) await releaseMarker(key);
      result.errors++;
      console.error(
        '[HourBlockAlerts] line failed',
        `contractId=${contract.id}`,
        `lineId=${line.id}`,
        err instanceof Error ? err.message : err,
      );
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return result;
}
