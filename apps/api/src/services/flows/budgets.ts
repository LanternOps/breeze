/**
 * Tool Catalog W05 (#5220), plan Task A4 / Decision 15 — exact monthly run
 * counters.
 *
 * `createFlowRun` serializes admission per flow owner (`lockFlowRunAdmission`,
 * a transaction-scoped advisory lock distinct from the slot lock), counts,
 * inserts the run and only then charges (`chargeFlowRun`) — in ONE system
 * transaction. A breach rolls the whole transaction back (run row and both
 * counter increments), so the counter is exact under the lock and a duplicate
 * delivery never charges.
 *
 * Owner = the FLOW's owner: an org flow ⇒ (partner, org); a partner-wide flow
 * ⇒ (partner, NULL) — a partner-wide flow's runs count against the partner,
 * whichever org they run in. Month = UTC `YYYY-MM` (`flowUsagePeriodKey`).
 */
import { sql } from 'drizzle-orm';
import { flowUsagePeriodKey, type FlowAdmissionRefusal } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { captureException } from '../sentry';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { sendFlowNotice } from './notices';

export type FlowMonthlyCapRefusal = Extract<FlowAdmissionRefusal, 'flow_monthly_cap_reached' | 'owner_monthly_cap_reached'>;

const CAP_REFUSAL_TEXT: Record<FlowMonthlyCapRefusal, string> = {
  flow_monthly_cap_reached: 'this flow reached its monthly run limit',
  owner_monthly_cap_reached: 'its owner reached the monthly run limit for all flows',
};

function assertSystemTx(site: string): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error(`${site} must run inside the run-creation system transaction`);
  }
}

function ownerKey(owner: ToolOwnerRef): string {
  return owner.orgId ? `org:${owner.orgId}` : `partner:${owner.partnerId}`;
}

/**
 * Serializes every admission decision of one flow owner until the transaction
 * ends. Distinct from `lockOwnerSlots` (runStore) so a slice claiming a slot
 * never waits behind a run creation, and vice versa.
 */
export async function lockFlowRunAdmission(owner: ToolOwnerRef): Promise<void> {
  assertSystemTx('lockFlowRunAdmission');
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flow_run_admission:${ownerKey(owner)}`}, 0))`);
}

async function increment(partnerId: string, orgId: string | null, flowId: string | null, periodKey: string): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO flow_usage_counters (partner_id, org_id, flow_id, period_key, runs, updated_at)
    VALUES (${partnerId}, ${orgId}, ${flowId}, ${periodKey}, 1, now())
    ON CONFLICT (partner_id, org_id, flow_id, period_key) DO UPDATE SET runs = flow_usage_counters.runs + 1, updated_at = now()
    RETURNING runs`);
  const runs = (rows as unknown as Array<{ runs: number | string }>)[0]?.runs;
  if (runs === undefined) throw new Error('chargeFlowRun: counter upsert returned no row');
  return Number(runs);
}

/**
 * Charge one created run: the flow row, then the owner-total row, each
 * `+ 1 … RETURNING runs`. Returns the first breach (flow before owner); the
 * caller must then roll its transaction back — the increments are not undone
 * here. MUST run inside the caller's system transaction, after the run row
 * inserted.
 */
export async function chargeFlowRun(i: {
  flowId: string;
  owner: ToolOwnerRef;
  flowCap: number;
  ownerCap: number;
  at: Date;
}): Promise<{ ok: true } | { ok: false; error: FlowMonthlyCapRefusal }> {
  assertSystemTx('chargeFlowRun');
  const periodKey = flowUsagePeriodKey(i.at);
  const flowRuns = await increment(i.owner.partnerId, i.owner.orgId, i.flowId, periodKey);
  const ownerRuns = await increment(i.owner.partnerId, i.owner.orgId, null, periodKey);
  if (flowRuns > i.flowCap) return { ok: false, error: 'flow_monthly_cap_reached' };
  if (ownerRuns > i.ownerCap) return { ok: false, error: 'owner_monthly_cap_reached' };
  return { ok: true };
}

/** This month's counts for a flow and its owner, in the CALLER's context (RLS applies). */
export async function readFlowUsage(flowId: string, owner: ToolOwnerRef, at: Date): Promise<{ flowRuns: number; ownerRuns: number }> {
  const periodKey = flowUsagePeriodKey(at);
  const rows = await db.execute(sql`
    SELECT
      COALESCE((SELECT c.runs FROM flow_usage_counters c
        WHERE c.partner_id = ${owner.partnerId} AND c.org_id IS NOT DISTINCT FROM ${owner.orgId}::uuid
          AND c.flow_id = ${flowId} AND c.period_key = ${periodKey}), 0) AS "flowRuns",
      COALESCE((SELECT c.runs FROM flow_usage_counters c
        WHERE c.partner_id = ${owner.partnerId} AND c.org_id IS NOT DISTINCT FROM ${owner.orgId}::uuid
          AND c.flow_id IS NULL AND c.period_key = ${periodKey}), 0) AS "ownerRuns"`);
  const row = (rows as unknown as Array<{ flowRuns: number | string; ownerRuns: number | string }>)[0];
  return { flowRuns: Number(row?.flowRuns ?? 0), ownerRuns: Number(row?.ownerRuns ?? 0) };
}

function isMonthlyCap(code: FlowAdmissionRefusal): code is FlowMonthlyCapRefusal {
  return code === 'flow_monthly_cap_reached' || code === 'owner_monthly_cap_reached';
}

/**
 * After a refusal (outside the rolled-back run transaction): mark the flow for
 * the banner at most once a minute per code, and — for a monthly cap — tell
 * the delegator once per (flow, month, code). The flow is NOT paused
 * (Decision 15). Best effort: never throws.
 */
export async function recordAdmissionRefusal(flowId: string, code: FlowAdmissionRefusal, at: Date = new Date()): Promise<void> {
  try {
    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const atSql = sql`${at.toISOString()}::timestamptz`;
      const rows = await db.execute(sql`
        UPDATE flows SET last_admission_refusal_at = ${atSql}, last_admission_refusal_code = ${code}
        WHERE id = ${flowId}
          AND (last_admission_refusal_at IS NULL
            OR last_admission_refusal_at < ${atSql} - interval '1 minute'
            OR last_admission_refusal_code IS DISTINCT FROM ${code})
        RETURNING id, name, org_id AS "orgId", enabled_by_user_id AS "enabledByUserId"`);
      const flow = (rows as unknown as Array<{ id: string; name: string; orgId: string | null; enabledByUserId: string | null }>)[0];
      if (!flow || !isMonthlyCap(code)) return;
      await sendFlowNotice(flow, null, {
        kind: 'cap_reached',
        title: 'Flow runs refused',
        text: `${flow.name} did not start because ${CAP_REFUSAL_TEXT[code]}. The flow stays enabled; runs start again next month or when the limit is raised.`,
        dedupeKey: `flow-cap:${flow.id}:${flowUsagePeriodKey(at)}:${code}`,
        metadata: { flowId: flow.id, reason: code },
      });
    }, 'flows.budgets.recordAdmissionRefusal'));
  } catch (err) {
    console.error(`[flows] admission refusal marker failed (flow=${flowId}, code=${code})`, err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined,
      { flow_id: flowId, flow_site: 'flows.budgets.recordAdmissionRefusal' },
      { fingerprint: ['flow', 'flows.budgets.recordAdmissionRefusal'] });
  }
}
