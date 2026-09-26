/**
 * Phase 2 wave P2-2 (#4187 / #4189) — `ai_agent_schedules` read/write surface.
 *
 * This module is the ENFORCEMENT SITE named by the tenancy-invariant comments
 * on `db/schema/aiAgentSchedules.ts` and on the table's migration. Neither a
 * composite FK nor a CHECK can express "an org override's baseline belongs to
 * the org's OWN partner and names the SAME agent" (both parents are dual-owner,
 * so the composite key has a NULL leg for one shape and is therefore
 * unenforced), so the write path below is the only thing standing between a
 * client-supplied `baselineScheduleId` and a cross-tenant pointer.
 *
 * Dual ownership follows the Partner-Wide First playbook (CLAUDE.md):
 *   - PARTNER baseline: `partner_id` set, `org_id` NULL, `baseline_schedule_id`
 *     NULL. Carries the cadence (cron/timezone) and the widest kind set.
 *   - ORG override: `org_id` set, `partner_id` NULL, `baseline_schedule_id` →
 *     the baseline it tightens. TIGHTEN-ONLY — see `effectiveSchedule`.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  canonicalizeTimezone,
  createAiAgentScheduleSchema,
  isDailyOrRarerLiteralCron,
  isHourlyFloorCron,
  isMonthlyOrRarerLiteralCron,
  isStructurallyValidCron,
  isWeeklyLiteralCron,
  PATCH_DEFAULT_CRON,
  updateAiAgentScheduleSchema,
  type AiAgentEffectiveScheduleDto,
  type AiAgentKind,
  type AiAgentScheduleDto,
  type AiAgentScheduleKind,
  type AiSweepKind,
} from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { aiAgentSchedules, aiAgents, organizations, partners, type AiAgentRow, type AiAgentScheduleRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { AgentAccessDeniedError, assertAgentWriteAllowed } from './access';
import { effectiveSchedule } from './scheduleMerge';

// Re-exported so every existing importer (`aiAgentSweepScheduler.ts`, the
// tests) keeps its path; the function itself moved to `scheduleMerge.ts` so
// a leaf module (`sweepActMode.ts`, reached from the release path) can use it
// without dragging this service's whole import graph behind it.
export { effectiveSchedule };

export type CreateAiAgentScheduleInput = z.infer<typeof createAiAgentScheduleSchema>;
export type UpdateAiAgentScheduleInput = z.infer<typeof updateAiAgentScheduleSchema>;

export type ScheduleValidationCode =
  | 'baseline_not_partner_row'
  | 'baseline_wrong_partner'
  | 'baseline_agent_mismatch'
  | 'baseline_is_override'
  | 'kinds_not_subset'
  | 'kinds_empty'
  // P2-3, the narrative mirror of `kinds_empty`: a narrative schedule
  // evaluates NO sweep kinds, so a non-empty list is the violation. Its own
  // code rather than `kinds_not_subset`, for the same reason `kinds_empty`
  // is: nothing was widened relative to a baseline, and saying so would be a
  // false statement about what the client sent.
  | 'kinds_not_empty'
  | 'agent_not_partner_wide'
  | 'agent_kind_not_triage'
  // Fleet Designer (W01), the mirror of `agent_kind_not_triage` for a
  // `design` schedule: it must target a `designer` agent.
  | 'agent_kind_not_designer'
  // AI patch agent (W01), the same mirror for a `patch` schedule: it must
  // target a `patch` agent.
  | 'agent_kind_not_patch'
  // #4442 W04: an org override may DISARM act mode or inherit, never arm it.
  // Its own code, and a refusal rather than a silent coercion to `null`: a
  // caller that believes it armed unattended execution and did not is a
  // worse outcome than a 422.
  | 'act_mode_org_cannot_arm'
  | 'invalid_cron'
  // P2-3: structurally fine and inside the hourly floor, but wrong for THIS
  // schedule's kind. Distinct from `invalid_cron` so a client can tell "not a
  // cron" from "not a WEEKLY cron" without parsing the message.
  | 'invalid_cron_for_kind'
  | 'invalid_timezone';

/**
 * Which `ai_agents.kind` each schedule kind runs. `Record<AiAgentScheduleKind,
 * …>` is the exhaustiveness guard: a fifth schedule kind does not compile
 * without a decision here (AI patch agent W01 replaced a designer-or-triage
 * ternary that would have silently routed `patch` to `triage`).
 */
const REQUIRED_AGENT_KIND: Readonly<Record<AiAgentScheduleKind, AiAgentKind>> = {
  sweep: 'triage',
  narrative: 'triage',
  design: 'designer',
  patch: 'patch',
};

/** The 422 code for "wrong agent kind", keyed by the kind that was required. */
const AGENT_KIND_MISMATCH: Readonly<Record<AiAgentKind, { code: ScheduleValidationCode; message: string }>> = {
  triage: { code: 'agent_kind_not_triage', message: 'Only a triage agent can be scheduled' },
  designer: { code: 'agent_kind_not_designer', message: 'A design schedule must target a designer agent' },
  patch: { code: 'agent_kind_not_patch', message: 'A patch schedule must target a patch agent' },
  // helpdesk has no schedule kind, so it is never the REQUIRED kind; the
  // entry exists only because the Record is keyed on every AiAgentKind.
  helpdesk: { code: 'agent_kind_not_triage', message: 'Only a triage agent can be scheduled' },
};

/**
 * The agent kinds that own schedules — derived from `REQUIRED_AGENT_KIND` so
 * the org-listing predicate below cannot drift from the create/update gate.
 * A CLOSED literal list (never "any kind"): it is the only filter inside the
 * partner-axis escape an org caller's baseline read goes through.
 */
const SCHEDULABLE_AGENT_KINDS: readonly AiAgentKind[] = [...new Set(Object.values(REQUIRED_AGENT_KIND))];

/** Routes map this to 422 `{ error: code }`. The code IS the client contract. */
export class ScheduleValidationError extends Error {
  constructor(public readonly code: ScheduleValidationCode, message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

/** Exported: Task 9's sweeper names it when consuming `resolveEffectiveSchedulesForPartner`. */
export type ScheduleOverrideSummary = { id: string; enabled: boolean; sweepKinds: AiSweepKind[]; actMode: boolean | null };

/**
 * `isStructurallyValidCron` tolerates the optional leading SECONDS field for
 * BullMQ's benefit; the sweeper's occurrence evaluator is strictly 5-field, so
 * a 6-field pattern would silently never fire. Rejected here as well as in the
 * shared zod schema, because the service is also reachable from non-HTTP
 * callers.
 */
function assertValidCron(cron: string, kind: AiAgentScheduleKind): void {
  if (!isStructurallyValidCron(cron) || cron.trim().split(/\s+/).length !== 5) {
    throw new ScheduleValidationError('invalid_cron', `Not a 5-field cron expression: ${cron}`);
  }
  // The cadence floor (review fix, #4189), shared with the zod schema so the
  // two can never drift: the minute field must be a literal minute or a
  // comma-separated list of them, so a schedule fires at most once an hour.
  // One occurrence is one LLM-spending run PER LIVE ORG under the partner, so
  // a sub-hourly cron is a fleet-wide cost multiplier one PATCH can turn on.
  if (!isHourlyFloorCron(cron)) {
    throw new ScheduleValidationError(
      'invalid_cron',
      `sweep schedules fire at most hourly; the minute field must be a literal minute or comma-separated list of minutes: ${cron}`,
    );
  }
  // P2-3 (narrative). "Weekly" has to be a property of the STORED cron, not
  // something the report generator asserts after the fact: a narrative
  // schedule firing daily would mail an MSP's customer seven "weekly"
  // reports over overlapping windows. `isWeeklyLiteralCron` is strictly
  // narrower than the hourly floor above (it pins every field), so the order
  // here only decides which code a client sees, never whether a bad cron
  // gets through.
  if (kind === 'narrative' && !isWeeklyLiteralCron(cron)) {
    throw new ScheduleValidationError(
      'invalid_cron_for_kind',
      `a narrative schedule must fire exactly once a week — literal minute and hour, \`*\` day-of-month and month, and a single day-of-week 0-6: ${cron}`,
    );
  }
  // Fleet Designer (W01). A design run assembles a whole-org evidence bundle
  // and produces an eight-section report — meaningful at most monthly, never
  // as a background loop. `isMonthlyOrRarerLiteralCron` is strictly narrower
  // than the hourly floor above, same ordering rationale as the narrative
  // check: it only decides which code a client sees, never whether a bad
  // cron gets through.
  if (kind === 'design' && !isMonthlyOrRarerLiteralCron(cron)) {
    throw new ScheduleValidationError(
      'invalid_cron_for_kind',
      `a design schedule fires at most once a month — literal minute, hour and day-of-month (or a divisor-of-12 month step), \`*\` day-of-week: ${cron}`,
    );
  }
  // AI patch agent (W01). One occurrence is one LLM-spending patch run per
  // live org, and patch posture moves on the order of a day, so a patch
  // schedule fires at most daily. Same ordering rationale as the two checks
  // above: it only decides which code a client sees.
  if (kind === 'patch' && !isDailyOrRarerLiteralCron(cron)) {
    throw new ScheduleValidationError(
      'invalid_cron_for_kind',
      `a patch schedule fires at most once a day — a single literal minute and a single literal hour: ${cron}`,
    );
  }
}

/**
 * The per-kind `sweep_kinds` rule, shared by create and update so the two can
 * never drift. Mirrors `ai_agent_schedules_kind_kinds_chk` exactly — the DB
 * CHECK is the backstop, this is the one that produces a 422 with a code
 * instead of a 500 with a constraint name.
 *
 * ORG OVERRIDES ARE NOT ROUTED HERE: an override's `[]` legitimately means
 * "disable every kind for this org" on a SWEEP baseline (the same convention
 * as its `enabled: false`), which is why the CHECK exempts `org_id IS NOT
 * NULL` from the sweep arm. Its widening is bounded by `assertKindsSubset`
 * instead — and against a narrative baseline, whose kinds are `[]`, that
 * already rejects every non-empty list.
 */
function assertPartnerKindsForScheduleKind(kind: AiAgentScheduleKind, sweepKinds: AiSweepKind[]): void {
  // Fleet Designer (W01) behaves exactly like `narrative` here: a design run
  // evaluates no sweep kinds either — its whole input is the system-assembled
  // evidence bundle, not a sweep-kind-scoped finding pass.
  // AI patch agent (W01): `patch` likewise sweeps nothing — its input is the
  // system-assembled patch evidence bundle.
  if (kind === 'narrative' || kind === 'design' || kind === 'patch') {
    if (sweepKinds.length > 0) {
      throw new ScheduleValidationError(
        'kinds_not_empty',
        `A ${kind} schedule evaluates no sweep kinds; sweepKinds must be empty`,
      );
    }
    return;
  }
  // kind === 'sweep', unchanged since P2-2: a baseline that sweeps nothing is
  // a disabled schedule wearing an enabled flag.
  if (sweepKinds.length === 0) {
    throw new ScheduleValidationError(
      'kinds_empty',
      'A partner baseline must sweep at least one kind; disable the schedule instead',
    );
  }
}

function canonicalTimezoneOrThrow(timezone: string): string {
  const canonical = canonicalizeTimezone(timezone);
  if (canonical === null) {
    throw new ScheduleValidationError('invalid_timezone', `Not an IANA timezone: ${timezone}`);
  }
  return canonical;
}

function toScheduleDto(row: AiAgentScheduleRow, includeRunSummary: boolean): AiAgentScheduleDto {
  return {
    id: row.id,
    ownerScope: row.partnerId ? 'partner' : 'organization',
    orgId: row.orgId,
    partnerId: row.partnerId,
    agentId: row.agentId,
    baselineScheduleId: row.baselineScheduleId,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    sweepKinds: row.sweepKinds,
    enabled: row.enabled,
    // Raw, not the effective merge: the UI needs to tell "inherit" (null)
    // from "explicitly off" (false) on an override row.
    actMode: row.actMode,
    lastEnqueuedAt: row.lastEnqueuedAt?.toISOString() ?? null,
    lastOccurrenceKey: row.lastOccurrenceKey,
    // `last_run_summary` aggregates every org under the partner (orgsTotal /
    // runsAdmitted / skipReasons). A partner baseline is legible to each of
    // those orgs through the effective resolver, so it is stripped for them.
    lastRunSummary: includeRunSummary ? row.lastRunSummary : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function overrideSummary(row: AiAgentScheduleRow): ScheduleOverrideSummary {
  return { id: row.id, enabled: row.enabled, sweepKinds: row.sweepKinds, actMode: row.actMode };
}

function toEffectiveDto(
  baseline: AiAgentScheduleRow,
  override: AiAgentScheduleRow | undefined,
  includeRunSummary: boolean,
): AiAgentEffectiveScheduleDto {
  const summary = override ? overrideSummary(override) : null;
  return {
    ...toScheduleDto(baseline, includeRunSummary),
    effective: effectiveSchedule(baseline, summary),
    override: summary,
  };
}

/**
 * The org's partner, read under the CALLER's own RLS context — never through
 * the partner-axis escape. Everything below pins its baseline lookups to this
 * value, so it must come from a row the caller could legitimately see.
 */
async function requireOrgPartnerId(orgId: string): Promise<string> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new AgentAccessDeniedError('Organization not found');
  return org.partnerId;
}

/**
 * Load the baseline an org override points at, LOCKED, for validation.
 *
 * Pinned to `(this partner's rows) OR (this org's own rows)`, so the
 * partner-axis escape can only ever surface a row already inside the caller's
 * tenancy blast radius — a client-supplied id can neither read nor probe for
 * another partner's schedule (the escape's documented rule, `partnerAxisRead.ts`).
 * A miss is therefore reported as `baseline_wrong_partner`: "not found" and
 * "belongs to someone else" are deliberately indistinguishable.
 *
 * `FOR SHARE` serialises the subset check against a concurrent baseline
 * kinds-narrowing. NOTE (honest scope): an organization-scoped caller never
 * passes `breeze_has_partner_access`, so the partner row is invisible without
 * `readWithPartnerAxisVisibility`, which by construction runs on a SECOND
 * connection/transaction — the lock therefore covers the validation read, not
 * the subsequent insert. That is acceptable because the durable guarantee is
 * `effectiveSchedule`'s intersection at evaluation time: a stored superset can
 * never widen what an org actually sweeps, it only becomes inert.
 *
 * WHY THIS ONE STILL ESCAPES (#5199 retired every other baseline escape in
 * this file): the `ai_agent_schedules_partner_wide_select` branch is SELECT-
 * only, and a row-locking `SELECT … FOR SHARE` must ALSO pass the table's
 * UPDATE policy, which an org session never does for a partner-wide row. Read
 * in the caller's context, this lookup would silently return nothing and every
 * org override would fail `baseline_wrong_partner`. Pinned by
 * aiPartnerWideReadsRequestContext.integration.test.ts.
 */
async function loadBaselineForOverride(
  orgId: string,
  orgPartnerId: string,
  baselineScheduleId: string,
): Promise<AiAgentScheduleRow | null> {
  const [row] = await readWithPartnerAxisVisibility(() => db
    .select()
    .from(aiAgentSchedules)
    .where(and(
      eq(aiAgentSchedules.id, baselineScheduleId),
      or(
        eq(aiAgentSchedules.partnerId, orgPartnerId),
        eq(aiAgentSchedules.orgId, orgId),
      ),
    ))
    .limit(1)
    .for('share'));
  return row ?? null;
}

/**
 * The cross-tenant-pointer invariant, in one place. `expectedAgentId` is
 * supplied only where an agent is already fixed (the update path re-checks a
 * stored override against its baseline); on create the override INHERITS the
 * baseline's agent, so there is nothing to mismatch.
 */
function assertBaselineUsable(
  baseline: AiAgentScheduleRow | null,
  expected: { orgPartnerId: string; agentId?: string },
): asserts baseline is AiAgentScheduleRow {
  if (!baseline) {
    throw new ScheduleValidationError(
      'baseline_wrong_partner',
      'Baseline schedule is not a partner-wide schedule of this organization\'s partner',
    );
  }
  if (baseline.orgId !== null || baseline.baselineScheduleId !== null) {
    throw new ScheduleValidationError(
      'baseline_is_override',
      'Baseline schedule is itself an org override; overrides cannot be chained',
    );
  }
  if (baseline.partnerId === null) {
    // ai_agent_schedules_one_owner_chk forbids this shape; defence in depth
    // against a forged or backfilled row.
    throw new ScheduleValidationError('baseline_not_partner_row', 'Baseline schedule has no owner');
  }
  if (baseline.partnerId !== expected.orgPartnerId) {
    throw new ScheduleValidationError(
      'baseline_wrong_partner',
      'Baseline schedule belongs to a different partner',
    );
  }
  if (expected.agentId !== undefined && baseline.agentId !== expected.agentId) {
    throw new ScheduleValidationError(
      'baseline_agent_mismatch',
      'Baseline schedule targets a different agent than this override',
    );
  }
}

function assertKindsSubset(baseline: AiAgentScheduleRow, sweepKinds: AiSweepKind[]): void {
  const widened = sweepKinds.filter((kind) => !baseline.sweepKinds.includes(kind));
  if (widened.length > 0) {
    throw new ScheduleValidationError(
      'kinds_not_subset',
      `An org override may only tighten the baseline; not in the baseline: ${widened.join(', ')}`,
    );
  }
}

/**
 * A partner baseline may only target a PARTNER-WIDE, non-deleted agent of the
 * KIND its own schedule kind requires, under the caller's own partner: a
 * `sweep`/`narrative` schedule needs a `triage` agent (spec: sweeps run the
 * triage agent's sweep/narrative profile), a `design` schedule needs a
 * `designer` agent (Fleet Designer W01) — an org-owned agent has no authority
 * over the partner's other orgs either way.
 */
async function assertPartnerWideScheduledAgent(
  agentId: string,
  partnerId: string,
  kind: AiAgentScheduleKind,
): Promise<void> {
  const [agent] = await db
    .select({
      orgId: aiAgents.orgId,
      partnerId: aiAgents.partnerId,
      kind: aiAgents.kind,
      disabledAt: aiAgents.disabledAt,
    })
    .from(aiAgents)
    .where(eq(aiAgents.id, agentId))
    .limit(1);

  if (!agent || agent.orgId !== null || agent.partnerId !== partnerId || agent.disabledAt !== null) {
    throw new ScheduleValidationError(
      'agent_not_partner_wide',
      'Schedules require a partner-wide agent belonging to this partner',
    );
  }
  const required = REQUIRED_AGENT_KIND[kind];
  if (agent.kind !== required) {
    const mismatch = AGENT_KIND_MISMATCH[required];
    throw new ScheduleValidationError(mismatch.code, mismatch.message);
  }
}

/**
 * Which schedule rows this caller may reach for a WRITE, on either axis.
 *
 * Partner-wide rows are included for an ORG caller too — deliberately. Without
 * them, an org token patching its partner's baseline would 404 through
 * "invisible" rather than 403 through `PartnerWideWriteDeniedError`, which
 * hides a permission problem behind a not-found. The predicate is pinned to
 * `auth.partnerId` (verified context, never client input), so the escape below
 * cannot widen WHICH partner is reachable.
 */
function accessibleScheduleCondition(auth: AuthContext) {
  const orgAxis = auth.orgCondition(aiAgentSchedules.orgId);
  // System scope (orgCondition === undefined) is unrestricted on BOTH axes.
  // Returning the partner clause here instead would narrow a platform caller
  // to partner rows and make every org override unreachable to it.
  if (orgAxis === undefined) return undefined;
  if (!auth.partnerId) return orgAxis;
  return or(orgAxis, and(isNull(aiAgentSchedules.orgId), eq(aiAgentSchedules.partnerId, auth.partnerId)));
}

async function loadScheduleForWrite(auth: AuthContext, id: string): Promise<AiAgentScheduleRow> {
  const read = () => db
    .select()
    .from(aiAgentSchedules)
    .where(and(eq(aiAgentSchedules.id, id), accessibleScheduleCondition(auth)))
    .limit(1);

  // Caller context for every scope (#5199): a partner session passes
  // breeze_has_partner_access for its own partner, and an org session sees its
  // own partner's partner-wide rows through the SELECT-only
  // `ai_agent_schedules_partner_wide_select` branch. It used to escape through
  // readWithPartnerAxisVisibility for non-partner scopes.
  const [row] = await read();
  if (!row) throw new AgentAccessDeniedError('Schedule not found');
  return row;
}

/**
 * #4442 W04 — the tighten-only half of act mode on the WRITE path. An org
 * override may disarm (`false`) or inherit (`null`/omitted); arming is a
 * partner-wide decision. Refused, never coerced.
 */
function assertOrgActModeNotArming(actMode: boolean | null | undefined): void {
  if (actMode === true) {
    throw new ScheduleValidationError(
      'act_mode_org_cannot_arm',
      'Act mode is armed on the partner baseline; an organization override may only disable it',
    );
  }
}

export async function createSchedule(
  auth: AuthContext,
  input: CreateAiAgentScheduleInput,
): Promise<AiAgentScheduleRow> {
  if (input.ownerScope === 'partner') {
    const partnerId = auth.partnerId;
    if (!partnerId) {
      throw new AgentAccessDeniedError('Partner-wide schedules require a partner context');
    }
    // Owner pair first: an ai_agent principal and a 'selected' partner admin
    // must be refused before any lookup, let alone a write.
    assertAgentWriteAllowed(auth, { orgId: null, partnerId });
    // `createPartnerScheduleSchema` defaults this to 'sweep', so every
    // pre-P2-3 body still lands on exactly the branch it used to.
    assertValidCron(input.cron, input.kind);
    assertPartnerKindsForScheduleKind(input.kind, input.sweepKinds);
    const timezone = canonicalTimezoneOrThrow(input.timezone);
    await assertPartnerWideScheduledAgent(input.agentId, partnerId, input.kind);

    const [row] = await db
      .insert(aiAgentSchedules)
      .values({
        orgId: null,
        partnerId,
        agentId: input.agentId,
        baselineScheduleId: null,
        // Written explicitly, never left to the column DEFAULT: the default
        // is a migration compatibility shim for pre-P2-3 rows, and letting it
        // decide a new row's kind would re-point every schedule the day it
        // changes.
        kind: input.kind,
        cron: input.cron,
        timezone,
        sweepKinds: input.sweepKinds,
        enabled: input.enabled,
        // #4442 W04. `assertAgentWriteAllowed` above already refused any
        // caller without `canManagePartnerWidePolicies`, so reaching here is
        // the partner-wide write gate; `?? null` keeps "omitted" and
        // "explicitly null" the same stored value (= not armed).
        actMode: input.actMode ?? null,
        createdBy: auth.user.id,
        updatedAt: new Date(),
      })
      .returning();
    if (!row) throw new AgentAccessDeniedError('Schedule not created');
    return row;
  }

  assertAgentWriteAllowed(auth, { orgId: input.orgId, partnerId: null });
  assertOrgActModeNotArming(input.actMode);
  const orgPartnerId = await requireOrgPartnerId(input.orgId);
  const baseline = await loadBaselineForOverride(input.orgId, orgPartnerId, input.baselineScheduleId);
  assertBaselineUsable(baseline, { orgPartnerId });
  assertKindsSubset(baseline, input.sweepKinds);

  const [row] = await db
    .insert(aiAgentSchedules)
    .values({
      orgId: input.orgId,
      partnerId: null,
      // Inherited, never client-supplied: an override always runs on its
      // baseline's cadence and against its baseline's agent. cron/timezone are
      // NOT NULL on the table, so the copy is what keeps the row well-formed.
      agentId: baseline.agentId,
      baselineScheduleId: baseline.id,
      // COPIED from the baseline, never client-supplied (the create schema's
      // org arm is `.strict()` and has no `kind` field at all). Backed by the
      // composite self-FK `(baseline_schedule_id, kind) -> (id, kind)`: an
      // override that disagreed with its baseline is a 23503 here, not a row
      // that silently produces a run profile the partner never configured.
      kind: baseline.kind,
      cron: baseline.cron,
      timezone: baseline.timezone,
      sweepKinds: input.sweepKinds,
      enabled: input.enabled,
      // Only `false` (disarm) or `null` (inherit) can reach here —
      // `assertOrgActModeNotArming` refused `true` above.
      actMode: input.actMode ?? null,
      createdBy: auth.user.id,
      updatedAt: new Date(),
    })
    .returning();
  if (!row) throw new AgentAccessDeniedError('Schedule not created');
  return row;
}

export async function updateSchedule(
  auth: AuthContext,
  id: string,
  input: UpdateAiAgentScheduleInput,
): Promise<AiAgentScheduleRow> {
  const existing = await loadScheduleForWrite(auth, id);
  assertAgentWriteAllowed(auth, { orgId: existing.orgId, partnerId: existing.partnerId });

  const patch: Partial<typeof aiAgentSchedules.$inferInsert> = {};

  if (existing.partnerId !== null) {
    if (input.cron !== undefined) {
      // `kind` is immutable (the update schema never admits it), so the
      // STORED row is what decides which cadence rule applies.
      assertValidCron(input.cron, existing.kind);
      patch.cron = input.cron;
    }
    if (input.timezone !== undefined) patch.timezone = canonicalTimezoneOrThrow(input.timezone);
    if (input.sweepKinds !== undefined) {
      // `updateAiAgentScheduleSchema` is SHARED by both owner shapes and
      // cannot carry this `.min(1)`: an ORG override's `[]` legitimately
      // means "disable every kind for this org" (the same convention as its
      // `enabled: false`), which is exactly why the CREATE schema is a
      // discriminated union and the UPDATE schema is not. So the baseline's
      // non-empty invariant — `createPartnerScheduleSchema.sweepKinds` is
      // `.min(1)` — is enforced here, on the partner branch, or a PATCH would
      // be a hole straight through it. Its own code, not `kinds_not_subset`:
      // nothing was widened, and telling a client "not a subset" for an empty
      // list is a false statement about what it sent (review fix, #4189).
      // Per-kind since P2-3: `kinds_empty` stays a SWEEP-only rule, and a
      // narrative baseline instead refuses every NON-empty list. `[]` on a
      // narrative baseline is admitted as the no-op it is — it is the only
      // value that row may ever hold — rather than answered with a code whose
      // message would be false.
      assertPartnerKindsForScheduleKind(existing.kind, input.sweepKinds);
      patch.sweepKinds = input.sweepKinds;
    }
    // #4442 W04. `assertAgentWriteAllowed` above already gated this whole
    // branch on `canManagePartnerWidePolicies` (the row is partner-wide), so
    // arming needs no second check here.
    if (input.actMode !== undefined) patch.actMode = input.actMode ?? null;
  } else {
    // An override has no cadence of its own — cron/timezone on its row are a
    // copy of the baseline's. Accepting them here would persist a lie rather
    // than change when the sweep runs, so this is refused, not ignored.
    if (input.cron !== undefined) {
      throw new ScheduleValidationError(
        'invalid_cron',
        'An org override runs on its baseline cadence; set cron on the partner baseline',
      );
    }
    if (input.timezone !== undefined) {
      throw new ScheduleValidationError(
        'invalid_timezone',
        'An org override runs on its baseline cadence; set timezone on the partner baseline',
      );
    }
    if (input.sweepKinds !== undefined) {
      const orgId = existing.orgId as string;
      const orgPartnerId = await requireOrgPartnerId(orgId);
      const baseline = await loadBaselineForOverride(
        orgId,
        orgPartnerId,
        existing.baselineScheduleId as string,
      );
      assertBaselineUsable(baseline, { orgPartnerId, agentId: existing.agentId });
      assertKindsSubset(baseline, input.sweepKinds);
      patch.sweepKinds = input.sweepKinds;
    }
    if (input.actMode !== undefined) {
      assertOrgActModeNotArming(input.actMode);
      patch.actMode = input.actMode ?? null;
    }
  }

  if (input.enabled !== undefined) patch.enabled = input.enabled;

  // Unconditional: there is no updated_at trigger on this table.
  patch.updatedAt = new Date();

  // The access predicate is repeated on the WRITE, not just the preceding read:
  // RLS is the real boundary, but a mutation bounded only by a primary key
  // reads as authorized to the next caller and would be wrong the moment this
  // runs from a system context.
  const [row] = await db
    .update(aiAgentSchedules)
    .set(patch)
    .where(and(eq(aiAgentSchedules.id, id), accessibleScheduleCondition(auth)))
    .returning();
  if (!row) throw new AgentAccessDeniedError('Schedule not found');

  // Live-check B1 (#4189): an override row's `cron`/`timezone` are a COPY of
  // its baseline's — `createSchedule` inherits them because both columns are
  // NOT NULL and an override has no cadence of its own. Re-cronning the
  // baseline without propagating leaves every override row still advertising
  // the OLD cadence, which is precisely what an org sees for its own schedule
  // (`listSchedules` -> `toEffectiveDto` renders the BASELINE's cron for a
  // partner caller, but the override row is what an org-scoped read of its
  // own row returns). The sweeper is unaffected either way — it ticks
  // baselines only (`loadDueBaselines` filters `org_id IS NULL`) — so this is
  // a display-consistency fix, not a scheduling one.
  //
  // Same transaction as the UPDATE above by construction, NOT by a nested
  // `db.transaction`: `withDbAccessContext` already holds one open around the
  // whole request (it has to — the RLS GUCs are SET LOCAL), and the `db`
  // proxy routes both statements onto it. A nested call would only add a
  // savepoint.
  //
  // Bounded by `baseline_schedule_id` alone: the children of a baseline the
  // caller was just authorized to write are by construction under the same
  // partner (the FK is `ON DELETE CASCADE` and `createSchedule` pins the
  // partner on both sides). RLS still applies on top — a partner admin
  // restricted to a subset of orgs propagates only into the overrides it can
  // reach, which is the correct failure direction (stale copy) rather than a
  // cross-tenant write.
  const cadenceChanged = patch.cron !== undefined || patch.timezone !== undefined;
  if (existing.partnerId !== null && cadenceChanged) {
    await db
      .update(aiAgentSchedules)
      .set({
        // The values that actually landed on the baseline row — the
        // CANONICALIZED timezone, never the raw client string, or the two
        // rows would disagree on the same zone.
        cron: row.cron,
        timezone: row.timezone,
        updatedAt: new Date(),
      })
      .where(eq(aiAgentSchedules.baselineScheduleId, id));
  }

  return row;
}

export async function deleteSchedule(auth: AuthContext, id: string): Promise<void> {
  const existing = await loadScheduleForWrite(auth, id);
  assertAgentWriteAllowed(auth, { orgId: existing.orgId, partnerId: existing.partnerId });
  // Deleting a baseline cascades its org overrides in the DB
  // (baseline_schedule_id ... ON DELETE CASCADE) — no fan-out needed here.
  //
  // RETURNING is load-bearing, not decoration: `loadScheduleForWrite` above may
  // have read the row through the partner-axis SYSTEM escape, while this DELETE
  // runs under the CALLER's own RLS. The two are not equivalent by
  // construction, so "I could see it" does not imply "I could delete it".
  // Without this check the route would answer 204 and audit `success` for a
  // delete that removed nothing.
  const deleted = await db
    .delete(aiAgentSchedules)
    .where(and(eq(aiAgentSchedules.id, id), accessibleScheduleCondition(auth)))
    .returning({ id: aiAgentSchedules.id });
  if (deleted.length === 0) throw new AgentAccessDeniedError('Schedule not found');
}

async function overridesFor(orgId: string, baselineIds: string[]): Promise<AiAgentScheduleRow[]> {
  if (baselineIds.length === 0) return [];
  return db
    .select()
    .from(aiAgentSchedules)
    .where(and(
      eq(aiAgentSchedules.orgId, orgId),
      inArray(aiAgentSchedules.baselineScheduleId, baselineIds),
    ));
}

export async function listSchedules(
  auth: AuthContext,
  filter: { agentId?: string; orgId?: string },
): Promise<AiAgentEffectiveScheduleDto[]> {
  if (filter.orgId && !auth.canAccessOrg(filter.orgId)) {
    throw new AgentAccessDeniedError('Access to this organization denied');
  }

  // PARTNER-scoped callers read their own baselines under their OWN RLS
  // context — breeze_has_partner_access passes for them, so no escape. Every
  // other scope (organization, and system, which must name an org) falls
  // through to the org-centric branch below.
  if (auth.scope === 'partner' && auth.partnerId) {
    const baselines = await db
      .select()
      .from(aiAgentSchedules)
      .where(and(
        isNull(aiAgentSchedules.orgId),
        eq(aiAgentSchedules.partnerId, auth.partnerId),
        filter.agentId ? eq(aiAgentSchedules.agentId, filter.agentId) : undefined,
      ));
    if (!filter.orgId) {
      return baselines.map((baseline) => toEffectiveDto(baseline, undefined, true));
    }
    const overrides = await overridesFor(filter.orgId, baselines.map((b) => b.id));
    const byBaseline = new Map(overrides.map((o) => [o.baselineScheduleId as string, o]));
    return baselines.map((baseline) => toEffectiveDto(baseline, byBaseline.get(baseline.id), true));
  }

  const orgId = filter.orgId ?? auth.orgId;
  if (!orgId || !auth.canAccessOrg(orgId)) {
    throw new AgentAccessDeniedError('Organization context required');
  }
  const orgPartnerId = await requireOrgPartnerId(orgId);

  // Read in the caller's own context (#5199): an org session sees its own
  // partner's partner-wide agents and baselines through the SELECT-only
  // `*_partner_wide_select` branches (#4942/#4943). It used to escape to a
  // system context, where this app predicate was the ONLY filter; it stays
  // maximally narrow anyway: this partner's rows, for this partner's own
  // partner-wide SCHEDULABLE agents, and nothing else.
  // `SCHEDULABLE_AGENT_KINDS` is a closed list derived from the create gate
  // (triage/designer/patch); before AI patch agent W01 it was `'triage'`
  // alone, which hid every design and patch baseline from an org token.
  // `helpdesk` has no schedule kind and is excluded.
  const baselines = await (async () => {
    const agentIds = await db
      .select({ id: aiAgents.id })
      .from(aiAgents)
      .where(and(
        isNull(aiAgents.orgId),
        eq(aiAgents.partnerId, orgPartnerId),
        inArray(aiAgents.kind, [...SCHEDULABLE_AGENT_KINDS]),
        // Same predicate as assertPartnerWideScheduledAgent: a soft-deleted agent
        // can no longer be scheduled, so its baselines are not offered either.
        isNull(aiAgents.disabledAt),
      ));
    if (agentIds.length === 0) return [];
    return db
      .select()
      .from(aiAgentSchedules)
      .where(and(
        isNull(aiAgentSchedules.orgId),
        eq(aiAgentSchedules.partnerId, orgPartnerId),
        inArray(aiAgentSchedules.agentId, agentIds.map((a) => a.id)),
        filter.agentId ? eq(aiAgentSchedules.agentId, filter.agentId) : undefined,
      ));
  })();

  // The org's OWN override rows are visible under its own RLS — no escape.
  const overrides = await overridesFor(orgId, baselines.map((b) => b.id));
  const byBaseline = new Map(overrides.map((o) => [o.baselineScheduleId as string, o]));
  return baselines.map((baseline) => toEffectiveDto(baseline, byBaseline.get(baseline.id), false));
}

/** One enabled baseline's cadence — everything the next-occurrence column needs
 *  and nothing else. Deliberately NOT the whole row: `last_run_summary`
 *  aggregates every org under the partner and must never reach an org caller
 *  (see `listSchedules`), so it is not selected here at all. */
export interface BaselineCadence {
  agentId: string;
  cron: string;
  timezone: string;
}

/**
 * AI patch agent W01 (#5747) — every ENABLED baseline cadence for a page of
 * agents, in ONE query.
 *
 * The agents list route turns these into each card's `nextOccurrenceAt`. It is
 * a page-wide batched read for the same reason `loadLastRuns` is: a per-row
 * query would be one round trip per agent.
 *
 * Tenancy is `listSchedules`'s, restated for a read that returns no row
 * contents: a PARTNER caller reads its own baselines under its own RLS
 * (`breeze_has_partner_access` passes), while an ORG caller reads them in its
 * own context through the SELECT-only partner-wide branches (#5199; it used to
 * escape via `readWithPartnerAxisVisibility`), still with a maximally narrow
 * app predicate — this partner's rows, for this partner's own partner-wide
 * schedulable agents. A caller with neither axis (no partnerId) gets nothing
 * rather than an unpinned read.
 *
 * Overrides are deliberately ignored: an org override carries no cadence of
 * its own (it may only disable or tighten), so the BASELINE's cron is when the
 * agent next fires — exactly what `toEffectiveDto` renders in the drawer.
 */
export async function loadEnabledBaselineCadences(
  auth: AuthContext,
  agentIds: string[],
): Promise<BaselineCadence[]> {
  if (agentIds.length === 0) return [];
  const columns = {
    agentId: aiAgentSchedules.agentId,
    cron: aiAgentSchedules.cron,
    timezone: aiAgentSchedules.timezone,
  };

  if (auth.scope === 'partner' && auth.partnerId) {
    return db
      .select(columns)
      .from(aiAgentSchedules)
      .where(and(
        isNull(aiAgentSchedules.orgId),
        eq(aiAgentSchedules.partnerId, auth.partnerId),
        eq(aiAgentSchedules.enabled, true),
        inArray(aiAgentSchedules.agentId, agentIds),
      ));
  }

  if (!auth.partnerId) return [];
  const partnerId = auth.partnerId;

  const partnerWideAgentIds = await db
    .select({ id: aiAgents.id })
    .from(aiAgents)
    .where(and(
      isNull(aiAgents.orgId),
      eq(aiAgents.partnerId, partnerId),
      inArray(aiAgents.kind, [...SCHEDULABLE_AGENT_KINDS]),
      isNull(aiAgents.disabledAt),
      inArray(aiAgents.id, agentIds),
    ));
  if (partnerWideAgentIds.length === 0) return [];
  return db
    .select(columns)
    .from(aiAgentSchedules)
    .where(and(
      isNull(aiAgentSchedules.orgId),
      eq(aiAgentSchedules.partnerId, partnerId),
      eq(aiAgentSchedules.enabled, true),
      inArray(aiAgentSchedules.agentId, partnerWideAgentIds.map((a) => a.id)),
    ));
}

/**
 * The sweeper's (Task 9) entry point: every baseline of one partner with its
 * org overrides keyed by org id. Runs in a SYSTEM context — the fixed-tick
 * sweeper has no auth context and must see every org under the partner.
 */
export async function resolveEffectiveSchedulesForPartner(
  partnerId: string,
): Promise<Array<{ baseline: AiAgentScheduleRow; overridesByOrg: Map<string, ScheduleOverrideSummary> }>> {
  const inner = async () => {
    const baselines = await db
      .select()
      .from(aiAgentSchedules)
      .where(and(isNull(aiAgentSchedules.orgId), eq(aiAgentSchedules.partnerId, partnerId)));
    if (baselines.length === 0) return [];

    const overrides = await db
      .select()
      .from(aiAgentSchedules)
      .where(inArray(aiAgentSchedules.baselineScheduleId, baselines.map((b) => b.id)));

    return baselines.map((baseline) => {
      const overridesByOrg = new Map<string, ScheduleOverrideSummary>();
      for (const override of overrides) {
        if (override.baselineScheduleId === baseline.id && override.orgId) {
          overridesByOrg.set(override.orgId, overrideSummary(override));
        }
      }
      return { baseline, overridesByOrg };
    });
  };

  // Already system-scoped (the common case: a BullMQ worker that opened its own
  // system context): read straight through rather than double-holding a second
  // pooled connection — same skip branch as resolveEffectiveAgentSystem.
  if (getCurrentDbAccessContext()?.scope === 'system') return inner();
  return runOutsideDbContext(() => withSystemDbAccessContext(inner));
}

/**
 * AI patch agent W01 (#5747, OD-9 A) — the default cadence. A partner-wide
 * patch agent that is enabled gets ONE partner baseline `0 2 * * *` (02:00 in
 * the partner's timezone, UTC fallback), so enabling Patching actually starts
 * it working (#5382 — an enabled agent with no schedule never ran).
 *
 * Called from `agentService` on create-enabled and on the enabled false→true
 * transition, and from the one-shot boot backfill for agents that were
 * already enabled before this shipped. Every caller runs it inside a
 * SAVEPOINT (`db.transaction(tx => ensureDefaultPatchSchedule(row, tx))`) and
 * passes that `tx` as the executor: postgres-js rethrows a failed statement
 * when the enclosing scope ends even if the caller caught it, so a statement
 * issued through the ambient `db` could fail the enable itself.
 *
 * Idempotent: a per-agent `pg_advisory_xact_lock` serialises concurrent
 * callers (two API replicas booting the backfill, or an enable racing it),
 * then any existing `kind = 'patch'` baseline for the agent means nothing is
 * created. Never creates for an org-owned, non-patch, disabled or
 * soft-deleted agent. `createdBy` is null — a system-created row.
 */
export type EnsureDefaultPatchScheduleResult =
  | { created: true }
  | { created: false; reason: 'not_applicable' | 'exists' };

type ScheduleExecutor = Pick<typeof db, 'select' | 'insert' | 'execute'>;

export async function ensureDefaultPatchSchedule(
  agent: Pick<AiAgentRow, 'id' | 'kind' | 'orgId' | 'partnerId' | 'enabled' | 'disabledAt'>,
  executor: ScheduleExecutor,
): Promise<EnsureDefaultPatchScheduleResult> {
  if (
    agent.kind !== 'patch'
    || agent.orgId !== null
    || !agent.partnerId
    || !agent.enabled
    || agent.disabledAt !== null
  ) {
    return { created: false, reason: 'not_applicable' };
  }
  const partnerId = agent.partnerId;

  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-patch-default-schedule:${agent.id}`}, 0))`);

  const [existing] = await executor
    .select({ id: aiAgentSchedules.id })
    .from(aiAgentSchedules)
    .where(and(
      eq(aiAgentSchedules.agentId, agent.id),
      eq(aiAgentSchedules.kind, 'patch'),
      isNull(aiAgentSchedules.orgId),
    ))
    .limit(1);
  if (existing) return { created: false, reason: 'exists' };

  const [partner] = await executor
    .select({ timezone: partners.timezone })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  const timezone = canonicalizeTimezone(partner?.timezone ?? '') ?? 'UTC';
  if (!partner?.timezone || timezone !== canonicalizeTimezone(partner.timezone)) {
    console.warn('[aiAgentSchedules] default patch schedule falls back to UTC — partner timezone missing or invalid', {
      agentId: agent.id, partnerId,
    });
  }

  await executor.insert(aiAgentSchedules).values({
    orgId: null,
    partnerId,
    agentId: agent.id,
    baselineScheduleId: null,
    kind: 'patch',
    cron: PATCH_DEFAULT_CRON,
    timezone,
    sweepKinds: [],
    enabled: true,
    createdBy: null,
    updatedAt: new Date(),
  });
  return { created: true };
}
