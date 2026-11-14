/**
 * #11671 — a specialist's result reaches the chat that handed the work off.
 *
 * A Wisp hand-off (`launch_specialist` → `launchDeviceTroubleshooting`)
 * records the chat session on the run (`trigger_ref.originSessionId`). The
 * run settles seconds or minutes later, after the launching turn has ended.
 * Its result used to reach the model only through the in-memory queue on the
 * live streaming session (chatRunBridge `pendingRunResults`), and every
 * message send rotates that session away before the turn is built, so the
 * model never saw a result that arrived between turns.
 *
 * Delivery is durable now: each Wisp turn reads the runs this session handed
 * off that have settled and that this session has not been given yet, and
 * the route prepends them in the same `[breeze:analysis-results]` block the
 * bridge's queue uses. The run row is the source (it survives a session
 * rotation, an eviction and a restart); a per-session Redis set records what
 * was given, written only once the turn is dispatched
 * (`markSpecialistResultsDelivered`), so a refused turn leaves them for the
 * next one. The key is (run, status): a run that later settles differently
 * (waiting for approval → cancelled) is given again, once.
 *
 * Tenancy: the read is pinned to the session's grant and to the orgs of the
 * grant's LIVE ceiling, so a run of an org since removed from the grant is not
 * read into the chat. A paused, revoked or corrupt grant reads nothing.
 *
 * Fails open in both directions that lose nothing: a failed read sends the
 * turn without the block (nothing is marked, so the next turn tries again); an
 * unreadable Redis set gives the results again rather than drop them.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AiRunResultArtifactRef } from '@breeze/shared';
import { AI_SESSION_MAX_AGE_MS } from '@breeze/shared/constants';
import { wispEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiRunArtifacts } from '../../db/schema/aiWorkspace';
import { getRedis } from '../redis';
import { captureException } from '../sentry';
import type { PendingRunResult } from '../workspace/chatRunBridge';
import { GrantInactiveError, resolveGrantCeiling } from './grantAuthority';

export const SPECIALIST_DELIVERED_KEY_PREFIX = 'wisp:specialist-delivered:';
/** Past the session's 24 h hard cap, so a live session never forgets what it was given. */
export const SPECIALIST_DELIVERED_TTL_SECONDS = Math.ceil(AI_SESSION_MAX_AGE_MS / 1000) + 3600;
/** At most this many results ride on one turn (the newest); the rest wait for the next. */
export const MAX_SPECIALIST_RESULTS_PER_TURN = 5;
/** How many settled runs one read considers, newest first. */
const CANDIDATE_LIMIT = 50;

const PROFILE = 'device_troubleshooting';
const SETTLED_STATUSES = ['completed', 'failed', 'awaiting_approval', 'cancelled'] as const;
type SettledStatus = (typeof SETTLED_STATUSES)[number];

export type SpecialistResultsTurn = {
  /** Oldest first, in the shape the chat run bridge renders. */
  results: PendingRunResult[];
  /** What to record with `markSpecialistResultsDelivered` once the turn is dispatched. */
  keys: string[];
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const deliveredKey = (sessionId: string) => `${SPECIALIST_DELIVERED_KEY_PREFIX}${sessionId}`;
const resultKey = (runId: string, status: string) => `${runId}:${status}`;

/** What this session was already given. Unreadable → nothing (the results are given again). */
async function deliveredSet(sessionId: string): Promise<Set<string>> {
  try {
    const redis = getRedis();
    if (!redis) return new Set();
    return new Set(await redis.smembers(deliveredKey(sessionId)));
  } catch (err) {
    console.warn('[wisp] specialist results: the delivered set is unreadable; giving the results again', { sessionId, error: errText(err) });
    return new Set();
  }
}

type RunRow = { id: string; orgId: string; status: string; profile: string; summary: string | null };

/** This session's settled hand-offs under the grant and its live ceiling, newest first. */
async function readSettledRuns(input: { grantId: string; sessionId: string; orgIds: string[]; since: Date }): Promise<RunRow[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: aiAgentRuns.id,
          orgId: aiAgentRuns.orgId,
          status: aiAgentRuns.status,
          profile: aiAgentRuns.profile,
          summary: aiAgentRuns.summary,
        })
        .from(aiAgentRuns)
        .where(and(
          inArray(aiAgentRuns.orgId, input.orgIds),
          eq(aiAgentRuns.profile, PROFILE),
          isNotNull(aiAgentRuns.finishedAt),
          gte(aiAgentRuns.finishedAt, input.since),
          eq(aiAgentRuns.grantId, input.grantId),
          inArray(aiAgentRuns.status, [...SETTLED_STATUSES]),
          sql`${aiAgentRuns.triggerRef}->>'originSessionId' = ${input.sessionId}`,
        ))
        .orderBy(desc(aiAgentRuns.finishedAt), desc(aiAgentRuns.id))
        .limit(CANDIDATE_LIMIT),
    ),
  );
}

/** The chosen runs' files and, for a run waiting for approval, its pending step count. */
async function readResults(chosen: RunRow[], orgIds: string[]): Promise<SpecialistResultsTurn> {
  const ids = chosen.map((r) => r.id);
  const waitingIds = chosen.filter((r) => r.status === 'awaiting_approval').map((r) => r.id);
  const { artifacts, pending } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => ({
      artifacts: await db
        .select({
          runId: aiRunArtifacts.runId,
          handle: aiRunArtifacts.id,
          name: aiRunArtifacts.name,
          bytes: aiRunArtifacts.bytes,
          contentType: aiRunArtifacts.contentType,
        })
        .from(aiRunArtifacts)
        .where(and(inArray(aiRunArtifacts.runId, ids), inArray(aiRunArtifacts.orgId, orgIds))),
      pending: waitingIds.length === 0 ? [] : await db
        .select({ runId: actionIntents.requestingAgentRunId, n: count() })
        .from(actionIntents)
        .where(and(
          inArray(actionIntents.requestingAgentRunId, waitingIds),
          inArray(actionIntents.orgId, orgIds),
          eq(actionIntents.status, 'pending_approval'),
        ))
        .groupBy(actionIntents.requestingAgentRunId),
    })),
  );

  const results = chosen.map((run): PendingRunResult => {
    const refs: AiRunResultArtifactRef[] = artifacts
      .filter((a) => a.runId === run.id)
      // `bytes` is a bigint column: a string on some drivers, a number on the wire.
      .map(({ runId: _runId, ...a }) => ({ ...a, bytes: Number(a.bytes) }));
    const status = run.status as SettledStatus;
    const result: PendingRunResult = { runId: run.id, status, profile: run.profile, summary: run.summary, artifacts: refs };
    if (status === 'awaiting_approval') {
      result.pendingIntentCount = Number(pending.find((p) => p.runId === run.id)?.n ?? 0);
    }
    return result;
  });
  return { results, keys: chosen.map((r) => resultKey(r.id, r.status)) };
}

/**
 * The specialist results to put in front of this turn, or null: Wisp off; the
 * grant paused, revoked, gone or its pin corrupt; nothing new has settled; or
 * the run read failed (reported). An error resolving the ceiling other than an
 * inactive grant (a DB failure) propagates: the route catches it, reports it
 * and sends the turn without results.
 */
export async function specialistResultsForTurn(input: {
  grantId: string;
  revisionId: string;
  sessionId: string;
  now?: Date;
}): Promise<SpecialistResultsTurn | null> {
  if (!wispEnabled()) return null;
  const now = input.now ?? new Date();

  let orgIds: string[];
  try {
    // The live ceiling only: a paused grant reads nothing (allowPaused.contract.test.ts).
    const ceiling = await resolveGrantCeiling(input.grantId, input.revisionId);
    orgIds = [...ceiling.orgIds];
  } catch (err) {
    if (!(err instanceof GrantInactiveError)) throw err;
    if (err.kind === 'corrupt') {
      console.error(`[wisp] specialist results: grant ${input.grantId} has a corrupt ceiling pin; sending the turn without them: ${err.message}`);
      captureException(err, undefined, { grantId: input.grantId, op: 'wisp.specialist_results_ceiling' }, { fingerprint: ['wisp-specialist-results', 'corrupt-pin'] });
    }
    return null;
  }
  if (orgIds.length === 0) return null;

  try {
    const since = new Date(now.getTime() - AI_SESSION_MAX_AGE_MS);
    const runs = await readSettledRuns({ grantId: input.grantId, sessionId: input.sessionId, orgIds, since });
    if (runs.length === 0) return null;
    const given = await deliveredSet(input.sessionId);
    // Newest first from the query: keep the newest few, then give them oldest first.
    const chosen = runs.filter((r) => !given.has(resultKey(r.id, r.status))).slice(0, MAX_SPECIALIST_RESULTS_PER_TURN).reverse();
    if (chosen.length === 0) return null;
    return await readResults(chosen, orgIds);
  } catch (err) {
    console.warn('[wisp] specialist results: the read failed; sending the turn without them', {
      grantId: input.grantId, sessionId: input.sessionId, error: errText(err),
    });
    captureException(err, undefined, { grantId: input.grantId, op: 'wisp.specialist_results_read' }, { fingerprint: ['wisp-specialist-results', 'read'] });
    return null;
  }
}

/**
 * Record that this session's model has been given these results. Called after
 * the turn is dispatched. A failure only means they are given again next turn,
 * so it is logged and never thrown.
 */
export async function markSpecialistResultsDelivered(sessionId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const redis = getRedis();
    if (!redis) return;
    const key = deliveredKey(sessionId);
    // One MULTI, so the set never exists without its TTL.
    const replies = await redis.multi().sadd(key, ...keys).expire(key, SPECIALIST_DELIVERED_TTL_SECONDS).exec();
    const failed = replies?.find(([err]) => err)?.[0];
    if (!replies || failed) throw failed ?? new Error('the MULTI was discarded');
  } catch (err) {
    console.warn('[wisp] specialist results: failed to record them as delivered; they are given again next turn', { sessionId, error: errText(err) });
  }
}
