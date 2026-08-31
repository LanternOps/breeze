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
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import {
  canonicalizeTimezone,
  createAiAgentScheduleSchema,
  isHourlyFloorCron,
  isStructurallyValidCron,
  isWeeklyLiteralCron,
  updateAiAgentScheduleSchema,
  type AiAgentEffectiveScheduleDto,
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
import { aiAgentSchedules, aiAgents, organizations, type AiAgentScheduleRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { AgentAccessDeniedError, assertAgentWriteAllowed } from './access';

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
  | 'invalid_cron'
  // P2-3: structurally fine and inside the hourly floor, but wrong for THIS
  // schedule's kind. Distinct from `invalid_cron` so a client can tell "not a
  // cron" from "not a WEEKLY cron" without parsing the message.
  | 'invalid_cron_for_kind'
  | 'invalid_timezone';

/** Routes map this to 422 `{ error: code }`. The code IS the client contract. */
export class ScheduleValidationError extends Error {
  constructor(public readonly code: ScheduleValidationCode, message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

/** Exported: Task 9's sweeper names it when consuming `resolveEffectiveSchedulesForPartner`. */
export type ScheduleOverrideSummary = { id: string; enabled: boolean; sweepKinds: AiSweepKind[] };

/**
 * The org-facing merge, and the reason a stale override can never widen a
 * sweep: kinds are INTERSECTED, and either side may disable. Pure by design —
 * the sweeper (Task 9) calls it per (baseline, org) pair with no db access.
 */
export function effectiveSchedule(
  baseline: { enabled: boolean; sweepKinds: AiSweepKind[] },
  override: { enabled: boolean; sweepKinds: AiSweepKind[] } | null,
): { enabled: boolean; sweepKinds: AiSweepKind[] } {
  return {
    enabled: baseline.enabled && (override?.enabled ?? true),
    sweepKinds: override
      ? baseline.sweepKinds.filter((kind) => override.sweepKinds.includes(kind))
      : [...baseline.sweepKinds],
  };
}

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
  if (kind === 'narrative') {
    if (sweepKinds.length > 0) {
      throw new ScheduleValidationError(
        'kinds_not_empty',
        'A narrative schedule evaluates no sweep kinds; sweepKinds must be empty',
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
  return { id: row.id, enabled: row.enabled, sweepKinds: row.sweepKinds };
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
 * A partner baseline may only target a PARTNER-WIDE, non-deleted `triage`
 * agent under the caller's own partner (spec: sweeps run the triage agent's
 * sweep profile; an org-owned agent has no authority over the partner's other
 * orgs).
 */
async function assertPartnerWideTriageAgent(agentId: string, partnerId: string): Promise<void> {
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
  if (agent.kind !== 'triage') {
    throw new ScheduleValidationError('agent_kind_not_triage', 'Only a triage agent can be scheduled');
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

  // The escape is taken ONLY when it is actually needed (partnerAxisRead.ts,
  // AVAILABILITY): a partner-scoped caller already passes
  // breeze_has_partner_access for its own partner and sees BOTH axes natively,
  // so escaping would open a second pooled connection while the request's own
  // transaction is still held, for zero visibility gain.
  const [row] = auth.scope === 'partner'
    ? await read()
    : await readWithPartnerAxisVisibility(read);
  if (!row) throw new AgentAccessDeniedError('Schedule not found');
  return row;
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
    await assertPartnerWideTriageAgent(input.agentId, partnerId);

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
        createdBy: auth.user.id,
        updatedAt: new Date(),
      })
      .returning();
    if (!row) throw new AgentAccessDeniedError('Schedule not created');
    return row;
  }

  assertAgentWriteAllowed(auth, { orgId: input.orgId, partnerId: null });
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

  // Org-scoped callers cannot see partner-axis rows at all (#2822), so the
  // baselines are read through the escape — where the app predicate is the ONLY
  // filter and therefore has to be maximally narrow: this partner's rows, for
  // this partner's own partner-wide triage agents, and nothing else.
  const baselines = await readWithPartnerAxisVisibility(async () => {
    const agentIds = await db
      .select({ id: aiAgents.id })
      .from(aiAgents)
      .where(and(
        isNull(aiAgents.orgId),
        eq(aiAgents.partnerId, orgPartnerId),
        eq(aiAgents.kind, 'triage'),
        // Same predicate as assertPartnerWideTriageAgent: a soft-deleted agent
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
  });

  // The org's OWN override rows are visible under its own RLS — no escape.
  const overrides = await overridesFor(orgId, baselines.map((b) => b.id));
  const byBaseline = new Map(overrides.map((o) => [o.baselineScheduleId as string, o]));
  return baselines.map((baseline) => toEffectiveDto(baseline, byBaseline.get(baseline.id), false));
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
