import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { monitorDefinitions } from '../../db/schema/monitorDefinitions';
import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';
import type { AuthContext } from '../../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../partnerWideAccess';
import { normalizeAutomationActions } from '../automationRuntime';
import type { AutomationAction } from '../automationRuntime';
import { getMonitorKindSpec, MonitorValidationError } from './kinds';
import { compileMonitorInTx } from './monitorCompiler';
import type {
  CreateMonitorDefinitionInput,
  MonitorKind,
  UpdateMonitorDefinitionInput,
} from '@breeze/shared';

export { MonitorValidationError };

export class MonitorNotFoundError extends Error {
  constructor(id: string) {
    super(`Monitor definition ${id} not found`);
    this.name = 'MonitorNotFoundError';
  }
}

/** 403 at the route layer: the caller may not write in this ownership axis. */
export class MonitorOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitorOwnershipError';
  }
}

interface MonitorOwner {
  orgId: string | null;
  partnerId: string | null;
}

/**
 * Dual-axis READ condition (CLAUDE.md "Partner-Wide First" step 3).
 *
 * The partner-wide branch is admitted for ANY caller carrying a partnerId, not
 * only partner scope: the migration ships a FOR SELECT policy keyed on
 * `breeze_current_partner_id()`, so RLS itself confines the rows to the
 * caller's own partner. An org technician SHOULD see the MSP-wide monitors that
 * apply to their devices — they simply cannot write them (see assertCanWrite).
 */
function monitorReadCondition(auth: AuthContext): SQL | undefined {
  const orgCondition = auth.orgCondition(monitorDefinitions.orgId);
  if (!auth.partnerId) return orgCondition;
  const partnerWide = and(
    isNull(monitorDefinitions.orgId),
    eq(monitorDefinitions.partnerId, auth.partnerId),
  );
  if (auth.scope === 'system') return undefined;
  return orgCondition ? or(orgCondition, partnerWide) : partnerWide;
}

function assertCanWrite(auth: AuthContext, owner: MonitorOwner): void {
  if (owner.partnerId) {
    if (!canManagePartnerWidePolicies(auth)) {
      throw new MonitorOwnershipError(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    }
    if (auth.scope !== 'system' && auth.partnerId !== owner.partnerId) {
      throw new MonitorOwnershipError('Access to this partner denied');
    }
    return;
  }
  if (!owner.orgId) throw new MonitorOwnershipError('Organization context required');
  if (!auth.canAccessOrg(owner.orgId)) {
    throw new MonitorOwnershipError('Access to this organization denied');
  }
}

function resolveOwnerForCreate(input: CreateMonitorDefinitionInput, auth: AuthContext): MonitorOwner {
  if (input.ownerScope === 'partner') {
    if (!auth.partnerId) {
      throw new MonitorOwnershipError('Partner-wide monitors require partner scope');
    }
    if (!canManagePartnerWidePolicies(auth)) {
      throw new MonitorOwnershipError(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    }
    return { orgId: null, partnerId: auth.partnerId };
  }
  const orgId = input.orgId ?? auth.orgId;
  if (!orgId) throw new MonitorOwnershipError('Organization context required');
  if (!auth.canAccessOrg(orgId)) {
    throw new MonitorOwnershipError('Access to this organization denied');
  }
  return { orgId, partnerId: null };
}

/**
 * Validate the condition against its kind and normalise the responses.
 *
 * Both are re-checked here rather than trusted from the zod layer because the
 * service is also called from the AI tools and from convert-to-monitor, which
 * build their input in code rather than parsing a request body.
 */
function normalizeList(actions: unknown): AutomationAction[] {
  if (!Array.isArray(actions) || actions.length === 0) return [];
  return normalizeAutomationActions(actions);
}

function validateDefinitionShape(args: {
  kind: MonitorKind;
  condition: Record<string, unknown>;
  responses: unknown;
  recurrenceActions: unknown;
  aiAgentId: string | null | undefined;
}): { condition: Record<string, unknown>; responses: AutomationAction[]; recurrenceActions: AutomationAction[] } {
  const spec = getMonitorKindSpec(args.kind);
  const parsed = spec.conditionSchema.safeParse(args.condition);
  if (!parsed.success) {
    throw new MonitorValidationError(
      `condition does not match kind ${args.kind}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }

  let responses: AutomationAction[];
  let recurrenceActions: AutomationAction[];
  try {
    // A monitor with NO responses is the normal case (alert-only), but
    // `normalizeAutomationActions` throws on an empty array — an automation
    // must have at least one action. Normalise only non-empty lists, or every
    // create would fail on the schema's own `[]` default.
    responses = normalizeList(args.responses);
    recurrenceActions = normalizeList(args.recurrenceActions);
  } catch (error) {
    throw new MonitorValidationError(
      error instanceof Error ? error.message : 'invalid monitor responses',
    );
  }

  // ai_triage resolves its agent through automations.managed_by_agent_id, which
  // the compiler fills from the definition. No agent = an action that would
  // fail at run time with nothing to point at.
  if ([...responses, ...recurrenceActions].some((a) => a.type === 'ai_triage') && !args.aiAgentId) {
    throw new MonitorValidationError('ai_triage responses require aiAgentId');
  }

  return { condition: parsed.data as Record<string, unknown>, responses, recurrenceActions };
}

export async function listMonitorDefinitions(
  auth: AuthContext,
  filters?: { kind?: MonitorKind; enabled?: boolean },
): Promise<MonitorDefinitionRow[]> {
  const conditions: SQL[] = [];
  const read = monitorReadCondition(auth);
  if (read) conditions.push(read);
  if (filters?.kind) conditions.push(eq(monitorDefinitions.kind, filters.kind));
  if (filters?.enabled !== undefined) {
    conditions.push(eq(monitorDefinitions.enabled, filters.enabled));
  }

  return db
    .select()
    .from(monitorDefinitions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(monitorDefinitions.name));
}

export async function getMonitorDefinition(
  id: string,
  auth: AuthContext,
): Promise<MonitorDefinitionRow | null> {
  const read = monitorReadCondition(auth);
  const [row] = await db
    .select()
    .from(monitorDefinitions)
    .where(read ? and(eq(monitorDefinitions.id, id), read) : eq(monitorDefinitions.id, id))
    .limit(1);
  return row ?? null;
}

export async function createMonitorDefinition(
  input: CreateMonitorDefinitionInput,
  auth: AuthContext,
): Promise<MonitorDefinitionRow> {
  const owner = resolveOwnerForCreate(input, auth);
  const shape = validateDefinitionShape({
    kind: input.kind,
    condition: input.condition,
    responses: input.responses,
    recurrenceActions: input.recurrenceActions,
    aiAgentId: input.aiAgentId ?? null,
  });

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(monitorDefinitions)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        enabled: input.enabled,
        condition: shape.condition,
        severity: input.severity,
        cooldownMinutes: input.cooldownMinutes,
        autoResolve: input.autoResolve,
        autoResolveConditions: input.autoResolveConditions ?? null,
        responses: shape.responses as unknown as Array<Record<string, unknown>>,
        deliveryMode: input.deliveryMode,
        deliveryChannelIds: input.deliveryChannelIds,
        escalationPolicyId: input.escalationPolicyId ?? null,
        recurrenceThreshold: input.recurrenceThreshold ?? null,
        recurrenceWindowHours: input.recurrenceWindowHours ?? null,
        recurrenceActions: shape.recurrenceActions as unknown as Array<Record<string, unknown>>,
        pauseResponsesOnEscalation: input.pauseResponsesOnEscalation,
        aiAgentId: input.aiAgentId ?? null,
        createdBy: auth.user.id,
      })
      .returning();
    if (!created) throw new Error('Failed to create monitor definition');

    const refs = await compileMonitorInTx(tx, created);
    return {
      ...created,
      compiledAlertTemplateId: refs.alertTemplateId,
      compiledAlertRuleId: refs.alertRuleId,
      compiledAutomationId: refs.automationId,
      compiledHash: refs.hash,
    };
  });
}

export async function updateMonitorDefinition(
  id: string,
  input: UpdateMonitorDefinitionInput,
  auth: AuthContext,
): Promise<MonitorDefinitionRow> {
  const existing = await getMonitorDefinition(id, auth);
  if (!existing) throw new MonitorNotFoundError(id);
  assertCanWrite(auth, { orgId: existing.orgId, partnerId: existing.partnerId });

  // The MERGED definition is what gets validated: a PATCH that changes only the
  // kind must still be checked against the stored condition, and vice versa.
  const merged = {
    kind: (input.kind ?? existing.kind) as MonitorKind,
    condition: (input.condition ?? existing.condition) as Record<string, unknown>,
    responses: input.responses ?? existing.responses,
    recurrenceActions: input.recurrenceActions ?? existing.recurrenceActions,
    aiAgentId: input.aiAgentId !== undefined ? input.aiAgentId : existing.aiAgentId,
  };
  const shape = validateDefinitionShape(merged);

  const recurrenceThreshold =
    input.recurrenceThreshold !== undefined ? input.recurrenceThreshold : existing.recurrenceThreshold;
  const recurrenceWindowHours =
    input.recurrenceWindowHours !== undefined
      ? input.recurrenceWindowHours
      : existing.recurrenceWindowHours;
  if ((recurrenceThreshold == null) !== (recurrenceWindowHours == null)) {
    throw new MonitorValidationError(
      'recurrenceThreshold and recurrenceWindowHours must be set together',
    );
  }

  const deliveryMode = input.deliveryMode ?? existing.deliveryMode;
  const deliveryChannelIds = input.deliveryChannelIds ?? existing.deliveryChannelIds;
  if (deliveryMode === 'channels' && (deliveryChannelIds?.length ?? 0) === 0) {
    throw new MonitorValidationError('deliveryChannelIds required when deliveryMode is channels');
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(monitorDefinitions)
      .set({
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        kind: merged.kind,
        enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
        condition: shape.condition,
        severity: input.severity ?? existing.severity,
        cooldownMinutes: input.cooldownMinutes ?? existing.cooldownMinutes,
        autoResolve: input.autoResolve !== undefined ? input.autoResolve : existing.autoResolve,
        autoResolveConditions:
          input.autoResolveConditions !== undefined
            ? (input.autoResolveConditions ?? null)
            : existing.autoResolveConditions,
        responses: shape.responses as unknown as Array<Record<string, unknown>>,
        deliveryMode,
        deliveryChannelIds,
        escalationPolicyId:
          input.escalationPolicyId !== undefined
            ? (input.escalationPolicyId ?? null)
            : existing.escalationPolicyId,
        recurrenceThreshold: recurrenceThreshold ?? null,
        recurrenceWindowHours: recurrenceWindowHours ?? null,
        recurrenceActions: shape.recurrenceActions as unknown as Array<Record<string, unknown>>,
        pauseResponsesOnEscalation:
          input.pauseResponsesOnEscalation !== undefined
            ? input.pauseResponsesOnEscalation
            : existing.pauseResponsesOnEscalation,
        aiAgentId: merged.aiAgentId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(monitorDefinitions.id, id))
      .returning();
    if (!updated) throw new MonitorNotFoundError(id);

    const refs = await compileMonitorInTx(tx, updated);
    return { ...updated, compiledHash: refs.hash };
  });
}

export async function deleteMonitorDefinition(id: string, auth: AuthContext): Promise<void> {
  const existing = await getMonitorDefinition(id, auth);
  if (!existing) throw new MonitorNotFoundError(id);
  assertCanWrite(auth, { orgId: existing.orgId, partnerId: existing.partnerId });
  // The compiled template/rule/automation rows and every policy attachment go
  // with it through ON DELETE CASCADE; alerts keep their history with
  // monitor_id set to NULL.
  await db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, id));
}

/** Count of policy attachments per monitor, for the list view. */
export function attachmentCountSubquery() {
  return sql<number>`(SELECT count(*)::int FROM config_policy_monitors cpm WHERE cpm.monitor_id = ${monitorDefinitions.id})`;
}
