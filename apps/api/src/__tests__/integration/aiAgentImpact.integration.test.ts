/**
 * ai_agent_impact_daily — live-Postgres proof for P2-6 (#4193, Task A9).
 *
 * Migration under test: `2026-09-30-ai-agents-impact.sql` (table + Shape-1 RLS
 * + `partners.ai_impact_weights` + the six new source indexes). Everything
 * here runs through the REAL postgres.js driver as the unprivileged
 * `breeze_app` role, so RLS, the CHECK constraints, the jsonb lateral arms and
 * the UTC bucketing are genuinely exercised — none of which the mocked unit
 * suites (`impactRollup.test.ts`, `impactQuery.test.ts`, `impactWeights.test.ts`)
 * can see, because they assert the SHAPE of the generated SQL rather than what
 * Postgres does with it.
 *
 * What only a live database can prove, case by case:
 *
 *  1. **Every counter fires, and only on the rows that qualify.** One org, a
 *     deliberately NON-UNIFORM fixture spread over three distinct UTC days,
 *     with a negative control beside every positive one (an errored triage
 *     run, a triage run with no `ticketProposal`, an `active` draft, a
 *     proposal that already carries an `intentId`, a `manage_alerts` proposal,
 *     a verify-FAILED execution, an execution with no `actOpKey`, a narrative
 *     run with no `report_run_id`, a watch in a non-terminal state). All
 *     eleven stored columns are asserted exactly, per day.
 *  2. **UTC bucketing.** A verdict at `23:59:59Z` and one at `00:00:01Z` the next
 *     day land in DIFFERENT buckets, and the whole rebuild produces byte-identical
 *     counters when the server session's `TimeZone` is `America/New_York` — for
 *     `rebuildOrgImpactRange` AND for `loadImpactSummary`'s own live feedback
 *     read, whose bounds live in a different file (`impactQuery.ts`). This is
 *     the `date_trunc('day', <timestamptz>)` trap: `date_trunc` follows the
 *     session timezone a self-hoster can change, so it would silently re-bucket
 *     an entire fleet's history. A mocked test cannot observe a session GUC.
 *  2b. **The half-open UPPER bound covers all of `through`.** Every window the
 *     rollup worker opens ENDS on `through` (the last complete UTC day), so
 *     `< (through::date + 1)` — not `< through::date` — is what makes the final
 *     day count at all. A dedicated case rebuilds a range that ENDS on the day
 *     carrying one fact per source CTE, so dropping the `+ 1` anywhere zeroes a
 *     counter; `findImpactSourceOrgIds` gets the same treatment.
 *  3. **Zero-emitting day grid.** A day with no facts gets an explicit all-zero
 *     row, and re-running the rebuild after DELETING a day's facts RESETS that
 *     day to zero instead of leaving a stale nonzero bucket behind.
 *  4. **Idempotency.** Two rebuilds over the same range yield identical
 *     counters and a strictly later `rebuilt_at`.
 *  5. **Org isolation** of the rebuild, and the **RLS forge**: a cross-org
 *     SELECT reads zero rows and a cross-org INSERT is 42501.
 *  6. **Registry contracts**: `cascadeDeleteOrg` erases the rows with no FK
 *     violation (CORE_ORG_CASCADE_DELETE_ORDER), and `executeOrgMerge` leaves
 *     the loser's rows under the loser shell without touching the survivor's
 *     (orgMergeRegistry `leave-for-erasure`).
 *  7. **Partner-axis weights read from an ORGANIZATION-scoped context.** An
 *     org-scoped RLS context has `accessible_partner_ids = []` and reads ZERO
 *     ROWS from `partners` — not an error (#2822). Without
 *     `readWithPartnerAxisVisibility` the weights silently collapse to the
 *     defaults for exactly the population the feature serves, and a mocked-DB
 *     test cannot see it.
 *  8. **Read-time re-pricing.** `loadImpactSummary` returns a different
 *     `totals.estSecondsSaved` before and after a weight change with NO rollup
 *     re-run — the whole reason `est_seconds_saved` is not a stored column.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import {
  DEFAULT_IMPACT_WEIGHTS,
  estimateSecondsSaved,
  type AiAgentImpactCounters,
} from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentFixWatches,
  aiAgentImpactDaily,
  aiAgentRuns,
  aiAgents,
  aiAlertVerdicts,
  alertCorrelationGroups,
  organizations,
  partners,
  reportRuns,
  reports,
  ticketDrafts,
  tickets,
} from '../../db/schema';
import type { NewActionIntent } from '../../db/schema/actionIntents';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { loadImpactSummary } from '../../services/aiAgents/impactQuery';
import {
  findImpactSourceOrgIds,
  lastCompleteUtcDay,
  rebuildOrgImpactRange,
  shiftUtcDay,
  type UtcDay,
} from '../../services/aiAgents/impactRollup';
import { loadImpactWeights } from '../../services/aiAgents/impactWeights';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { createOrganization, createPartner, createUser } from './db-utils';

// ---------------------------------------------------------------------------
// Day grid. Every fixture timestamp is pinned to an explicit UTC instant.
// ---------------------------------------------------------------------------

const THROUGH: UtcDay = lastCompleteUtcDay();
const FROM: UtcDay = shiftUtcDay(THROUGH, -6);
const DAY_A: UtcDay = shiftUtcDay(THROUGH, -4);
const DAY_B: UtcDay = shiftUtcDay(THROUGH, -3);
const DAY_C: UtcDay = shiftUtcDay(THROUGH, -2);

/** An explicit UTC instant on `day`. Never a local-time constructor. */
function at(day: UtcDay, hhmmss: string): Date {
  return new Date(`${day}T${hhmmss}Z`);
}

/** Two members of IMPACT_FIX_TOOLS and one tool that is deliberately NOT one. */
const FIX_TOOL = 'run_script';
const FIX_TOOL_ALT = 'disk_cleanup';
const NON_FIX_TOOL = 'manage_alerts';

type StoredCounters = AiAgentImpactCounters & { llmCents: number };

const ZERO: StoredCounters = {
  alertsJudged: 0,
  noiseFlagged: 0,
  suppressionsApplied: 0,
  ticketsTriaged: 0,
  draftsSent: 0,
  fixesProposed: 0,
  fixesExecuted: 0,
  fixWatchesHeld: 0,
  fixWatchesRecurred: 0,
  narrativesDelivered: 0,
  llmCents: 0,
};

/**
 * The exact per-day expectation for `seedFullFixture` over [FROM, THROUGH].
 *
 * Non-uniform by construction: no two counters share a value on the same day
 * and no day repeats another day's shape, so a transposed column or a
 * copy-pasted CTE cannot pass by coincidence.
 *
 *   DAY_A  3 verdicts (2 of them noise classifications), 1 narrative delivered
 *          (a second narrative run has no report_run_id and must NOT count).
 *          llm_cents 26 = 5 + 7 + 3 + 11 — the 11 belongs to a triage run
 *          QUEUED on DAY_A but FINISHED on DAY_B, which is what pins cost
 *          attribution to queued_at rather than finished_at.
 *   DAY_B  2 triage runs carrying a ticketProposal (a third has error_code set,
 *          a fourth has no ticketProposal — neither counts); 2 consumed drafts
 *          (a third is still active). llm_cents 49 = 13 + 17 + 19.
 *   DAY_C  1 suppression; fixes_proposed 3 = two agent fix intents (BOTH count,
 *          the completed one included — arm (a) counts a proposal by created_at
 *          regardless of what later became of it) + one `intentId: null`
 *          jsonb proposal (the sibling entries that carry an intentId, or name
 *          a non-fix tool, are excluded); fixes_executed 2 = one completed fix
 *          intent + one act-mode execution that both succeeded AND verified;
 *          1 held watch, 1 recurred watch (a third watch is still pending).
 *          llm_cents 161 = 23 + 29 + 31 + 37 + 41.
 */
const EXPECTED_BY_DAY: ReadonlyArray<{ day: UtcDay; counters: StoredCounters }> = [
  { day: shiftUtcDay(THROUGH, -6), counters: ZERO },
  { day: shiftUtcDay(THROUGH, -5), counters: ZERO },
  { day: DAY_A, counters: { ...ZERO, alertsJudged: 3, noiseFlagged: 2, narrativesDelivered: 1, llmCents: 26 } },
  { day: DAY_B, counters: { ...ZERO, ticketsTriaged: 2, draftsSent: 2, llmCents: 49 } },
  {
    day: DAY_C,
    counters: {
      ...ZERO,
      suppressionsApplied: 1,
      fixesProposed: 3,
      fixesExecuted: 2,
      fixWatchesHeld: 1,
      fixWatchesRecurred: 1,
      llmCents: 161,
    },
  },
  { day: shiftUtcDay(THROUGH, -1), counters: ZERO },
  { day: THROUGH, counters: ZERO },
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function orgDbContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

function orgAuth(orgId: string, partnerId: string, userId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'impact-reader@example.test', name: 'Impact Reader', isPlatformAdmin: false },
    token: null,
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

interface Tenant {
  partnerId: string;
  orgId: string;
  userId: string;
  agentId: string;
}

/** A partner + org + user + org-owned agent. Pass `partnerId` for a sibling org under an existing partner. */
async function createTenant(partnerId?: string): Promise<Tenant> {
  const adminDb = getTestDb() as any;
  const owner = partnerId ?? (await createPartner()).id;
  const org = await createOrganization({ partnerId: owner });
  const user = await createUser({
    partnerId: owner,
    orgId: org.id,
    email: `impact-${randomUUID().slice(0, 8)}@example.test`,
  });
  const [agent] = await adminDb
    .insert(aiAgents)
    .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Impact fixture agent', createdBy: user.id })
    .returning();
  return { partnerId: owner, orgId: org.id, userId: user.id, agentId: agent.id };
}

interface RunOptions {
  profile: 'full' | 'verdict' | 'sweep' | 'narrative' | 'triage';
  queuedAt: Date;
  finishedAt?: Date | null;
  costCents: number;
  status?: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed';
  modeAtStart?: 'shadow' | 'act';
  outcome?: Record<string, unknown>;
  errorCode?: string | null;
  reportRunId?: string | null;
}

async function insertRun(t: Tenant, options: RunOptions): Promise<string> {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb
    .insert(aiAgentRuns)
    .values({
      agentId: t.agentId,
      orgId: t.orgId,
      profile: options.profile,
      triggerKind: 'manual',
      dedupeKey: `impact-${randomUUID()}`,
      modeAtStart: options.modeAtStart ?? 'shadow',
      policySnapshot: { schemaVersion: 1 } as never,
      status: options.status ?? 'completed',
      outcome: options.outcome ?? {},
      costCents: options.costCents,
      errorCode: options.errorCode ?? null,
      reportRunId: options.reportRunId ?? null,
      queuedAt: options.queuedAt,
      finishedAt: options.finishedAt ?? null,
    })
    .returning({ id: aiAgentRuns.id });
  return row.id as string;
}

async function insertAgentIntent(
  t: Tenant,
  runId: string,
  values: {
    actionName: string;
    args?: Record<string, unknown>;
    status: 'pending_approval' | 'completed';
    createdAt: Date;
    executedAt?: Date | null;
  },
): Promise<string> {
  const adminDb = getTestDb() as any;
  const intent: NewActionIntent = {
    orgId: t.orgId,
    partnerId: t.partnerId,
    requestedByUserId: null,
    requestingApiKeyId: null,
    requestingAgentRunId: runId,
    source: 'ai_agent',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: t.agentId,
    actionName: values.actionName,
    actionVersion: 1,
    arguments: values.args ?? {},
    argumentDigest: 'b'.repeat(64),
    targetSummary: 'impact fixture target',
    impactSummary: 'impact fixture impact',
    reason: 'impact fixture',
    riskTier: 3,
    idempotencyKey: `impact-idem-${randomUUID()}`,
    correlationId: randomUUID(),
    status: values.status,
    createdAt: values.createdAt,
    executedAt: values.executedAt ?? null,
    expiresAt: new Date(values.createdAt.getTime() + 60 * 60 * 1000),
  };
  const [row] = await adminDb.insert(actionIntents).values(intent).returning({ id: actionIntents.id });
  return row.id as string;
}

async function insertVerdict(
  t: Tenant,
  runId: string,
  values: {
    classification: 'actionable' | 'transient_self_healed' | 'recurring_pattern' | 'duplicate_of_group' | 'needs_human';
    createdAt: Date;
    feedback?: 'up' | 'down' | null;
    feedbackAt?: Date | null;
  },
): Promise<void> {
  const adminDb = getTestDb() as any;
  // A correlation group (not an alert) is the verdict target on purpose:
  // `alerts.device_id` is NOT NULL, so an alert-backed verdict would drag a
  // site + device fixture in for no coverage gain. The rollup treats both
  // targets identically — it counts rows, never the target column.
  const [group] = await adminDb
    .insert(alertCorrelationGroups)
    .values({
      orgId: t.orgId,
      groupKey: `impact-group-${randomUUID()}`,
      firstSeenAt: values.createdAt,
      lastSeenAt: values.createdAt,
    })
    .returning({ id: alertCorrelationGroups.id });
  await adminDb.insert(aiAlertVerdicts).values({
    orgId: t.orgId,
    runId,
    correlationGroupId: group.id,
    classification: values.classification,
    confidence: '0.90',
    rationale: 'impact fixture rationale',
    feedback: values.feedback ?? null,
    feedbackAt: values.feedbackAt ?? null,
    createdAt: values.createdAt,
  });
}

async function insertWatch(
  t: Tenant,
  runId: string,
  state: 'pending' | 'held_qualified' | 'recurred',
  evaluatedAt: Date,
): Promise<void> {
  const adminDb = getTestDb() as any;
  await adminDb.insert(aiAgentFixWatches).values({
    orgId: t.orgId,
    partnerId: t.partnerId,
    agentId: t.agentId,
    runId,
    deviceId: randomUUID(),
    state,
    evaluatedAt,
  });
}

async function insertTicket(t: Tenant): Promise<string> {
  const adminDb = getTestDb() as any;
  const [ticket] = await adminDb
    .insert(tickets)
    .values({
      orgId: t.orgId,
      partnerId: t.partnerId,
      ticketNumber: `IMP-${randomUUID().slice(0, 12)}`,
      subject: 'impact fixture ticket',
      source: 'manual',
    })
    .returning({ id: tickets.id });
  return ticket.id as string;
}

async function insertNarrativeReportRun(t: Tenant): Promise<string> {
  const adminDb = getTestDb() as any;
  const [report] = await adminDb
    .insert(reports)
    .values({ orgId: t.orgId, name: 'impact fixture narrative', type: 'ai_org_narrative' })
    .returning({ id: reports.id });
  const [run] = await adminDb
    .insert(reportRuns)
    .values({ reportId: report.id, status: 'completed' })
    .returning({ id: reportRuns.id });
  return run.id as string;
}

/**
 * The full non-uniform fixture EXPECTED_BY_DAY describes.
 */
async function seedFullFixture(t: Tenant): Promise<void> {
  const adminDb = getTestDb() as any;

  // ---- DAY_A: verdicts + narratives -------------------------------------
  const verdictRunId = await insertRun(t, {
    profile: 'verdict',
    queuedAt: at(DAY_A, '08:00:00'),
    finishedAt: at(DAY_A, '08:05:00'),
    costCents: 3,
  });
  await insertVerdict(t, verdictRunId, {
    classification: 'transient_self_healed',
    createdAt: at(DAY_A, '08:10:00'),
    feedback: 'up',
    feedbackAt: at(DAY_A, '09:00:00'),
  });
  await insertVerdict(t, verdictRunId, {
    classification: 'recurring_pattern',
    createdAt: at(DAY_A, '08:20:00'),
    feedback: 'up',
    feedbackAt: at(DAY_A, '09:10:00'),
  });
  // `actionable` is NOT a noise classification — alerts_judged counts it,
  // noise_flagged must not.
  await insertVerdict(t, verdictRunId, {
    classification: 'actionable',
    createdAt: at(DAY_A, '08:30:00'),
    feedback: 'down',
    feedbackAt: at(DAY_A, '09:20:00'),
  });

  const reportRunId = await insertNarrativeReportRun(t);
  await insertRun(t, {
    profile: 'narrative',
    queuedAt: at(DAY_A, '09:00:00'),
    finishedAt: at(DAY_A, '10:00:00'),
    costCents: 5,
    reportRunId,
  });
  // Negative control: a narrative run that produced no artifact.
  await insertRun(t, {
    profile: 'narrative',
    queuedAt: at(DAY_A, '10:00:00'),
    finishedAt: at(DAY_A, '11:00:00'),
    costCents: 7,
    reportRunId: null,
  });

  // ---- DAY_B: triage + drafts -------------------------------------------
  // Queued on DAY_A, finished on DAY_B: its cost belongs to DAY_A, its
  // tickets_triaged credit to DAY_B.
  await insertRun(t, {
    profile: 'triage',
    queuedAt: at(DAY_A, '23:00:00'),
    finishedAt: at(DAY_B, '09:00:00'),
    costCents: 11,
    outcome: { ticketProposal: { subject: 'proposal' } },
  });
  await insertRun(t, {
    profile: 'triage',
    queuedAt: at(DAY_B, '09:30:00'),
    finishedAt: at(DAY_B, '10:00:00'),
    costCents: 13,
    status: 'awaiting_approval',
    outcome: { ticketProposal: { subject: 'proposal awaiting approval' } },
  });
  // Negative control: errored run, still carrying a proposal.
  await insertRun(t, {
    profile: 'triage',
    queuedAt: at(DAY_B, '10:30:00'),
    finishedAt: at(DAY_B, '11:00:00'),
    costCents: 17,
    outcome: { ticketProposal: { subject: 'errored proposal' } },
    errorCode: 'tool_failed',
  });
  // Negative control: completed triage run with no proposal at all.
  await insertRun(t, {
    profile: 'triage',
    queuedAt: at(DAY_B, '11:30:00'),
    finishedAt: at(DAY_B, '12:00:00'),
    costCents: 19,
    outcome: {},
  });

  const ticketId = await insertTicket(t);
  await adminDb.insert(ticketDrafts).values([
    {
      orgId: t.orgId,
      ticketId,
      kind: 'reply',
      content: 'consumed draft one',
      state: 'consumed',
      consumedBy: t.userId,
      consumedAt: at(DAY_B, '13:00:00'),
    },
    {
      orgId: t.orgId,
      ticketId,
      kind: 'reply',
      content: 'consumed draft two',
      state: 'consumed',
      consumedBy: t.userId,
      consumedAt: at(DAY_B, '14:00:00'),
    },
    // Negative control: never consumed.
    { orgId: t.orgId, ticketId, kind: 'resolution_note', content: 'active draft', state: 'active' },
  ]);

  // ---- DAY_C: suppression, fixes, watches --------------------------------
  const intentRunId = await insertRun(t, {
    profile: 'full',
    queuedAt: at(DAY_C, '08:00:00'),
    finishedAt: at(DAY_C, '09:00:00'),
    costCents: 23,
    outcome: {
      proposedActions: [
        // Counts: a Tier-2 proposal that never minted an intent.
        { tool: FIX_TOOL, intentId: null, summary: 'clean disk' },
        // Excluded: already represented by arm (a) via its intent.
        { tool: FIX_TOOL_ALT, intentId: randomUUID(), summary: 'already an intent' },
        // Excluded: not a fix tool.
        { tool: NON_FIX_TOOL, intentId: null, summary: 'suppress an alert' },
      ],
    },
  });
  await insertRun(t, {
    profile: 'full',
    modeAtStart: 'act',
    queuedAt: at(DAY_C, '09:00:00'),
    finishedAt: at(DAY_C, '10:00:00'),
    costCents: 29,
    outcome: {
      executedActions: [
        // Counts: succeeded AND verified.
        { actOpKey: 'op-verified', tool: FIX_TOOL, execution: 'succeeded', verification: 'passed' },
        // Excluded: verification failed — computeRunVerdict does not treat this as clean.
        { actOpKey: 'op-unverified', tool: FIX_TOOL, execution: 'succeeded', verification: 'failed' },
        // Excluded: the execution itself failed.
        { actOpKey: 'op-failed', tool: FIX_TOOL, execution: 'failed' },
        // Excluded: no actOpKey, so it is not an act-lane operation at all.
        { tool: FIX_TOOL, execution: 'succeeded', verification: 'passed' },
      ],
    },
  });

  await insertAgentIntent(t, intentRunId, {
    actionName: NON_FIX_TOOL,
    args: { action: 'suppress', alertId: randomUUID() },
    status: 'completed',
    createdAt: at(DAY_C, '12:30:00'),
    executedAt: at(DAY_C, '13:00:00'),
  });
  await insertAgentIntent(t, intentRunId, {
    actionName: FIX_TOOL,
    status: 'pending_approval',
    createdAt: at(DAY_C, '14:00:00'),
  });
  await insertAgentIntent(t, intentRunId, {
    actionName: FIX_TOOL_ALT,
    status: 'completed',
    createdAt: at(DAY_C, '14:30:00'),
    executedAt: at(DAY_C, '15:00:00'),
  });

  const watchRun1 = await insertRun(t, { profile: 'full', queuedAt: at(DAY_C, '11:00:00'), costCents: 31 });
  const watchRun2 = await insertRun(t, { profile: 'full', queuedAt: at(DAY_C, '12:00:00'), costCents: 37 });
  const watchRun3 = await insertRun(t, { profile: 'full', queuedAt: at(DAY_C, '13:00:00'), costCents: 41 });
  await insertWatch(t, watchRun1, 'held_qualified', at(DAY_C, '16:00:00'));
  await insertWatch(t, watchRun2, 'recurred', at(DAY_C, '17:00:00'));
  // Negative control: evaluated, but in neither terminal state.
  await insertWatch(t, watchRun3, 'pending', at(DAY_C, '18:00:00'));
}

/**
 * Expectations for `seedBoundaryFixture`, which places EVERY source fact one
 * second past a UTC midnight so a session-dependent bucketing expression moves
 * it into the previous bucket.
 *
 * DAY_A carries the two verdicts that straddle a midnight: one at `00:00:01Z`
 * and one at `23:59:59Z`. The `23:59:59Z` one and DAY_B's `00:00:01Z` one are
 * the mandated adjacent-second pair — they must land in DIFFERENT buckets
 * (2 and 1, never 3 and 0).
 *
 * DAY_C carries a single verdict at `23:59:59Z`, on the LAST day of the
 * `DAY_A..DAY_C` rebuild range: it is what makes the half-open upper bound
 * `< (toDay::date + 1)` load-bearing in the verdicts CTE.
 */
const BOUNDARY_EXPECTED_DAY_A: StoredCounters = { ...ZERO, alertsJudged: 2, llmCents: 5 };
const BOUNDARY_EXPECTED_DAY_C: StoredCounters = { ...ZERO, alertsJudged: 1 };
const BOUNDARY_EXPECTED_DAY_B: StoredCounters = {
  alertsJudged: 1,
  noiseFlagged: 1,
  suppressionsApplied: 1,
  ticketsTriaged: 1,
  draftsSent: 1,
  fixesProposed: 2,
  fixesExecuted: 2,
  fixWatchesHeld: 1,
  fixWatchesRecurred: 1,
  narrativesDelivered: 1,
  llmCents: 90,
};

/**
 * `loadImpactSummary`'s live feedback read over `seedBoundaryFixture`. The two
 * verdicts sit on the exact edges of the query's own `[FROM, THROUGH]` window,
 * so this value dies if either bound in `impactQuery.ts` regresses: the `up`
 * disappears when the lower bound drifts (the `::timestamp` overload pin) and
 * the `down` disappears when the upper bound loses its `+ 1`.
 */
const BOUNDARY_EXPECTED_FEEDBACK = { up: 1, down: 1, rate: 0.5 };

/**
 * One fact per source CTE, each at `00:00:01Z` — the instant a UTC-4/-5 session
 * still calls the PREVIOUS day. The DAY_A verdicts additionally sit on the
 * rebuild range's lower edge, so a session-dependent range bound (`<day>::timestamptz`
 * instead of `(<day>::date)::timestamp AT TIME ZONE 'UTC'`) drops them out of
 * the window entirely.
 *
 * Three extra verdicts carry the bounds the rest of the fixture cannot reach:
 *
 *  - `DAY_A 23:59:59Z` — the last second of a bucket, one second-ish from the
 *    `DAY_B 00:00:01Z` verdict above. They must land in different buckets.
 *  - `DAY_C 23:59:59Z` — the last second of the `DAY_A..DAY_C` rebuild range,
 *    so the half-open upper bound has to reach past `toDay`'s own midnight.
 *  - a feedback pair on the edges of `loadImpactSummary`'s OWN `[FROM, THROUGH]`
 *    window (`FROM 00:00:01Z` up, `THROUGH 23:59:59Z` down). Those two bounds
 *    live in `impactQuery.ts`, not the rollup, and are reached only by
 *    `loadImpactSummary` — a mid-range `feedback_at` leaves them untested.
 *    Both sit OUTSIDE `DAY_A..DAY_C`, so they never perturb a rollup counter.
 */
async function seedBoundaryFixture(t: Tenant): Promise<void> {
  const adminDb = getTestDb() as any;
  const edgeA = at(DAY_A, '00:00:01');
  const edge = at(DAY_B, '00:00:01');

  const verdictRunId = await insertRun(t, { profile: 'verdict', queuedAt: edgeA, costCents: 5 });
  await insertVerdict(t, verdictRunId, { classification: 'actionable', createdAt: edgeA });
  // The `23:59:59Z` half of the adjacent-second pair; still DAY_A.
  await insertVerdict(t, verdictRunId, { classification: 'actionable', createdAt: at(DAY_A, '23:59:59') });
  await insertVerdict(t, verdictRunId, { classification: 'transient_self_healed', createdAt: edge });
  // The last second of the DAY_A..DAY_C rebuild range.
  await insertVerdict(t, verdictRunId, { classification: 'needs_human', createdAt: at(DAY_C, '23:59:59') });

  // Feedback bounds for impactQuery.ts. Deliberately outside DAY_A..DAY_C.
  const feedbackRunId = await insertRun(t, { profile: 'verdict', queuedAt: at(FROM, '00:00:01'), costCents: 0 });
  await insertVerdict(t, feedbackRunId, {
    classification: 'actionable',
    createdAt: at(FROM, '00:00:01'),
    feedback: 'up',
    feedbackAt: at(FROM, '00:00:01'),
  });
  await insertVerdict(t, feedbackRunId, {
    classification: 'actionable',
    createdAt: at(THROUGH, '23:59:59'),
    feedback: 'down',
    feedbackAt: at(THROUGH, '23:59:59'),
  });

  await insertRun(t, {
    profile: 'triage',
    queuedAt: edge,
    finishedAt: edge,
    costCents: 7,
    outcome: { ticketProposal: { subject: 'boundary proposal' } },
  });
  await insertRun(t, {
    profile: 'narrative',
    queuedAt: edge,
    finishedAt: edge,
    costCents: 11,
    reportRunId: await insertNarrativeReportRun(t),
  });
  const proposalRunId = await insertRun(t, {
    profile: 'full',
    queuedAt: edge,
    finishedAt: edge,
    costCents: 13,
    outcome: { proposedActions: [{ tool: FIX_TOOL, intentId: null }] },
  });
  await insertRun(t, {
    profile: 'full',
    modeAtStart: 'act',
    queuedAt: edge,
    finishedAt: edge,
    costCents: 17,
    outcome: { executedActions: [{ actOpKey: 'boundary-op', execution: 'succeeded', verification: 'passed' }] },
  });

  await insertAgentIntent(t, proposalRunId, {
    actionName: NON_FIX_TOOL,
    args: { action: 'suppress', alertId: randomUUID() },
    status: 'completed',
    createdAt: edge,
    executedAt: edge,
  });
  await insertAgentIntent(t, proposalRunId, {
    actionName: FIX_TOOL_ALT,
    status: 'completed',
    createdAt: edge,
    executedAt: edge,
  });

  const ticketId = await insertTicket(t);
  await adminDb.insert(ticketDrafts).values({
    orgId: t.orgId,
    ticketId,
    kind: 'reply',
    content: 'boundary draft',
    state: 'consumed',
    consumedBy: t.userId,
    consumedAt: edge,
  });

  const heldRunId = await insertRun(t, { profile: 'full', queuedAt: edge, costCents: 19 });
  const recurredRunId = await insertRun(t, { profile: 'full', queuedAt: edge, costCents: 23 });
  await insertWatch(t, heldRunId, 'held_qualified', edge);
  await insertWatch(t, recurredRunId, 'recurred', edge);
}

/** Every stored row for `orgId`, ordered by day, read with the privileged client. */
async function readStoredRows(orgId: string) {
  const adminDb = getTestDb() as any;
  return (await adminDb
    .select()
    .from(aiAgentImpactDaily)
    .where(eq(aiAgentImpactDaily.orgId, orgId))
    .orderBy(asc(aiAgentImpactDaily.day))) as Array<Record<string, unknown>>;
}

function countersOf(row: Record<string, unknown>): StoredCounters {
  return {
    alertsJudged: row.alertsJudged as number,
    noiseFlagged: row.noiseFlagged as number,
    suppressionsApplied: row.suppressionsApplied as number,
    ticketsTriaged: row.ticketsTriaged as number,
    draftsSent: row.draftsSent as number,
    fixesProposed: row.fixesProposed as number,
    fixesExecuted: row.fixesExecuted as number,
    fixWatchesHeld: row.fixWatchesHeld as number,
    fixWatchesRecurred: row.fixWatchesRecurred as number,
    narrativesDelivered: row.narrativesDelivered as number,
    llmCents: row.llmCents as number,
  };
}

/** postgres.js surfaces the real policy/constraint error on `.cause`. */
async function captureDbErrorCause(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

function firstRow<T = Record<string, unknown>>(result: unknown): T {
  const rows = (result as { rows?: T[] }).rows ?? result;
  return (rows as T[])[0]!;
}

// ---------------------------------------------------------------------------
// Session-timezone control (the date_trunc trap)
// ---------------------------------------------------------------------------

/**
 * Runs `fn` with the SERVER SESSION timezone of the application pool set to
 * `tz`.
 *
 * `SET LOCAL` cannot reach the rollup: `rebuildOrgImpactRange` opens its own
 * transaction on its own pooled connection (`runOutsideDbContext` +
 * `withSystemDbAccessContext`), so a GUC set in an outer context is invisible
 * to it. The database-level default plus a forced reconnect is the only lever
 * that actually changes the session the rollup's statement runs in. Both the
 * ALTER and the reconnect are undone in a `finally`, and integration files run
 * one at a time (`fileParallelism: false`), so no concurrent suite can observe
 * the window.
 */
async function withAppSessionTimeZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const adminDb = getTestDb() as any;
  const dbName = String(firstRow(await adminDb.execute(sql`SELECT current_database() AS name`)).name);
  // current_database() is not attacker-controlled, but the identifier is
  // interpolated rather than bound, so assert its shape before splicing it in.
  expect(dbName).toMatch(/^[A-Za-z0-9_]+$/);
  const appRole = String(
    firstRow(await withSystemDbAccessContext(() => db.execute(sql`SELECT current_user AS role`))).role,
  );

  const recycleAppConnections = async () => {
    await adminDb.execute(sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND usename = ${appRole} AND pid <> pg_backend_pid()
    `);
    // postgres.js reconnects lazily; the first query after a terminate can
    // still surface the closed socket, so warm the pool before the assertions.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await withSystemDbAccessContext(() => db.execute(sql`SELECT 1`));
        return;
      } catch {
        // fall through and retry on a freshly opened connection
      }
    }
    await withSystemDbAccessContext(() => db.execute(sql`SELECT 1`));
  };

  await adminDb.execute(sql.raw(`ALTER DATABASE "${dbName}" SET TimeZone TO '${tz}'`));
  await recycleAppConnections();
  try {
    return await fn();
  } finally {
    await adminDb.execute(sql.raw(`ALTER DATABASE "${dbName}" RESET TimeZone`));
    await recycleAppConnections();
  }
}

// `withAppSessionTimeZone` restores the default itself; this is the belt-and-
// braces net for a failure that escapes between the ALTER and the try block.
afterEach(async () => {
  const adminDb = getTestDb() as any;
  const dbName = String(firstRow(await adminDb.execute(sql`SELECT current_database() AS name`)).name);
  if (/^[A-Za-z0-9_]+$/.test(dbName)) {
    await adminDb.execute(sql.raw(`ALTER DATABASE "${dbName}" RESET TimeZone`));
  }
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('ai_agent_impact_daily — rollup counters against live Postgres', () => {
  it('computes every one of the eleven stored columns from every source, and excludes every non-qualifying row', async () => {
    const t = await createTenant();
    await seedFullFixture(t);

    const result = await rebuildOrgImpactRange(t.orgId, FROM, THROUGH);
    expect(result).toEqual({ orgId: t.orgId, fromDay: FROM, toDay: THROUGH, days: 7 });

    const rows = await readStoredRows(t.orgId);
    expect(rows.map((r) => r.day)).toEqual(EXPECTED_BY_DAY.map((e) => e.day));
    for (const [index, expected] of EXPECTED_BY_DAY.entries()) {
      expect(countersOf(rows[index]!), `counters for ${expected.day}`).toEqual(expected.counters);
    }
  });

  it('buckets every source at the UTC midnight boundary, not the session-local one', async () => {
    const t = await createTenant();
    await seedBoundaryFixture(t);

    await rebuildOrgImpactRange(t.orgId, DAY_A, DAY_C);

    const rows = await readStoredRows(t.orgId);
    expect(rows.map((r) => r.day)).toEqual([DAY_A, DAY_B, DAY_C]);
    expect(countersOf(rows[0]!)).toEqual(BOUNDARY_EXPECTED_DAY_A);
    expect(countersOf(rows[1]!)).toEqual(BOUNDARY_EXPECTED_DAY_B);
    // NOT zero: the DAY_C verdict sits at 23:59:59Z, the last second of the
    // range, so it only counts if the upper bound reaches past DAY_C midnight.
    expect(countersOf(rows[2]!)).toEqual(BOUNDARY_EXPECTED_DAY_C);

    // The adjacent-second pair, called out explicitly: a verdict at
    // DAY_A 23:59:59Z and one at DAY_B 00:00:01Z are two seconds apart and
    // MUST land in different buckets. A bucketing expression that follows the
    // session (or an off-by-one date cast) collapses this to [3, 0] or [1, 2].
    expect([countersOf(rows[0]!).alertsJudged, countersOf(rows[1]!).alertsJudged]).toEqual([2, 1]);
  });

  it('counts facts on the FINAL day of a rebuild range (the half-open upper bound spans all of `through`)', async () => {
    // Every window the rollup worker opens ends on `through`, so this is the
    // production shape — not an edge case. The range here ENDS on DAY_B, the
    // day carrying one fact per source CTE, so dropping the `+ 1` from
    // `< (toDay::date + 1)::timestamp AT TIME ZONE 'UTC'` in ANY of the nine
    // CTEs excludes the whole of DAY_B and zeroes that counter.
    const t = await createTenant();
    await seedBoundaryFixture(t);

    await rebuildOrgImpactRange(t.orgId, DAY_A, DAY_B);

    const rows = await readStoredRows(t.orgId);
    expect(rows.map((r) => r.day)).toEqual([DAY_A, DAY_B]);
    expect(countersOf(rows[1]!)).toEqual(BOUNDARY_EXPECTED_DAY_B);
  });

  it('produces identical counters when the server session timezone is America/New_York', async () => {
    // The BOUNDARY fixture, not the ordinary one, is what makes this test
    // discriminating: every fact sits one second past a UTC midnight, so under
    // a UTC-4/-5 session each one belongs to the PREVIOUS local day. A
    // `date_trunc('day', <timestamptz>)` (or a `<day>::timestamptz` range
    // bound) anywhere in the rollup moves it a bucket back. A mid-morning
    // fixture would land on the same date in both zones and would pass vacuously —
    // verified by mutation: swapping ONE CTE to date_trunc left an
    // 08:10Z-based fixture entirely green.
    const t = await createTenant();
    const t2 = await createTenant();
    await seedBoundaryFixture(t);
    await seedBoundaryFixture(t2);

    await rebuildOrgImpactRange(t.orgId, DAY_A, DAY_C);
    const utcRows = (await readStoredRows(t.orgId)).map((r) => ({ day: r.day, ...countersOf(r) }));
    expect(utcRows.some((r) => r.alertsJudged > 0)).toBe(true);

    // The rollup is not the only file with UTC range bounds: `impactQuery.ts`
    // has its own pair for the LIVE feedback read, reached only through
    // `loadImpactSummary`. Baseline them under the UTC session first.
    const utcSummary = await withDbAccessContext(orgDbContext(t.orgId), () =>
      loadImpactSummary(orgAuth(t.orgId, t.partnerId, t.userId), { window: 7, orgId: t.orgId }),
    );
    expect(utcSummary.positiveFeedback).toEqual(BOUNDARY_EXPECTED_FEEDBACK);

    const ny = await withAppSessionTimeZone('America/New_York', async () => {
      // Prove the GUC actually reached the pool the rollup runs on — otherwise
      // this whole case would pass vacuously against a UTC session.
      const shown = firstRow(await withSystemDbAccessContext(() => db.execute(sql`SHOW TimeZone`)));
      expect(shown.TimeZone).toBe('America/New_York');

      // A SECOND org rebuilt for the first time under the NY session, so the
      // comparison is not merely "an UPSERT rewrote the same values".
      await rebuildOrgImpactRange(t2.orgId, DAY_A, DAY_C);
      const rows = (await readStoredRows(t2.orgId)).map((r) => ({ day: r.day, ...countersOf(r) }));

      // Same session, the OTHER file's bounds. The `up` verdict's feedback_at
      // sits at `FROM 00:00:01Z`: under a UTC-4/-5 session an unpinned
      // `(FROM::date) AT TIME ZONE 'UTC'` lower bound moves to FROM 08:00Z and
      // silently drops it, so this read collapses to `{up: 0, down: 1, rate: 0}`.
      const summary = await withDbAccessContext(orgDbContext(t2.orgId), () =>
        loadImpactSummary(orgAuth(t2.orgId, t2.partnerId, t2.userId), { window: 7, orgId: t2.orgId }),
      );
      return { rows, summary };
    });

    expect(ny.rows).toEqual(utcRows);
    expect(ny.summary.positiveFeedback).toEqual(utcSummary.positiveFeedback);
    // The two orgs carry byte-identical fixtures, so the whole aggregate — not
    // just the feedback rate — must survive the session change.
    expect(ny.summary.totals).toEqual(utcSummary.totals);
  });
});

describe('ai_agent_impact_daily — zero grid, staleness and idempotency', () => {
  it('emits an explicit zero row for a day with no facts and RESETS a day whose facts were deleted', async () => {
    const t = await createTenant();
    await seedFullFixture(t);

    await rebuildOrgImpactRange(t.orgId, FROM, THROUGH);
    const before = await readStoredRows(t.orgId);
    expect(countersOf(before.find((r) => r.day === DAY_C)!).fixWatchesHeld).toBe(1);

    // Remove every DAY_C fact. A rebuild must reset the bucket to zero rather
    // than leave the previous nonzero counters standing.
    const adminDb = getTestDb() as any;
    await adminDb.delete(aiAgentFixWatches).where(eq(aiAgentFixWatches.orgId, t.orgId));
    await adminDb.delete(actionIntents).where(eq(actionIntents.orgId, t.orgId));
    await adminDb
      .delete(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, t.orgId), gte(aiAgentRuns.queuedAt, at(DAY_C, '00:00:00'))));

    await rebuildOrgImpactRange(t.orgId, FROM, THROUGH);

    const after = await readStoredRows(t.orgId);
    expect(after).toHaveLength(7);
    expect(countersOf(after.find((r) => r.day === DAY_C)!)).toEqual(ZERO);
    // The untouched days keep their counters — the reset is scoped, not a wipe.
    expect(countersOf(after.find((r) => r.day === DAY_A)!)).toEqual(
      EXPECTED_BY_DAY.find((e) => e.day === DAY_A)!.counters,
    );
  });

  it('is idempotent: a second rebuild yields identical counters and a strictly later rebuilt_at', async () => {
    const t = await createTenant();
    await seedFullFixture(t);

    await rebuildOrgImpactRange(t.orgId, FROM, THROUGH);
    const first = await readStoredRows(t.orgId);

    await rebuildOrgImpactRange(t.orgId, FROM, THROUGH);
    const second = await readStoredRows(t.orgId);

    expect(second).toHaveLength(first.length);
    for (const [index, row] of second.entries()) {
      expect(countersOf(row)).toEqual(countersOf(first[index]!));
      expect(row.id).toBe(first[index]!.id); // upserted in place, never re-inserted
      expect(new Date(row.rebuiltAt as string).getTime()).toBeGreaterThan(
        new Date(first[index]!.rebuiltAt as string).getTime(),
      );
    }
  });
});

describe('ai_agent_impact_daily — tenant isolation', () => {
  it('rebuilds one org without touching a sibling org under the same partner', async () => {
    const a = await createTenant();
    const b = await createTenant(a.partnerId);

    await seedFullFixture(a);
    // Org B gets a deliberately different shape: one narrative on DAY_B only.
    const reportRunId = await insertNarrativeReportRun(b);
    await insertRun(b, {
      profile: 'narrative',
      queuedAt: at(DAY_B, '08:00:00'),
      finishedAt: at(DAY_B, '08:30:00'),
      costCents: 71,
      reportRunId,
    });

    await rebuildOrgImpactRange(a.orgId, FROM, THROUGH);
    expect(await readStoredRows(b.orgId)).toEqual([]);

    await rebuildOrgImpactRange(b.orgId, FROM, THROUGH);
    const bRows = await readStoredRows(b.orgId);
    const bDayB = countersOf(bRows.find((r) => r.day === DAY_B)!);
    expect(bDayB).toEqual({ ...ZERO, narrativesDelivered: 1, llmCents: 71 });

    // Org A is unchanged by org B's rebuild.
    const aRows = await readStoredRows(a.orgId);
    for (const [index, expected] of EXPECTED_BY_DAY.entries()) {
      expect(countersOf(aRows[index]!), `org A counters for ${expected.day}`).toEqual(expected.counters);
    }
  });

  it('denies a cross-org SELECT and rejects a cross-org INSERT with 42501 (breeze_app forced RLS)', async () => {
    const adminDb = getTestDb() as any;
    const a = await createTenant();
    const b = await createTenant();

    await adminDb.insert(aiAgentImpactDaily).values({ orgId: b.orgId, day: DAY_A, alertsJudged: 9 });

    const visible = await withDbAccessContext(orgDbContext(a.orgId), () =>
      db.select({ id: aiAgentImpactDaily.id }).from(aiAgentImpactDaily).where(eq(aiAgentImpactDaily.orgId, b.orgId)),
    );
    expect(visible).toEqual([]);

    const cause = await captureDbErrorCause(() =>
      withDbAccessContext(orgDbContext(a.orgId), () =>
        db.insert(aiAgentImpactDaily).values({ orgId: b.orgId, day: DAY_B, alertsJudged: 1 }),
      ),
    );
    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message ?? '').toMatch(/new row violates row-level security policy for table "ai_agent_impact_daily"/);
  });
});

describe('ai_agent_impact_daily — org-lifecycle registry contracts', () => {
  it('cascadeDeleteOrg erases an org holding impact rows with no FK violation', async () => {
    const adminDb = getTestDb() as any;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const sibling = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({
      partnerId: partner.id,
      orgId: null,
      email: `impact-cascade-${randomUUID().slice(0, 8)}@example.test`,
    });

    await adminDb.insert(aiAgentImpactDaily).values([
      { orgId: org.id, day: DAY_A, alertsJudged: 4 },
      { orgId: sibling.id, day: DAY_A, alertsJudged: 6 },
    ]);

    const stats = await cascadeDeleteOrg(org.id, actor.id);
    expect(stats.tablesDeleted.organizations).toBe(1);
    expect(stats.tablesDeleted.ai_agent_impact_daily).toBe(1);

    expect(await readStoredRows(org.id)).toEqual([]);
    // The sibling org under the same partner is untouched.
    expect(await readStoredRows(sibling.id)).toHaveLength(1);
  });

  it('executeOrgMerge leaves the loser\'s impact rows under the loser shell and never double-counts the survivor', async () => {
    const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const adminDb = getTestDb() as any;
      const partner = await createPartner();
      const loser = await createOrganization({ partnerId: partner.id });
      const survivor = await createOrganization({ partnerId: partner.id });
      const actor = await createUser({
        partnerId: partner.id,
        orgId: null,
        email: `impact-merge-${randomUUID().slice(0, 8)}@example.test`,
      });

      await adminDb.insert(aiAgentImpactDaily).values([
        { orgId: loser.id, day: DAY_A, alertsJudged: 4 },
        { orgId: survivor.id, day: DAY_A, alertsJudged: 6 },
      ]);

      await executeOrgMerge({
        loserOrgId: loser.id,
        survivorOrgId: survivor.id,
        partnerId: partner.id,
        performedBy: actor.id,
        performedByEmail: actor.email,
      });

      // `leave-for-erasure`: the rows stay put. Repointing them would add the
      // loser's counters on top of the survivor's own for the same day.
      const loserRows = await readStoredRows(loser.id);
      expect(loserRows.map((r) => [r.day, r.alertsJudged])).toEqual([[DAY_A, 4]]);
      const survivorRows = await readStoredRows(survivor.id);
      expect(survivorRows.map((r) => [r.day, r.alertsJudged])).toEqual([[DAY_A, 6]]);
    } finally {
      if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
    }
  });
});

describe('ai_agent_impact_daily — org discovery', () => {
  it('findImpactSourceOrgIds discovers an org whose only fact in the range is a consumed draft', async () => {
    const t = await createTenant();
    const ticketId = await insertTicket(t);
    const adminDb = getTestDb() as any;
    await adminDb.insert(ticketDrafts).values({
      orgId: t.orgId,
      ticketId,
      kind: 'reply',
      content: 'the only fact this org has',
      state: 'consumed',
      consumedBy: t.userId,
      consumedAt: at(DAY_B, '09:00:00'),
    });

    // No ai_agent_runs row exists in the range at all, so a runs-only scan
    // would silently skip this org and its drafts_sent would stay at zero.
    const discovered = await findImpactSourceOrgIds(FROM, THROUGH);
    expect(discovered).toContain(t.orgId);

    // The draft sits at 09:00Z on DAY_B, the LAST day of this narrower range.
    // `findImpactSourceOrgIds` carries its own copy of the half-open bounds, so
    // this is what proves its `< (toDay::date + 1)` spans all of `toDay` —
    // without it the scan skips the org and its counters never get rebuilt.
    expect(await findImpactSourceOrgIds(FROM, DAY_B)).toContain(t.orgId);

    const outsideRange = await findImpactSourceOrgIds(
      shiftUtcDay(THROUGH, -60),
      shiftUtcDay(THROUGH, -50),
    );
    expect(outsideRange).not.toContain(t.orgId);
  });
});

describe('partners.ai_impact_weights — partner-axis read + read-time re-pricing', () => {
  it('loadImpactWeights reads the partner override from inside an ORGANIZATION-scoped RLS context', async () => {
    const adminDb = getTestDb() as any;
    const t = await createTenant();
    await adminDb
      .update(partners)
      .set({ aiImpactWeights: { fixExecuted: 1200 } })
      .where(eq(partners.id, t.partnerId));

    // An org-scoped context has accessible_partner_ids = [], so a plain read of
    // `partners` here returns ZERO ROWS (not an error) and the weights would
    // silently collapse to the defaults — #2822. Prove the escape is taken.
    const resolved = await withDbAccessContext(orgDbContext(t.orgId), () => loadImpactWeights(t.partnerId));

    expect(resolved.partnerId).toBe(t.partnerId);
    expect(resolved.overrides).toEqual({ fixExecuted: 1200 });
    expect(resolved.effective.fixExecuted).toBe(1200);
    expect(resolved.effective.alertJudged).toBe(DEFAULT_IMPACT_WEIGHTS.alertJudged);
  });

  it('re-prices history at read time: the same buckets yield a different estSecondsSaved after a weight change', async () => {
    const adminDb = getTestDb() as any;
    const t = await createTenant();
    await seedFullFixture(t);
    await rebuildOrgImpactRange(t.orgId, FROM, THROUGH);

    const auth = orgAuth(t.orgId, t.partnerId, t.userId);
    const ctx = orgDbContext(t.orgId);

    const withDefaults = await withDbAccessContext(ctx, () =>
      loadImpactSummary(auth, { window: 7, orgId: t.orgId }),
    );

    const totalCounters: AiAgentImpactCounters = {
      alertsJudged: 3,
      noiseFlagged: 2,
      suppressionsApplied: 1,
      ticketsTriaged: 2,
      draftsSent: 2,
      fixesProposed: 3,
      fixesExecuted: 2,
      fixWatchesHeld: 1,
      fixWatchesRecurred: 1,
      narrativesDelivered: 1,
    };
    expect(withDefaults.through).toBe(THROUGH);
    expect(withDefaults.series).toHaveLength(7);
    expect(withDefaults.totals).toEqual({
      ...totalCounters,
      llmCents: 236,
      estSecondsSaved: estimateSecondsSaved(totalCounters, DEFAULT_IMPACT_WEIGHTS),
    });
    // The live feedback read is against ai_alert_verdicts, not the rollup.
    expect(withDefaults.positiveFeedback).toEqual({ up: 2, down: 1, rate: 2 / 3 });
    expect(withDefaults.rebuiltAt).not.toBeNull();

    // Re-price WITHOUT re-running the rollup.
    await adminDb
      .update(partners)
      .set({ aiImpactWeights: { fixExecuted: 1200 } })
      .where(eq(partners.id, t.partnerId));

    const withOverride = await withDbAccessContext(ctx, () =>
      loadImpactSummary(auth, { window: 7, orgId: t.orgId }),
    );

    const repriced = { ...DEFAULT_IMPACT_WEIGHTS, fixExecuted: 1200 };
    expect(withOverride.weights.effective).toEqual(repriced);
    expect(withOverride.totals.estSecondsSaved).toBe(estimateSecondsSaved(totalCounters, repriced));
    expect(withOverride.totals.estSecondsSaved).toBeGreaterThan(withDefaults.totals.estSecondsSaved);
    // Same underlying buckets — only the price changed.
    expect(withOverride.totals.fixesExecuted).toBe(withDefaults.totals.fixesExecuted);
    expect(withOverride.rebuiltAt).toBe(withDefaults.rebuiltAt);
  });
});

describe('ai_agent_impact_daily — Drizzle/organizations cascade wiring', () => {
  it('drops a row when its organization row is deleted (ON DELETE CASCADE)', async () => {
    const adminDb = getTestDb() as any;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await adminDb.insert(aiAgentImpactDaily).values({ orgId: org.id, day: DAY_A, alertsJudged: 2 });

    await adminDb.delete(organizations).where(eq(organizations.id, org.id));

    expect(await readStoredRows(org.id)).toEqual([]);
  });
});
