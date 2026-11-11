/**
 * Wisp delegation W2 (#11085) — "Continue" for a device-troubleshooting run:
 * a fresh run seeded from a settled prior one (plan Decision 4; no in-place
 * resume). The launcher (specialistLaunchers.ts) calls `continuationOf` to
 * decide whether the prior run may be continued from here, and
 * `buildContinuationSeed` for the seed text (rendered by the pure
 * `renderContinuationSeed`, troubleshootProfile.ts).
 *
 * Reads in short system contexts; every read is pinned to the prior run's own
 * org, and `continuationOf` refuses a prior run of another org, device or
 * grant before anything of it is read into a seed.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { approvalRequests } from '../../db/schema/approvals';
import {
  TROUBLESHOOT_MAX_CONTINUATION_CHAIN,
  renderContinuationSeed,
  type ContinuationStep,
} from '../aiAgents/troubleshootProfile';

/** A prior run may be continued only once it has settled. */
const SETTLED = new Set(['completed', 'failed', 'awaiting_approval', 'cancelled']);
/** The seed lists at most this many of the prior run's steps (it proposes at most 3). */
const SEED_STEP_LIMIT = 20;

export type ContinuationRefusalDetail =
  | 'not_found' | 'not_troubleshooting' | 'other_org' | 'other_device' | 'other_grant' | 'not_settled' | 'chain_limit';

export type ContinuationCheck = { ok: true; chain: number } | { ok: false; detail: ContinuationRefusalDetail };

/** `wisp-specialist-continue-<fromRunId>-<chain>`: a second continuation of the same run replays the first. */
export function continuationDedupeKey(fromRunId: string, chain: number): string {
  return `wisp-specialist-continue-${fromRunId}-${chain}`;
}

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

function priorChain(triggerRef: unknown): number {
  const chain = ((triggerRef ?? null) as { continuation?: { chain?: unknown } } | null)?.continuation?.chain;
  return typeof chain === 'number' && Number.isInteger(chain) && chain > 0 ? chain : 0;
}

/**
 * May `fromRunId` be continued by a new run on (orgId, deviceId) under
 * grantId? `grantId` is absent only on the advisory precheck (which has no
 * grant); the launcher always passes it. On success, `chain` is the NEW run's.
 */
export async function continuationOf(args: {
  fromRunId: string;
  orgId: string;
  deviceId: string;
  grantId?: string;
}): Promise<ContinuationCheck> {
  const [prior] = await systemRead(() => db
    .select({
      id: aiAgentRuns.id,
      profile: aiAgentRuns.profile,
      orgId: aiAgentRuns.orgId,
      deviceId: aiAgentRuns.deviceId,
      grantId: aiAgentRuns.grantId,
      status: aiAgentRuns.status,
      triggerRef: aiAgentRuns.triggerRef,
    })
    .from(aiAgentRuns)
    .where(eq(aiAgentRuns.id, args.fromRunId))
    .limit(1));
  if (!prior) return { ok: false, detail: 'not_found' };
  // Org first: nothing about another org's run is reported beyond "not yours".
  if (prior.orgId !== args.orgId) return { ok: false, detail: 'other_org' };
  if (prior.profile !== 'device_troubleshooting') return { ok: false, detail: 'not_troubleshooting' };
  if (prior.deviceId !== args.deviceId) return { ok: false, detail: 'other_device' };
  if (args.grantId !== undefined && prior.grantId !== args.grantId) return { ok: false, detail: 'other_grant' };
  if (!SETTLED.has(prior.status)) return { ok: false, detail: 'not_settled' };
  const chain = priorChain(prior.triggerRef);
  if (chain >= TROUBLESHOOT_MAX_CONTINUATION_CHAIN) return { ok: false, detail: 'chain_limit' };
  return { ok: true, chain: chain + 1 };
}

/** A released step's result as text for the seed (fenced and capped by the renderer). */
function outcomeOf(status: string, result: unknown, errorCode: string | null): string | null {
  if (status === 'failed') return errorCode ?? 'failed';
  if (status !== 'completed' || result === null || result === undefined) return null;
  if (typeof result === 'string') return result;
  const r = result as Record<string, unknown>;
  for (const key of ['summary', 'stdout', 'message']) if (typeof r[key] === 'string') return r[key] as string;
  return JSON.stringify(result);
}

/**
 * The seed for a continuation of `priorRunId` (already checked by
 * `continuationOf`): the prior summary and each step it proposed, with its
 * status and, once released, its outcome. ≤ 4 KB.
 */
export async function buildContinuationSeed(priorRunId: string): Promise<string> {
  const { summary, steps } = await systemRead(async () => {
    const [run] = await db
      .select({ orgId: aiAgentRuns.orgId, summary: aiAgentRuns.summary })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, priorRunId))
      .limit(1);
    if (!run) return { summary: null, steps: [] as ContinuationStep[] };
    const intents = await db
      .select({
        id: actionIntents.id,
        status: actionIntents.status,
        actionName: actionIntents.actionName,
        result: actionIntents.result,
        errorCode: actionIntents.errorCode,
      })
      .from(actionIntents)
      .where(and(eq(actionIntents.requestingAgentRunId, priorRunId), eq(actionIntents.orgId, run.orgId)))
      .orderBy(asc(actionIntents.createdAt))
      .limit(SEED_STEP_LIMIT);
    const labels = intents.length > 0
      ? await db
        .select({ intentId: approvalRequests.intentId, actionLabel: approvalRequests.actionLabel })
        .from(approvalRequests)
        .where(inArray(approvalRequests.intentId, intents.map((i) => i.id)))
      : [];
    const labelOf = new Map(labels.map((l) => [l.intentId, l.actionLabel]));
    return {
      summary: run.summary,
      steps: intents.map((i): ContinuationStep => ({
        label: labelOf.get(i.id) ?? i.actionName,
        status: i.status,
        outcome: outcomeOf(i.status, i.result, i.errorCode),
      })),
    };
  });
  return renderContinuationSeed({ fromRunId: priorRunId, summary, steps });
}
