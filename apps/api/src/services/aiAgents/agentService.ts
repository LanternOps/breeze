import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { CreateAiAgentInput, UpdateAiAgentInput } from '@breeze/shared';
import { db } from '../../db';
import { aiAgents, type AiAgentRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createAuditLog } from '../auditService';
import { getEventBus } from '../eventBus';
import { AgentAccessDeniedError, assertAgentWriteAllowed } from './access';
import { isSupportedAgentMode } from './constants';
import { normalizeAgentPolicy } from './effectivePolicy';

export class UnsupportedAgentModeError extends Error {
  readonly code = 'mode_not_supported';

  constructor(mode: string) {
    super(`mode_not_supported: ${mode}`);
    this.name = 'UnsupportedAgentModeError';
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
  if (!routingId) throw new AgentAccessDeniedError('Agent has no owner');

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
    // 'disabled' is the kill switch. If the event does not reach the bus,
    // in-flight runners never learn to stop, so reporting success here would be
    // a lie about the thing the operator most needs to be true. Create/update
    // stay best-effort — a dropped notification there is cosmetic.
    if (change === 'disabled') throw err;
    console.error(
      '[aiAgents] eventBus publish failed:',
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

export async function listAgents(
  auth: AuthContext,
  opts: { includeDisabled?: boolean } = {},
): Promise<AiAgentRow[]> {
  // Defended twice. RLS is the real boundary, but a caller that reaches this
  // without a DB context runs as scope='system' and would read EVERY partner's
  // agents — and the old signature (_auth, ignored) made that look authorized.
  // Partner-wide rows are only added for partner-scoped callers: an org token
  // carries a partnerId but never passes breeze_has_partner_access.
  const ownerScope = auth.scope === 'partner' && auth.partnerId
    ? or(auth.orgCondition(aiAgents.orgId), and(isNull(aiAgents.orgId), eq(aiAgents.partnerId, auth.partnerId)))
    : auth.orgCondition(aiAgents.orgId);

  return db
    .select()
    .from(aiAgents)
    .where(opts.includeDisabled ? ownerScope : and(ownerScope, isNull(aiAgents.disabledAt)))
    .orderBy(desc(aiAgents.createdAt));
}

export async function getAgent(
  _auth: AuthContext,
  id: string,
): Promise<AiAgentRow | null> {
  const [row] = await db.select().from(aiAgents).where(eq(aiAgents.id, id)).limit(1);
  return row ?? null;
}

export async function createAgent(
  auth: AuthContext,
  owner: AgentOwner,
  input: CreateAiAgentInput,
): Promise<AiAgentRow> {
  assertAgentWriteAllowed(auth, owner);

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
  if (!row) throw new AgentAccessDeniedError('Agent not created');

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
