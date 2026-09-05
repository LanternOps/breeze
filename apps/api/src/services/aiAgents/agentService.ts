import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { AiAgentActAssets, AiAgentRecipients, CreateAiAgentInput, UpdateAiAgentInput } from '@breeze/shared';
import { db } from '../../db';
import { aiAgents, type AiAgentRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createAuditLog } from '../auditService';
import { captureException } from '../sentry';
import { getEventBus } from '../eventBus';
import { type RejectedAuthorizationKey, validateAuthorizationKeys } from '../actionIntents/policyDecidable';
import { ACT_ELIGIBLE_TOOL_NAMES } from './actManifest';
import { AgentAccessDeniedError, assertAgentWriteAllowed } from './access';
import { isSupportedAgentMode } from './constants';
import { normalizeAgentPolicy } from './effectivePolicy';
import {
  ensureManagedTriageAutomation,
  setManagedAutomationEnabled,
  syncManagedAutomation,
} from './managedAutomation';
import { hasResolvableAgentRecipient, validateAgentRecipients } from './recipients';

export class UnsupportedAgentModeError extends Error {
  readonly code = 'mode_not_supported';

  constructor(mode: string) {
    super(`mode_not_supported: ${mode}`);
    this.name = 'UnsupportedAgentModeError';
  }
}

/**
 * An invariant the code believes cannot be violated was violated anyway — a
 * RETURNING clause that came back empty, an owner-less row. Deliberately NOT
 * AgentAccessDeniedError: the route maps that to 404 by RETURNING a response,
 * which lets the request transaction COMMIT. A failed RETURNING read would then
 * insert the row, answer "Agent not created", and commit it — with no log and
 * no Sentry event. These must propagate so the transaction rolls back and the
 * global onError reports them.
 */
export class AgentInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentInvariantError';
  }
}

export class AgentKindConflictError extends Error {
  readonly code = 'agent_kind_exists';

  constructor(kind: string) {
    super(`agent_kind_exists: ${kind}`);
    this.name = 'AgentKindConflictError';
  }
}

/**
 * Wave 5 Part B (#3827). `actAssets.supervisedActionKeys` is the operator's
 * explicit per-agent authorization for `attemptPolicyDecision` to resolve a
 * matching Tier-3 intent WITHOUT human fanout — so an unknown, four_eyes,
 * Tier-4/blocked, or secret-bearing key must never be persisted here. `rejected`
 * names exactly which keys failed and why (validateAuthorizationKeys,
 * policyDecidable.ts) so the client (Task 5's editor) can render an actionable
 * message rather than a bare 422.
 */
export class InvalidSupervisedActionKeysError extends Error {
  readonly code = 'invalid_supervised_action_keys';

  constructor(public rejected: RejectedAuthorizationKey[]) {
    super(`invalid_supervised_action_keys: ${rejected.map((r) => r.key).join(', ')}`);
    this.name = 'InvalidSupervisedActionKeysError';
  }
}

/**
 * Wave 4 Part B (Task 6, #3826). A write that would leave the row with
 * `mode: 'act'` must clear two prerequisites BEFORE anything is persisted:
 * at least one recipient that currently resolves to a real user (an
 * unattended agent nobody can be notified about is worse than no agent), and
 * at least one act-eligible allowlisted surface (an act-mode agent that can
 * never actually reach the manifest is a mode flag with no effect — the
 * operator almost certainly meant something else). `missing` names exactly
 * which ones failed so the client can render an actionable message rather
 * than a bare "not met".
 */
export class ActPrerequisitesNotMetError extends Error {
  readonly code = 'act_prerequisites_not_met';

  constructor(public missing: Array<'recipient' | 'act_eligible_tool'>) {
    super(`act_prerequisites_not_met: ${missing.join(', ')}`);
    this.name = 'ActPrerequisitesNotMetError';
  }
}

/**
 * Task 6's second prerequisite: the allowlist must intersect the manifest's
 * real tool names, and `run_script` only counts when at least one script is
 * actually authorized (`actAssets.scriptIds`) — an allowlist admitting
 * run_script with an empty actAssets is exactly "never act-eligible" (Global
 * Constraints, plan header), not a real surface.
 *
 * Allowlist entries are matched by BASE tool name, not exact string.
 * checkAgentGuardrails (aiGuardrails.ts) admits an allowlist entry in either
 * the bare `toolName` form or the scoped `toolName:action` form for
 * action-multiplexed tools (manage_services, disk_cleanup, ...) — the guardrail
 * is authoritative, so this prerequisite must recognize the same scoped form.
 * Without this, the tightest and repo-documented act config
 * (`['manage_services:restart']`, packages/shared/src/validators/aiAgents.test.ts)
 * would be refused with a 422 even though it is a real act-eligible surface.
 */
function hasActEligibleSurface(
  toolAllowlist: string[],
  actAssets: Partial<AiAgentActAssets>,
): boolean {
  // Wave 5 Part B (#3827): a non-empty supervisedActionKeys set is ITSELF a
  // real act-eligible surface — exactly what makes the agent act unattended
  // for those keys — independent of the wave-4 ACT_MANIFEST/toolAllowlist
  // check below. Without this branch, an agent configured ONLY for
  // policy-decide on a tool ACT_MANIFEST doesn't cover (security_scan,
  // manage_startup_items, manage_scheduled_tasks all qualify;
  // manage_services happens to overlap both lanes) could never satisfy this
  // prerequisite and so could never enter act mode at all — the write-time
  // key validation (assertSupervisedActionKeysValid) already guarantees any
  // non-empty value here is genuine POLICY_DECIDABLE_TIER3 membership, so
  // trusting length alone is safe.
  if ((actAssets.supervisedActionKeys?.length ?? 0) > 0) return true;

  const eligible = new Set(ACT_ELIGIBLE_TOOL_NAMES);
  const baseName = (entry: string): string => entry.split(':', 1)[0] ?? entry;
  const intersecting = toolAllowlist.filter((entry) => eligible.has(baseName(entry)));
  if (intersecting.some((entry) => baseName(entry) !== 'run_script')) return true;
  if (!intersecting.some((entry) => baseName(entry) === 'run_script')) return false;
  return (actAssets.scriptIds?.length ?? 0) > 0;
}

/**
 * Wave 5 Part B (#3827) write-time gate. Validates exactly the keys THIS
 * write is setting — never the merged/stored value — so a key the registry
 * has since dropped stays stored-but-inert (Design authority, plan header:
 * "stored authorization keys tolerated-but-inert when the registry drops
 * them") rather than retroactively blocking an unrelated future edit that
 * never touches actAssets.supervisedActionKeys at all. No-op on an absent or
 * empty array.
 */
function assertSupervisedActionKeysValid(keys: string[] | undefined): void {
  if (!keys || keys.length === 0) return;
  const { rejected } = validateAuthorizationKeys(keys);
  if (rejected.length > 0) throw new InvalidSupervisedActionKeysError(rejected);
}

/**
 * Throws ActPrerequisitesNotMetError unless the write's RESULTING mode is
 * something other than 'act', or both prerequisites are met by what will
 * actually be persisted — never by the caller's raw patch alone, which is
 * how an update that patches only `mode: 'act'` onto an agent with existing
 * recipients/allowlist correctly passes.
 */
async function assertActPrerequisites(
  owner: AgentOwner,
  resolved: {
    mode: string;
    toolAllowlist: string[];
    actAssets: Partial<AiAgentActAssets>;
    recipients: Partial<AiAgentRecipients>;
  },
): Promise<void> {
  if (resolved.mode !== 'act') return;

  const missing: Array<'recipient' | 'act_eligible_tool'> = [];
  const hasRecipient = await hasResolvableAgentRecipient(owner, resolved.recipients);
  if (!hasRecipient) missing.push('recipient');
  if (!hasActEligibleSurface(resolved.toolAllowlist, resolved.actAssets)) {
    missing.push('act_eligible_tool');
  }
  if (missing.length > 0) throw new ActPrerequisitesNotMetError(missing);
}

export interface AgentOwner {
  orgId: string | null;
  partnerId: string | null;
}

type ScalarPolicyInput = Partial<Pick<
  CreateAiAgentInput,
  | 'enabled'
  | 'mode'
  | 'model'
  | 'toolAllowlist'
  | 'instructions'
  | 'cooldownSeconds'
>>;

function scalarPolicyColumns(input: ScalarPolicyInput): Partial<typeof aiAgents.$inferInsert> {
  const out: Partial<typeof aiAgents.$inferInsert> = {};
  if (input.enabled !== undefined) out.enabled = input.enabled;
  if (input.mode !== undefined) {
    if (!isSupportedAgentMode(input.mode)) {
      throw new UnsupportedAgentModeError(input.mode);
    }
    out.mode = input.mode;
  }
  if (input.model !== undefined) out.model = input.model;
  if (input.toolAllowlist !== undefined) out.toolAllowlist = input.toolAllowlist;
  if (input.instructions !== undefined) out.instructions = input.instructions;
  if (input.cooldownSeconds !== undefined) out.cooldownSeconds = input.cooldownSeconds;
  return out;
}

function createPolicyColumns(input: CreateAiAgentInput): Partial<typeof aiAgents.$inferInsert> {
  return {
    ...scalarPolicyColumns(input),
    protectedResources: input.protectedResources,
    limits: input.limits,
    triggers: input.triggers,
    recipients: input.recipients,
    actAssets: input.actAssets,
  };
}

function updatePolicyColumns(
  existing: AiAgentRow,
  input: UpdateAiAgentInput,
): Partial<typeof aiAgents.$inferInsert> {
  const stored = normalizeAgentPolicy(existing);
  return {
    ...scalarPolicyColumns(input),
    ...(input.protectedResources === undefined
      ? {}
      : { protectedResources: { ...stored.protectedResources, ...input.protectedResources } }),
    ...(input.limits === undefined
      ? {}
      : { limits: { ...stored.limits, ...input.limits } }),
    ...(input.triggers === undefined
      ? {}
      : { triggers: { ...stored.triggers, ...input.triggers } }),
    ...(input.recipients === undefined
      ? {}
      : { recipients: { ...stored.recipients, ...input.recipients } }),
    ...(input.actAssets === undefined
      ? {}
      : { actAssets: { ...stored.actAssets, ...input.actAssets } }),
  };
}

/**
 * `enabled` is the un-archive in `POST /:id/enable` (routes/aiAgents.ts) — the
 * inverse of `disabled`, and the reason this union is not private to this file:
 * that route owns the write but must record it through the SAME pair of side
 * effects, or the one agent mutation implemented outside this service silently
 * skips the `ai.agent.policy_changed` broadcast every other one publishes.
 */
type AgentChange = 'created' | 'updated' | 'disabled' | 'enabled';

async function recordAgentAudit(
  row: AiAgentRow,
  auth: AuthContext,
  change: AgentChange,
  extraDetails?: Record<string, unknown>,
): Promise<void> {
  await createAuditLog({
    orgId: row.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: `ai.agent.${change}`,
    resourceType: 'ai_agent',
    resourceId: row.id,
    resourceName: row.name,
    details: {
      agentId: row.id,
      kind: row.kind,
      ownerScope: row.partnerId === null ? 'organization' : 'partner',
      partnerId: row.partnerId,
      ...extraDetails,
    },
    result: 'success',
  });
}

async function publishPolicyChanged(
  row: AiAgentRow,
  actorId: string,
  change: AgentChange,
): Promise<void> {
  // The event envelope predates partner-axis events and names this routing key
  // orgId. Partner-wide changes are routed under partnerId rather than skipped;
  // the payload makes the ownership axis explicit for consumers.
  const routingId = row.orgId ?? row.partnerId;
  if (!routingId) throw new AgentInvariantError('Agent has no owner');

  try {
    await getEventBus().publish(
      'ai.agent.policy_changed',
      routingId,
      {
        agentId: row.id,
        kind: row.kind,
        change,
        actorId,
        ownerScope: row.partnerId === null ? 'organization' : 'partner',
      },
      'ai-agents',
    );
  } catch (err) {
    // This used to RETHROW for 'disabled', reasoning that a kill switch must
    // not report success if the stop signal never reached in-flight runners.
    // That inverted the safety property it was defending. The whole request
    // runs in one withDbAccessContext transaction, so throwing here rolled back
    // the `disabled_at` write itself: during a Redis outage the operator could
    // not disable the agent AT ALL, the row stayed enabled, and every runner
    // started after the outage read an enabled policy and kept going. It also
    // left a lie in the audit log — persistAuditLog escapes the request
    // transaction (runOutsideDbContext + withSystemDbAccessContext), so the
    // 'ai.agent.disabled' row committed while the agent stayed live.
    //
    // Committing the disable is strictly safer in every direction: the DB is
    // the source of truth for every subsequent policy read (resolveEffectiveAgent
    // filters on disabled_at IS NULL), so the agent is off for anything that
    // starts from now on, and only genuinely in-flight runs miss the interrupt
    // — bounded by wallClockSeconds, at most 1800s. The caller is told, rather
    // than lied to in either direction, by the log below.
    //
    // TODO(wave 3): once runners actually consume this event, a dropped
    // 'disabled' broadcast needs to reach the OPERATOR, not just the logs —
    // surface it on the response so the UI can say the agent is off but an
    // in-flight run may continue to its wall-clock limit.
    captureException(err, undefined, {
      service: 'aiAgents',
      operation: 'publishPolicyChanged',
      agentId: row.id,
      kind: row.kind,
      change,
    });
    console.error(
      `[aiAgents] policy_changed publish failed (agent=${row.id} kind=${row.kind} change=${change}); ` +
        'the DB write stands, in-flight runs may not have been interrupted:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The two side effects EVERY agent mutation owes: an awaited `ai.agent.<change>`
 * audit row and the `ai.agent.policy_changed` broadcast in-flight runners read.
 *
 * Exported because `POST /:id/enable` writes its row in the route layer (the
 * lock, the tenancy predicate and the conflict pre-check are reused there, but
 * the write itself never moved into this service). It used to audit through
 * `writeRouteAudit` — the fire-and-forget variant — and publish nothing at all,
 * so un-archiving an agent was the one mutation whose policy change no runner
 * ever heard about. Route-layer writers call THIS, not the two halves.
 *
 * @param extraDetails merged into the audit `details` after the standard keys,
 *   for facts only the caller knows (e.g. that an un-archive deliberately
 *   leaves `enabled` false).
 */
export async function recordAgentMutation(
  row: AiAgentRow,
  auth: AuthContext,
  change: AgentChange,
  extraDetails?: Record<string, unknown>,
): Promise<void> {
  await Promise.all([
    recordAgentAudit(row, auth, change, extraDetails),
    publishPolicyChanged(row, auth.user.id, change),
  ]);
}

/**
 * The set of agents this caller may see, on either ownership axis. Partner-wide
 * rows are added only for partner-scoped callers: an org token carries a
 * partnerId but never passes breeze_has_partner_access, so RLS would hide those
 * rows from it regardless — the app layer must not be looser than RLS.
 */
function accessibleAgentCondition(auth: AuthContext) {
  return auth.scope === 'partner' && auth.partnerId
    ? or(auth.orgCondition(aiAgents.orgId), and(isNull(aiAgents.orgId), eq(aiAgents.partnerId, auth.partnerId)))
    : auth.orgCondition(aiAgents.orgId);
}

export async function listAgents(
  auth: AuthContext,
  opts: { includeDisabled?: boolean } = {},
): Promise<AiAgentRow[]> {
  // Defended twice. RLS is the real boundary and it already denies a
  // contextless read: breeze_current_scope() defaults to 'none', NOT 'system'
  // (migrations/0012-tenant-rls-deny-default.sql superseded 0008), so both
  // branches of the policy are false and the read comes back empty. An earlier
  // version of this comment claimed the opposite — that contextless meant a
  // full bypass — which inverted the failure mode on a multi-tenant surface.
  //
  // The app-layer predicate stays anyway, for two reasons that are real: the
  // unit-test path mocks the db and has no RLS at all, and the old signature
  // (_auth, ignored) made an unfiltered read look authorized to the next caller.
  // Partner-wide rows are only added for partner-scoped callers: an org token
  // carries a partnerId but never passes breeze_has_partner_access.
  const ownerScope = accessibleAgentCondition(auth);

  return db
    .select()
    .from(aiAgents)
    .where(opts.includeDisabled ? ownerScope : and(ownerScope, isNull(aiAgents.disabledAt)))
    .orderBy(desc(aiAgents.createdAt));
}

export async function getAgent(
  auth: AuthContext,
  id: string,
): Promise<AiAgentRow | null> {
  // Bound by the same predicate as listAgents. This used to be `(_auth, id)`
  // with RLS as the sole defence — which is correct for every HTTP caller
  // (authMiddleware opens a DB context for all of them) but makes an
  // unfiltered read look authorized to the next caller. Wave 3 mutates agents
  // from schedulers that run in a SYSTEM context, where RLS passes
  // unconditionally, and a discarded `auth` parameter is exactly how such a
  // call reads as safe while returning every partner's row.
  const [row] = await db
    .select()
    .from(aiAgents)
    .where(and(eq(aiAgents.id, id), accessibleAgentCondition(auth)))
    .limit(1);
  return row ?? null;
}

/**
 * Task 8 (#4192). `actAssets` is a jsonb column every writer merges into
 * read-modify-write (`{ ...stored.actAssets, ...patch }`, same shape as
 * recipients above) — without a row lock, two concurrent writers (an
 * operator PATCH racing a scheduler's promote/demote CAS) can each read the
 * same starting object and each commit an UPDATE that silently drops the
 * other's key. `withAgentRowLocked` is the one place every such writer is
 * meant to route through: it takes a `SELECT … FOR UPDATE` on exactly one
 * row, bound by the SAME predicate `getAgent` uses, then runs `fn` with the
 * locked row inside the caller's ambient transaction (routes/aiAgents.ts
 * already opens `withDbAccessContext` per request, so no new transaction is
 * started here — the lock is held for the rest of that transaction, same
 * mechanic as `recordVerdictFeedback`'s `.for('update')` on `ai_alert_verdicts`,
 * alertVerdicts.ts:637).
 *
 * `auth: null` is the system-caller shape A2's promote/demote executors
 * (not in this PR) are expected to use, run from a scheduler with no HTTP
 * request or AuthContext — the same SYSTEM-context case `getAgent`'s own
 * comment documents. Fix round 1/5: this branch previously dropped the
 * tenancy predicate to `id` alone, reasoning that RLS passes unconditionally
 * under a system DB context so an app-layer predicate could only narrow an
 * already-trusted caller. That reasoning is exactly what this repo's
 * tenancy invariant rejects (CLAUDE.md: "every new loader predicates by
 * org_id explicitly under the system context") — a forged or mismatched
 * agent id would lock and return another tenant's row. The system branch
 * now REQUIRES `opts.orgId` (enforced both by the overload below and at
 * runtime) and predicates by `id + org_id`, never `id` alone.
 *
 * Callers must not re-check "not found" — a predicate miss is reported as
 * `AgentAccessDeniedError` from here, before `fn` ever runs. Anything else
 * (disabled row, write-scope denial) is the caller's job, checked inside
 * `fn` against the row this function handed it, never against a second
 * unlocked read.
 */
export async function withAgentRowLocked<T>(
  auth: AuthContext,
  id: string,
  fn: (row: AiAgentRow) => Promise<T>,
): Promise<T>;
export async function withAgentRowLocked<T>(
  auth: null,
  id: string,
  fn: (row: AiAgentRow) => Promise<T>,
  opts: { orgId: string },
): Promise<T>;
export async function withAgentRowLocked<T>(
  auth: AuthContext | null,
  id: string,
  fn: (row: AiAgentRow) => Promise<T>,
  opts?: { orgId: string },
): Promise<T> {
  if (auth === null && !opts?.orgId) {
    // Programmer error, not a tenancy denial — a system caller that forgot
    // to bind an org would otherwise fall through to an id-only predicate,
    // which is the exact cross-tenant hole this overload exists to close.
    throw new AgentInvariantError('withAgentRowLocked: system caller (auth: null) requires opts.orgId');
  }
  const condition = auth === null
    ? and(eq(aiAgents.id, id), eq(aiAgents.orgId, opts!.orgId))
    : and(eq(aiAgents.id, id), accessibleAgentCondition(auth));

  const [row] = await db
    .select()
    .from(aiAgents)
    .where(condition)
    .limit(1)
    .for('update');
  if (!row) throw new AgentAccessDeniedError('Agent not found');

  return fn(row);
}

export async function createAgent(
  auth: AuthContext,
  owner: AgentOwner,
  input: CreateAiAgentInput,
): Promise<AiAgentRow> {
  assertAgentWriteAllowed(auth, owner);

  // Recipients are membership-validated BEFORE anything is written: a typo'd
  // or cross-tenant id must never be persisted, because notification-time
  // resolution silently drops what it cannot verify (services/aiAgents/
  // recipients.ts) — an invalid entry stored here would be a recipient that
  // silently never hears anything.
  await validateAgentRecipients(owner, input.recipients ?? {});

  // Wave 5 Part B (#3827): a create-supplied supervisedActionKeys set is
  // validated against POLICY_DECIDABLE_TIER3 before anything is written, same
  // reason as recipients above — a rejected key must never be persisted.
  assertSupervisedActionKeysValid(input.actAssets.supervisedActionKeys);

  // Task 6 (#3826): a create that would land with mode: 'act' must already
  // have a resolvable recipient and an act-eligible surface — checked against
  // exactly what THIS create will persist (input's own fields are already
  // complete: createAiAgentSchema materializes every nested default).
  await assertActPrerequisites(owner, {
    mode: input.mode,
    toolAllowlist: input.toolAllowlist,
    actAssets: input.actAssets,
    recipients: input.recipients,
  });

  // Pre-check the partial unique indexes on (partner_id, kind) and (org_id,
  // kind) WHERE disabled_at IS NULL. Letting the insert trip 23505 is not an
  // option here: the whole request runs inside one withDbAccessContext
  // transaction, so an in-statement error poisons it and the COMMIT 500s
  // (same reason routes/discovery.ts pre-checks its provenance key). This is
  // advisory, not the boundary — the indexes still settle a concurrent race,
  // which then surfaces as a 500 rather than a wrong row.
  const [conflict] = await db
    .select({ id: aiAgents.id })
    .from(aiAgents)
    .where(and(
      owner.partnerId === null
        ? eq(aiAgents.orgId, owner.orgId as string)
        : and(eq(aiAgents.partnerId, owner.partnerId), isNull(aiAgents.orgId)),
      eq(aiAgents.kind, input.kind),
      isNull(aiAgents.disabledAt),
    ))
    .limit(1);
  if (conflict) throw new AgentKindConflictError(input.kind);

  const [row] = await db
    .insert(aiAgents)
    .values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      kind: input.kind,
      name: input.name,
      ...createPolicyColumns(input),
      createdBy: auth.user.id,
      lastUpdatedBy: auth.user.id,
      updatedAt: new Date(),
    })
    .returning();
  if (!row) throw new AgentInvariantError('Agent not created');

  // Seed before the audit: this whole request is one withDbAccessContext
  // transaction, so a wiring failure must roll the agent insert back rather
  // than leave an audited agent with no trigger automation.
  await ensureManagedTriageAutomation(row);
  await recordAgentMutation(row, auth, 'created');
  return row;
}

export async function updateAgent(
  auth: AuthContext,
  id: string,
  input: UpdateAiAgentInput,
): Promise<AiAgentRow> {
  // Task 8 (#4192): the whole read-validate-write below now runs against a
  // row `withAgentRowLocked` has already SELECT … FOR UPDATE'd, so a
  // concurrent writer of `actAssets` (A2's promote/demote executors) blocks
  // on this transaction rather than racing it. The disabled/write-scope
  // checks move inside the callback so they read the LOCKED row, not a
  // separate unlocked `getAgent` — `withAgentRowLocked` itself only reports
  // "not found" for a predicate miss; everything else is this callback's job.
  return withAgentRowLocked(auth, id, async (existing) => {
    if (existing.disabledAt) {
      throw new AgentAccessDeniedError('Agent not found');
    }
    assertAgentWriteAllowed(auth, existing);

    const stored = normalizeAgentPolicy(existing);
    const owner: AgentOwner = { orgId: existing.orgId, partnerId: existing.partnerId };

    // Validate the MERGED recipients — the exact object updatePolicyColumns
    // persists ({ ...stored, ...patch }), so what is checked is what is stored.
    const mergedRecipients = input.recipients === undefined
      ? stored.recipients
      : { ...stored.recipients, ...input.recipients };
    if (input.recipients !== undefined) {
      await validateAgentRecipients(owner, mergedRecipients);
    }

    // Wave 5 Part B (#3827): validate only the keys THIS patch is setting, not
    // the merged/stored value — see assertSupervisedActionKeysValid's doc.
    if (input.actAssets?.supervisedActionKeys !== undefined) {
      assertSupervisedActionKeysValid(input.actAssets.supervisedActionKeys);
    }

    // Task 6 (#3826): prerequisites are checked against what the update will
    // actually PERSIST (merged, same as recipients above) — never just the raw
    // patch. A PATCH touching only `mode: 'act'` on an already-equipped agent
    // passes; a PATCH that narrows the allowlist/actAssets/recipients out from
    // under an existing act-mode agent is refused before the UPDATE runs.
    await assertActPrerequisites(owner, {
      mode: input.mode ?? stored.mode,
      toolAllowlist: input.toolAllowlist ?? stored.toolAllowlist,
      actAssets: input.actAssets === undefined ? stored.actAssets : { ...stored.actAssets, ...input.actAssets },
      recipients: mergedRecipients,
    });

    const [row] = await db
      .update(aiAgents)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...updatePolicyColumns(existing, input),
        lastUpdatedBy: auth.user.id,
        updatedAt: new Date(),
      })
      .where(and(eq(aiAgents.id, id), isNull(aiAgents.disabledAt)))
      .returning();
    if (!row) throw new AgentAccessDeniedError('Agent not found');

    // Mirroring the disable direction too is deliberate symmetry: one switch
    // updates both the agent policy and its managed wiring before audit.
    const managedPatch: { name?: string; enabled?: boolean } = {};
    if (input.name !== undefined && input.name !== existing.name) managedPatch.name = row.name;
    if (input.enabled !== undefined && input.enabled !== existing.enabled) managedPatch.enabled = row.enabled;
    if (managedPatch.name !== undefined || managedPatch.enabled !== undefined) {
      await syncManagedAutomation(row.id, managedPatch);
    }
    await recordAgentMutation(row, auth, 'updated');
    return row;
  });
}

export async function disableAgent(auth: AuthContext, id: string): Promise<AiAgentRow> {
  const existing = await getAgent(auth, id);
  if (!existing || existing.disabledAt) {
    throw new AgentAccessDeniedError('Agent not found');
  }
  assertAgentWriteAllowed(auth, existing);

  const [row] = await db
    .update(aiAgents)
    .set({
      disabledAt: new Date(),
      disabledBy: auth.user.id,
      enabled: false,
      lastUpdatedBy: auth.user.id,
      updatedAt: new Date(),
    })
    .where(and(eq(aiAgents.id, id), isNull(aiAgents.disabledAt)))
    .returning();
  if (!row) throw new AgentAccessDeniedError('Agent not found');

  // Agents are never hard-deleted (managed_by_agent_id is ON DELETE RESTRICT),
  // so soft-disable must also stop the wiring from generating queue traffic.
  await setManagedAutomationEnabled(row.id, false);
  await recordAgentMutation(row, auth, 'disabled');
  return row;
}
