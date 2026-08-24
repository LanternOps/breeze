import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { CreateAiAgentInput, UpdateAiAgentInput } from '@breeze/shared';
import { db } from '../../db';
import { aiAgents, type AiAgentRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createAuditLog } from '../auditService';
import { captureException } from '../sentry';
import { getEventBus } from '../eventBus';
import { AgentAccessDeniedError, assertAgentWriteAllowed } from './access';
import { isSupportedAgentMode } from './constants';
import { normalizeAgentPolicy } from './effectivePolicy';
import { validateAgentRecipients } from './recipients';

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
  };
}

type AgentChange = 'created' | 'updated' | 'disabled';

async function recordAgentAudit(
  row: AiAgentRow,
  auth: AuthContext,
  change: AgentChange,
): Promise<void> {
  await createAuditLog({
    orgId: row.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: `ai.agent.${change}`,
    resourceType: 'ai_agent',
    resourceId: row.id,
    details: {
      agentId: row.id,
      kind: row.kind,
      ownerScope: row.partnerId === null ? 'organization' : 'partner',
      partnerId: row.partnerId,
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

async function recordMutation(
  row: AiAgentRow,
  auth: AuthContext,
  change: AgentChange,
): Promise<void> {
  await Promise.all([
    recordAgentAudit(row, auth, change),
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

  await recordMutation(row, auth, 'created');
  return row;
}

export async function updateAgent(
  auth: AuthContext,
  id: string,
  input: UpdateAiAgentInput,
): Promise<AiAgentRow> {
  const existing = await getAgent(auth, id);
  if (!existing || existing.disabledAt) {
    throw new AgentAccessDeniedError('Agent not found');
  }
  assertAgentWriteAllowed(auth, existing);

  // Validate the MERGED recipients — the exact object updatePolicyColumns
  // persists ({ ...stored, ...patch }), so what is checked is what is stored.
  if (input.recipients !== undefined) {
    const stored = normalizeAgentPolicy(existing);
    await validateAgentRecipients(
      { orgId: existing.orgId, partnerId: existing.partnerId },
      { ...stored.recipients, ...input.recipients },
    );
  }

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

  await recordMutation(row, auth, 'updated');
  return row;
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

  await recordMutation(row, auth, 'disabled');
  return row;
}
