// apps/api/src/services/aiAgents/graduationService.ts
/**
 * P2-5 (#4192, Task A2-2) — the graduation window, the eligibility ladder and
 * the `tracking -> eligible -> promoted -> demoted -> tracking` state machine.
 *
 * Reads the `ai_agent_op_evidence` ledger (A1) over a TRAILING TIMESTAMP
 * window and persists the derived state onto `ai_agent_graduation`. The
 * window's lower bound is `GREATEST(now() - interval '30 days', demoted_at)`,
 * never a day bucket: a demotion and a re-verification on the same day have
 * to be unambiguously ordered, which is exactly why the wave dropped the
 * daily-counter table for an immutable ledger (spec §4.5 amendment).
 *
 * What this module does NOT do, deliberately:
 * - It never grants or revokes a key. The AUTHORITY is
 *   `ai_agents.actAssets.supervisedActionKeys` on the ORG row; this table
 *   carries eligibility state and transition history only (spec §7, "the
 *   authority stays ai_agents.actAssets.supervisedActionKeys"). Promotion is
 *   Task 15's four-eyes executor, demotion is Task 16's negative-evidence
 *   path — `refreshGraduationRow` only ever writes `tracking` or `eligible`.
 * - It never consults `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`. Eligibility is
 *   an observation about evidence; the flag gates the promote WRITE, not the
 *   read (Task 15/18).
 *
 * Tenancy: every statement predicates on `org_id` explicitly even though it
 * runs under a system context (where RLS passes unconditionally), per the
 * wave's tenancy invariants. The partner baseline row is only visible to a
 * system or partner-axis reader, so the whole module elevates through
 * `inSystemDbContext` — the same join-or-open shape `resolveEffectiveAgentSystem`
 * and `agentCircuit` use.
 */
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  AI_AGENT_GRADUATION_MIN_AGE_DAYS,
  AI_AGENT_GRADUATION_WINDOW_DAYS,
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentActOpReliabilityDto,
  type AiAgentEvidenceMetric,
  type AiAgentGraduationBlockedReason,
  type AiAgentGraduationRowDto,
  type AiAgentGraduationState,
  type AiAgentGraduationWindow,
} from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, NOT the ../../db/schema barrel — same reason
// effectivePolicy.ts gives: this module is reachable from the intent-release
// path (Task 15/16) and pulling the barrel would force every partial-mock
// unit test of that path to stub the entire schema surface.
import { aiAgentGraduation } from '../../db/schema/aiAgentGraduation';
import { aiAgentOpEvidence } from '../../db/schema/aiAgentOpEvidence';
import { aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
// From the leaf module, NOT `policyDecidable.ts` — that module also imports
// `aiTools.ts` (for `rejectionReasonFor`, which this file never calls), and
// `aiTools.ts` transitively reaches `routes/agentWs.ts` /
// `services/agentCommandAwait.ts` via `aiToolsAgentLogs.ts` -> `commandQueue.ts`.
// This module is reachable from `jobs/aiAgentGraduationWorker.ts`, a
// `global`-placement BullMQ worker (`workerRegistry.ts`) that
// `workerEntrypointClosure.contract.test.ts` forbids from reaching
// socket-local dispatch — see `policyDecidableKeys.ts`'s header (P2-5, #4192,
// Task A2-3).
import { isPolicyDecidableKey } from '../actionIntents/policyDecidableKeys';
import { mergeAgentPolicies, normalizeAgentPolicy } from './effectivePolicy';

/** The only evidence namespace a graduation row is ever computed from. */
const GRADUATION_NAMESPACE = 'policy_key' as const;
/** The namespace `loadActOpReliability` reports on — act-mode manifest ops. */
const ACT_OP_NAMESPACE = 'act_op' as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_AGE_MS = AI_AGENT_GRADUATION_MIN_AGE_DAYS * DAY_MS;

export interface GraduationEvaluation {
  opKey: string;
  state: AiAgentGraduationState;
  window: AiAgentGraduationWindow;
  blockedReason: AiAgentGraduationBlockedReason | null;
}

/**
 * `refreshGraduationRow`'s return: a `GraduationEvaluation` plus whether the
 * persisted `state` actually moved. Task 13's daily sweep reports a `changed`
 * count and cannot derive it after the fact (the pre-refresh state is gone by
 * the time the call returns), so the writer that knows reports it.
 */
export interface GraduationRefresh extends GraduationEvaluation {
  changed: boolean;
}

export interface TrackedTuple {
  orgId: string;
  agentId: string;
  opKey: string;
}

/* ------------------------------------------------------------------ *
 * Advisory lock
 * ------------------------------------------------------------------ */

/**
 * The advisory-lock namespace string. Hashed, not a hand-picked int, so the
 * keyspace is self-describing in `pg_locks` diagnostics and can never collide
 * with a hand-assigned namespace someone else picks later.
 */
export const GRADUATION_LOCK_NAMESPACE = 'ai_agent_graduation';

/** Deterministic per-tuple lock key. Never change the separator or the order. */
export function graduationLockKey(orgId: string, agentId: string, opKey: string): string {
  return `${orgId}:${agentId}:${opKey}`;
}

/**
 * Serializes every writer of one `(org, agent, op_key)` tuple — this module's
 * refresh, Task 15's promote executor and Task 16's demote path — on
 * `pg_advisory_xact_lock`.
 *
 * MUST run inside a transaction: an xact lock taken in autocommit is released
 * by the very statement that took it, which would look like serialization and
 * provide none. Every `withDbAccessContext` IS a transaction (`db/index.ts`
 * runs the context inside `baseDb.transaction`), so the guard below keys on an
 * established context rather than sniffing the driver.
 *
 * `database` is the executor the lock statement is issued on, defaulting to
 * the ambient `db` proxy. The demote executor (`supervisedKeyDemote.ts`)
 * passes the SAVEPOINT it is running in: a nested `db.transaction` does NOT
 * rebind that proxy (`dbContextStorage` still holds the OUTER transaction),
 * so a lock taken through it would be issued on the outer scope — where
 * postgres-js records any failure and rethrows it at scope end even if the
 * caller caught it, aborting the terminal CAS the savepoint exists to
 * protect. Same parameter, and the same reason, as `insertOpEvidence`'s.
 */
export async function withGraduationLock<T>(
  orgId: string,
  agentId: string,
  opKey: string,
  fn: () => Promise<T>,
  database: Pick<typeof db, 'execute'> = db,
): Promise<T> {
  if (!getCurrentDbAccessContext()) {
    throw new Error(
      'withGraduationLock must run inside a DB access context (a transaction): '
        + 'pg_advisory_xact_lock taken in autocommit releases immediately and serializes nothing.',
    );
  }
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtext(${GRADUATION_LOCK_NAMESPACE}), hashtext(${graduationLockKey(orgId, agentId, opKey)}))`,
  );
  return fn();
}

/** Join the ambient system context, or open one. Mirrors `agentCircuit.ts`. */
async function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'aiAgents.graduation'));
}

/* ------------------------------------------------------------------ *
 * Window SQL
 * ------------------------------------------------------------------ */

/**
 * `interval '30 days'` built from the shared constant. `sql.raw` is safe here
 * and only here: the interpolated value is a module-level number from
 * `@breeze/shared`, never caller input.
 */
function windowInterval(): SQL {
  return sql.raw(`interval '${AI_AGENT_GRADUATION_WINDOW_DAYS} days'`);
}

/**
 * The ONE definition of the window's lower bound, shared by the single-tuple
 * query and the joined multi-row query so the two can never drift.
 *
 * `GREATEST` ignores NULL operands (it is null only when EVERY operand is), so
 * a never-demoted tuple correctly falls back to the trailing window with no
 * branch. `demotedAt` is passed as an expression — a bound parameter for one
 * tuple, the `ai_agent_graduation.demoted_at` column for the joined form.
 */
function windowLowerBound(demotedAt: SQL): SQL {
  return sql`GREATEST(now() - ${windowInterval()}, ${demotedAt})`;
}

/** One typed home for the `metric = '<x>'` literal, shared by every aggregate below. */
function metricFilter(metric: AiAgentEvidenceMetric): SQL {
  return sql`FILTER (WHERE ${aiAgentOpEvidence.metric} = ${metric})`;
}

function metricCount(metric: AiAgentEvidenceMetric): SQL<number> {
  return sql<number>`COUNT(*) ${metricFilter(metric)}::int`;
}

/** The four counters + the window's earliest `verified`, selected identically everywhere. */
const WINDOW_SELECT = {
  executed: metricCount('executed'),
  verified: metricCount('verified'),
  failed: metricCount('failed'),
  recurred: metricCount('recurred'),
  firstVerifiedAt: sql<unknown>`MIN(${aiAgentOpEvidence.occurredAt}) ${metricFilter('verified')}`,
} as const;

interface RawWindowRow {
  executed: number;
  verified: number;
  failed: number;
  recurred: number;
  firstVerifiedAt: unknown;
}

/** postgres.js hands back a `Date` for timestamptz; a stub may hand back a string. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toWindow(row: RawWindowRow | undefined): AiAgentGraduationWindow {
  return {
    executed: Number(row?.executed ?? 0),
    verified: Number(row?.verified ?? 0),
    failed: Number(row?.failed ?? 0),
    recurred: Number(row?.recurred ?? 0),
    firstVerifiedAt: toIso(row?.firstVerifiedAt),
  };
}

/* ------------------------------------------------------------------ *
 * The pure eligibility ladder
 * ------------------------------------------------------------------ */

export interface EligibilityInput {
  opKey: string;
  window: AiAgentGraduationWindow;
  /** The PARTNER baseline row's `actAssets.supervisedActionKeys` — the CEILING. */
  partnerCeilingKeys: string[];
  /**
   * The EFFECTIVE `actAssets.supervisedActionKeys` — the GRANT. C3: no org row
   * -> `[]`; org row -> `intersect(partner, org)`. Always the merged value from
   * `effectivePolicy.ts`, never the raw org column.
   */
  orgGrantedKeys: string[];
  /** The MAX-merged effective `limits.promoteThreshold`. */
  promoteThreshold: number;
  /** The persisted state, or null when the tuple has no row yet. */
  storedState: AiAgentGraduationState | null;
  now: Date;
}

/**
 * The five checks, in the order `blockedReason` reports them — the FIRST
 * failing check wins, so a key that is both unregistered and short of the
 * threshold reports `not_policy_decidable`, the reason a human can act on.
 *
 * `state` is derived, never stored-and-trusted:
 * - `promoted` iff the ORG row actually holds the key. The grant IS the state;
 *   a stored `promoted` whose grant has since vanished is a stale row, not a
 *   promotion.
 * - `eligible` when every check clears and the key is not yet granted.
 * - `demoted` while the tuple is stored `demoted` and the window (already
 *   bounded at `demoted_at`) holds no `verified` row yet.
 * - `tracking` otherwise.
 */
export function evaluateEligibility(input: EligibilityInput): {
  state: AiAgentGraduationState;
  blockedReason: AiAgentGraduationBlockedReason | null;
} {
  const { opKey, window, partnerCeilingKeys, orgGrantedKeys, promoteThreshold, storedState, now } = input;

  const blockedReason = firstBlockedReason(opKey, window, partnerCeilingKeys, promoteThreshold, now);
  if (orgGrantedKeys.includes(opKey)) return { state: 'promoted', blockedReason };
  if (blockedReason === null) return { state: 'eligible', blockedReason: null };
  if (storedState === 'demoted' && window.verified === 0) return { state: 'demoted', blockedReason };
  return { state: 'tracking', blockedReason };
}

function firstBlockedReason(
  opKey: string,
  window: AiAgentGraduationWindow,
  partnerCeilingKeys: string[],
  promoteThreshold: number,
  now: Date,
): AiAgentGraduationBlockedReason | null {
  if (!isPolicyDecidableKey(opKey)) return 'not_policy_decidable';
  if (!partnerCeilingKeys.includes(opKey)) return 'needs_partner_baseline';
  if (window.failed > 0 || window.recurred > 0) return 'has_failures';
  if (window.verified < promoteThreshold) return 'below_threshold';
  if (window.firstVerifiedAt === null) return 'too_recent';
  const firstVerifiedMs = new Date(window.firstVerifiedAt).getTime();
  if (Number.isNaN(firstVerifiedMs) || now.getTime() - firstVerifiedMs < MIN_AGE_MS) return 'too_recent';
  return null;
}

/* ------------------------------------------------------------------ *
 * Policy context (partner ceiling, org grant, effective threshold)
 * ------------------------------------------------------------------ */

interface GraduationPolicyContext {
  partnerCeilingKeys: string[];
  orgGrantedKeys: string[];
  promoteThreshold: number;
}

/** No organization or no partner baseline: nothing is granted, nothing is a ceiling. */
function emptyPolicyContext(): GraduationPolicyContext {
  return {
    partnerCeilingKeys: [],
    orgGrantedKeys: [],
    promoteThreshold: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
  };
}

/**
 * `agentId` is always the EFFECTIVE agent id, i.e. the PARTNER baseline row
 * (`resolveEffectiveAgentSystem` returns `partnerRow.id`, and every evidence
 * writer stamps that id).
 *
 * The baseline read is pinned to BOTH `org_id IS NULL` (so an org override row
 * can never be mistaken for the ceiling) AND `partner_id = <the organization's
 * partner>`, resolved through `orgId` — the same org->partner pinning
 * `resolveEffectiveAgentInner` performs. Without that second predicate this
 * loader runs under a system context (where RLS passes unconditionally) with
 * an org-unpinned read: a caller passing an `agentId` belonging to a DIFFERENT
 * partner would silently evaluate against that partner's ceiling and
 * `promoteThreshold`. A missing organization resolves to the empty context
 * below (fail closed as `needs_partner_baseline`) rather than throwing, so one
 * org deleted mid-sweep cannot abort Task 13's daily job.
 *
 * The ORG row is then found by `(org_id, kind)` — the same pairing
 * `resolveEffectiveAgentInner` uses — and `promoteThreshold` comes from
 * `mergeAgentPolicies`, so the MAX merge (`MAX_MERGED_LIMIT_KEYS`) applies:
 * a partner asking for 50 is never undercut by an org asking for 5.
 * `allowedModels: null` is correct and inert here — it only ever affects the
 * merged `model`, which this module does not read.
 *
 * `orgGrantedKeys` is the C3-CANONICAL effective set
 * (`merged.effective.actAssets.supervisedActionKeys`), never the raw org row:
 * no org row -> `[]`, org row -> `intersect(partner, org)` (effectivePolicy.ts).
 * Reading the raw org column here would be a second, local copy of the
 * grant/ceiling authority rule — and a divergent one, because a partner that
 * narrows its baseline ceiling after a promotion must stop the key reading as
 * `promoted` even while the org row still names it.
 */
async function loadPolicyContext(orgId: string, agentId: string): Promise<GraduationPolicyContext> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return emptyPolicyContext();

  const [partnerRow] = await db
    .select()
    .from(aiAgents)
    .where(and(
      eq(aiAgents.id, agentId),
      eq(aiAgents.partnerId, org.partnerId),
      isNull(aiAgents.orgId),
      isNull(aiAgents.disabledAt),
    ))
    .limit(1);

  if (!partnerRow) return emptyPolicyContext();

  const [orgRow] = await db
    .select()
    .from(aiAgents)
    .where(and(
      eq(aiAgents.orgId, orgId),
      eq(aiAgents.kind, partnerRow.kind),
      isNull(aiAgents.disabledAt),
    ))
    .limit(1);

  const partnerPolicy = normalizeAgentPolicy(partnerRow);
  const orgPolicy = orgRow ? normalizeAgentPolicy(orgRow) : null;
  const merged = mergeAgentPolicies(partnerPolicy, orgPolicy, { allowedModels: null });

  return {
    partnerCeilingKeys: partnerPolicy.actAssets.supervisedActionKeys ?? [],
    orgGrantedKeys: merged.effective.actAssets.supervisedActionKeys ?? [],
    promoteThreshold:
      merged.effective.limits.promoteThreshold ?? AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
  };
}

/* ------------------------------------------------------------------ *
 * Evaluation + persistence
 * ------------------------------------------------------------------ */

interface StoredGraduationRow {
  state: AiAgentGraduationState;
  demotedAt: Date | null;
}

async function loadStoredRow(
  orgId: string,
  agentId: string,
  opKey: string,
): Promise<StoredGraduationRow | null> {
  const [row] = await db
    .select({ state: aiAgentGraduation.state, demotedAt: aiAgentGraduation.demotedAt })
    .from(aiAgentGraduation)
    .where(and(
      eq(aiAgentGraduation.orgId, orgId),
      eq(aiAgentGraduation.agentId, agentId),
      eq(aiAgentGraduation.opKey, opKey),
    ))
    .limit(1);
  return row ?? null;
}

async function loadWindow(
  orgId: string,
  agentId: string,
  opKey: string,
  demotedAt: Date | null,
): Promise<AiAgentGraduationWindow> {
  const rows = await db
    .select(WINDOW_SELECT)
    .from(aiAgentOpEvidence)
    .where(and(
      eq(aiAgentOpEvidence.orgId, orgId),
      eq(aiAgentOpEvidence.agentId, agentId),
      eq(aiAgentOpEvidence.namespace, GRADUATION_NAMESPACE),
      eq(aiAgentOpEvidence.opKey, opKey),
      // ISO STRING, never the Date object: an inline `sql` fragment binds the
      // value raw (no column `mapToDriverValue`), and postgres.js throws
      // ERR_INVALID_ARG_TYPE ("Received an instance of Date") when the server
      // describes the placeholder as timestamptz. Caught only by executing
      // this against a real server — the compiled-SQL assertion is blind to it.
      sql`${aiAgentOpEvidence.occurredAt} > ${windowLowerBound(sql`${demotedAt === null ? null : demotedAt.toISOString()}::timestamptz`)}`,
    ));
  return toWindow((rows as RawWindowRow[])[0]);
}

async function evaluateInner(
  orgId: string,
  agentId: string,
  opKey: string,
): Promise<{ evaluation: GraduationEvaluation; stored: StoredGraduationRow | null }> {
  const stored = await loadStoredRow(orgId, agentId, opKey);
  const context = await loadPolicyContext(orgId, agentId);
  const window = await loadWindow(orgId, agentId, opKey, stored?.demotedAt ?? null);

  const { state, blockedReason } = evaluateEligibility({
    opKey,
    window,
    partnerCeilingKeys: context.partnerCeilingKeys,
    orgGrantedKeys: context.orgGrantedKeys,
    promoteThreshold: context.promoteThreshold,
    storedState: stored?.state ?? null,
    now: new Date(),
  });

  return { evaluation: { opKey, state, window, blockedReason }, stored };
}

/**
 * Read-only evaluation of one tuple against the ledger and the current
 * graduation row. Writes nothing — Task 15's promote executor calls this
 * again at RELEASE time (approval time is not execution time) inside its own
 * lock, and the daily job / read route reach it through
 * `refreshGraduationRow`.
 */
export async function evaluateGraduation(
  orgId: string,
  agentId: string,
  opKey: string,
): Promise<GraduationEvaluation> {
  return inSystemDbContext(async () => (await evaluateInner(orgId, agentId, opKey)).evaluation);
}

/**
 * Recomputes and PERSISTS one tuple's graduation row under
 * `withGraduationLock`. Called by the daily job (Task 13) and by the read
 * route (Task 18) so a read is never staler than the request.
 *
 * It moves `tracking <-> eligible` and `demoted -> tracking`, and resets
 * `first_verified_at` to the window's earliest `verified` (which, because the
 * window's lower bound IS `demoted_at`, is exactly "the first verified after
 * the demotion"). It NEVER WRITES `promoted` or `demoted` — not onto an
 * existing row (those two states are facts owned by Task 15's four-eyes
 * executor and Task 16's negative-evidence path, preserved verbatim here) and
 * not onto a new one (a seeded `promoted` would carry no `promoted_at` /
 * `promoted_intent_id` provenance at all). Neither the grant nor the demote
 * columns are touched. The RETURNED `state` is still the derived one, so a
 * grant that exists without a promotion row reads as `promoted` to callers —
 * exactly what `loadGraduationRows` serves for the same tuple.
 */
export async function refreshGraduationRow(
  orgId: string,
  agentId: string,
  opKey: string,
): Promise<GraduationRefresh> {
  return inSystemDbContext(() => withGraduationLock(orgId, agentId, opKey, async () => {
    const { evaluation, stored } = await evaluateInner(orgId, agentId, opKey);

    // Only the two DERIVED states are ever WRITTEN. `promoted`/`demoted` on an
    // existing row are left exactly as their owning path stamped them; on a row
    // that does not exist YET there is no provenance to preserve — seeding
    // `promoted` here would mint a row claiming a promotion with `promoted_at`
    // and `promoted_intent_id` NULL, which Task 15 owns and Task 16's demote
    // path may read — so a brand-new row is clamped to `tracking`/`eligible`.
    // The RETURN value still reports the derived `promoted` (the grant is the
    // authority), which is also what `loadGraduationRows` serves.
    const seedState: AiAgentGraduationState = evaluation.blockedReason === null ? 'eligible' : 'tracking';
    const persistedState: AiAgentGraduationState =
      evaluation.state === 'tracking' || evaluation.state === 'eligible'
        ? evaluation.state
        : (stored?.state ?? seedState);

    const firstVerifiedAt = evaluation.window.firstVerifiedAt === null
      ? null
      : new Date(evaluation.window.firstVerifiedAt);
    const updatedAt = new Date();

    await db
      .insert(aiAgentGraduation)
      .values({ orgId, agentId, opKey, state: persistedState, firstVerifiedAt, updatedAt })
      .onConflictDoUpdate({
        target: [aiAgentGraduation.orgId, aiAgentGraduation.agentId, aiAgentGraduation.opKey],
        set: { state: persistedState, firstVerifiedAt, updatedAt },
      });

    return {
      ...evaluation,
      changed: stored === null || stored.state !== persistedState,
    };
  }));
}

/**
 * The daily job's work list: every `(org, agent, op_key)` with at least one
 * `policy_key` evidence row inside the trailing window. A tuple whose evidence
 * has fully aged out is no longer tracked — by then the sliding window has
 * already walked it back to `tracking` on the previous passes.
 */
export async function listTrackedTuples(): Promise<TrackedTuple[]> {
  return inSystemDbContext(async () => {
    const rows = await db
      .selectDistinct({
        orgId: aiAgentOpEvidence.orgId,
        agentId: aiAgentOpEvidence.agentId,
        opKey: aiAgentOpEvidence.opKey,
      })
      .from(aiAgentOpEvidence)
      .where(and(
        eq(aiAgentOpEvidence.namespace, GRADUATION_NAMESPACE),
        sql`${aiAgentOpEvidence.occurredAt} > now() - ${windowInterval()}`,
      ));
    return rows as TrackedTuple[];
  });
}

interface RawGraduationJoinRow extends RawWindowRow {
  opKey: string;
  state: AiAgentGraduationState;
  promotedAt: unknown;
  demotedAt: unknown;
  demoteReason: string | null;
}

/**
 * Every persisted graduation row for one resolved agent, each with a FRESH
 * window and a freshly derived `state`/`blockedReason` — the DTO carries no
 * `blocked_reason` column because the reason is a function of the window, the
 * partner ceiling and the effective threshold, all of which move without the
 * row being rewritten.
 *
 * One statement for the rows: the per-row window is a LEFT JOIN whose ON
 * clause carries that row's own `GREATEST(now() - interval, demoted_at)`
 * bound, so a demoted key's pre-demotion evidence is discarded per row rather
 * than by N round trips.
 *
 * Runs under a system context (the partner ceiling is invisible to an org
 * token). The CALLER must have authorized `orgId` first — Task 18's route
 * does, through `scopes`.
 */
export async function loadGraduationRows(
  orgId: string,
  agentId: string,
): Promise<AiAgentGraduationRowDto[]> {
  return inSystemDbContext(async () => {
    const context = await loadPolicyContext(orgId, agentId);

    const rows = await db
      .select({
        opKey: aiAgentGraduation.opKey,
        state: aiAgentGraduation.state,
        promotedAt: aiAgentGraduation.promotedAt,
        demotedAt: aiAgentGraduation.demotedAt,
        demoteReason: aiAgentGraduation.demoteReason,
        ...WINDOW_SELECT,
      })
      .from(aiAgentGraduation)
      .leftJoin(aiAgentOpEvidence, and(
        eq(aiAgentOpEvidence.orgId, aiAgentGraduation.orgId),
        eq(aiAgentOpEvidence.agentId, aiAgentGraduation.agentId),
        eq(aiAgentOpEvidence.opKey, aiAgentGraduation.opKey),
        eq(aiAgentOpEvidence.namespace, GRADUATION_NAMESPACE),
        sql`${aiAgentOpEvidence.occurredAt} > ${windowLowerBound(sql`${aiAgentGraduation.demotedAt}`)}`,
      ))
      .where(and(eq(aiAgentGraduation.orgId, orgId), eq(aiAgentGraduation.agentId, agentId)))
      .groupBy(aiAgentGraduation.id)
      .orderBy(asc(aiAgentGraduation.opKey));

    const now = new Date();
    return (rows as RawGraduationJoinRow[]).map((row) => {
      const window = toWindow(row);
      const { state, blockedReason } = evaluateEligibility({
        opKey: row.opKey,
        window,
        partnerCeilingKeys: context.partnerCeilingKeys,
        orgGrantedKeys: context.orgGrantedKeys,
        promoteThreshold: context.promoteThreshold,
        storedState: row.state,
        now,
      });
      return {
        opKey: row.opKey,
        namespace: GRADUATION_NAMESPACE,
        state,
        window,
        blockedReason,
        promotedAt: toIso(row.promotedAt),
        demotedAt: toIso(row.demotedAt),
        demoteReason: row.demoteReason,
      };
    });
  });
}

/**
 * Act-mode operation reliability for the same agent over the same trailing
 * window. `act_op` keys are the manifest's dot keys, never graduated — this is
 * a reliability read only, so there is no `demoted_at` bound to apply.
 */
export async function loadActOpReliability(
  orgId: string,
  agentId: string,
): Promise<AiAgentActOpReliabilityDto[]> {
  return inSystemDbContext(async () => {
    const rows = await db
      .select({
        opKey: aiAgentOpEvidence.opKey,
        executed: WINDOW_SELECT.executed,
        verified: WINDOW_SELECT.verified,
        failed: WINDOW_SELECT.failed,
        recurred: WINDOW_SELECT.recurred,
      })
      .from(aiAgentOpEvidence)
      .where(and(
        eq(aiAgentOpEvidence.orgId, orgId),
        eq(aiAgentOpEvidence.agentId, agentId),
        eq(aiAgentOpEvidence.namespace, ACT_OP_NAMESPACE),
        sql`${aiAgentOpEvidence.occurredAt} > now() - ${windowInterval()}`,
      ))
      .groupBy(aiAgentOpEvidence.opKey)
      .orderBy(asc(aiAgentOpEvidence.opKey));

    return (rows as AiAgentActOpReliabilityDto[]).map((row) => ({
      opKey: row.opKey,
      executed: Number(row.executed),
      verified: Number(row.verified),
      failed: Number(row.failed),
      recurred: Number(row.recurred),
    }));
  });
}

/**
 * How many `(org, agent, op_key)` tuples are sitting in `eligible` — the
 * P2-6b `promoteEligibleCount` on the impact DTO (`aiAgentImpact.ts:153`).
 *
 * Unlike every other export in this module it runs under the CALLER's
 * request DB context and does NOT go through `inSystemDbContext`. The others
 * read the PARTNER baseline agent row, which an org token cannot see, so
 * they must elevate. This one reads `ai_agent_graduation` only — Shape 1
 * (`org_id NOT NULL` + `breeze_has_org_access(org_id)`) — so the caller's own
 * RLS context is a real gate, and elevating would THROW IT AWAY. Do not
 * "harmonize" this with the rest of the file.
 *
 * `orgCondition` is `auth.orgCondition` (`middleware/auth.ts:125`), applied
 * on top of RLS for the reason `impactQuery.ts` states: partner scope means
 * ACCESSIBLE orgs, not every org under the partner. `orgId` narrows to one
 * org and is what makes a system-scope caller (whose `orgCondition` returns
 * `undefined`) still land on exactly the org it named.
 *
 * Reads the persisted `state`; it never re-derives eligibility. That column
 * is written by `refreshGraduationRow` above (the only writer of
 * `tracking`/`eligible`), by the promote executor (`promoted`) and by the
 * demote path (`demoted`), so this count can lag a window change by at most
 * one daily evaluation pass — the caller must present it as a link to the
 * graduation panel, which re-derives per read, not as an authoritative list.
 */
export async function countEligibleGraduations(
  orgCondition: (orgIdColumn: PgColumn) => SQL | undefined,
  orgId?: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(aiAgentGraduation)
    .where(and(
      orgCondition(aiAgentGraduation.orgId),
      orgId === undefined ? undefined : eq(aiAgentGraduation.orgId, orgId),
      eq(aiAgentGraduation.state, 'eligible'),
    ));
  return Number((rows as Array<{ count: number }>)[0]?.count ?? 0);
}
