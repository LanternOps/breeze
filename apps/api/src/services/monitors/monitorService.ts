import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { monitorDefinitions } from '../../db/schema/monitorDefinitions';
import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';
import { escalationPolicies } from '../../db/schema/alerts';
import { organizations } from '../../db/schema/orgs';
import { networkMonitors } from '../../db/schema/monitors';
import { monitorConversions } from '../../db/schema/monitorConversions';
import type { AuthContext } from '../../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../partnerWideAccess';
import { normalizeAutomationActions } from '../automationRuntime';
import type { AutomationAction } from '../automationRuntime';
import { getMonitorKindSpec, MonitorValidationError } from './kinds';
import { compileMonitorInTx, type CompileOptions, type DbExecutor } from './monitorCompiler';
import { assertNetworkCheckAssetOwner, NetworkCheckAssetError } from './networkCheckAsset';
import { isPgForeignKeyViolation, pgErrorConstraint } from '../../utils/pgErrors';
import type {
  CreateMonitorDefinitionInput,
  MonitorKind,
  UpdateMonitorDefinitionInput,
} from '@breeze/shared';

export { MonitorValidationError };
export { NetworkMonitorAdoptionError, type CompileOptions } from './monitorCompiler';

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

/**
 * 409 at the route layer (#6509): the delete cascaded into a row some OTHER
 * table still references with no ON DELETE action. `alerts.rule_id` is fixed
 * (SET NULL, 2026-10-25-130200) so this should not fire in the ordinary case
 * any more, but it stays as a belt-and-braces map so any future/residual FK a
 * monitor's cascade touches surfaces as a clean 409 instead of a raw
 * postgres constraint-violation message leaking to the client.
 */
export class MonitorHasDependentsError extends Error {
  constructor(id: string, options?: ErrorOptions) {
    super(`Monitor definition ${id} still has rows referencing it that cannot be cascaded`, options);
    this.name = 'MonitorHasDependentsError';
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
 * Owner-compatibility guard for `escalation_policy_id` (#5676).
 *
 * `monitor_definitions` and `escalation_policies` are both dual-axis
 * (org_id XOR partner_id, or partner-wide with org_id NULL) but nothing tied
 * them together: a partner-wide monitor could reference an org-owned
 * escalation policy, which resolves fine for devices in THAT org but fails
 * closed for every other org the partner-wide monitor also applies to
 * (misconfiguration, not a tenant leak — dispatch already fails closed on a
 * cross-tenant policy id). Reject the mismatch at write time instead.
 *
 * Compatible pairings:
 *   - partner-wide monitor (orgId null)  -> no policy, or a partner-wide
 *     policy owned by the SAME partner.
 *   - org-scoped monitor (orgId set)     -> no policy, a policy owned by
 *     that same org, or a partner-wide policy owned by the org's partner.
 *
 * Deny on a lookup miss (matches `isMonitorAttachableToPolicy`'s
 * COALESCE(..., false) posture) rather than letting a bad id fall through to
 * the FK's own error shape.
 */
async function assertEscalationPolicyCompatible(
  escalationPolicyId: string | null,
  owner: MonitorOwner,
  executor: DbExecutor = db,
): Promise<void> {
  if (!escalationPolicyId) return;

  const [policy] = await executor
    .select({ orgId: escalationPolicies.orgId, partnerId: escalationPolicies.partnerId })
    .from(escalationPolicies)
    .where(eq(escalationPolicies.id, escalationPolicyId))
    .limit(1);
  if (!policy) {
    throw new MonitorValidationError('Escalation policy not found');
  }

  if (owner.partnerId) {
    if (policy.orgId === null && policy.partnerId === owner.partnerId) return;
    throw new MonitorValidationError(
      'A partner-wide monitor may only reference a partner-wide escalation policy owned by the same partner',
    );
  }

  if (policy.orgId === owner.orgId) return;
  if (policy.orgId === null) {
    const [org] = await executor
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, owner.orgId!))
      .limit(1);
    if (org?.partnerId && org.partnerId === policy.partnerId) return;
  }
  throw new MonitorValidationError(
    'Escalation policy must be owned by this organization or be partner-wide for its partner',
  );
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

type MonitorListFilters = { kind?: MonitorKind; enabled?: boolean };

/**
 * The visibility + filter predicate shared by listMonitorDefinitions and
 * listMonitorDefinitionsPage. The page applies it to both its count and its
 * rows, so `total` is counted over exactly the rows the page can return.
 */
function listConditions(auth: AuthContext, filters?: MonitorListFilters): SQL | undefined {
  const conditions: SQL[] = [];
  const read = monitorReadCondition(auth);
  if (read) conditions.push(read);
  if (filters?.kind) conditions.push(eq(monitorDefinitions.kind, filters.kind));
  if (filters?.enabled !== undefined) {
    conditions.push(eq(monitorDefinitions.enabled, filters.enabled));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** List the caller's visible monitor definitions, ordered by name (unpaged; the REST list route). */
export async function listMonitorDefinitions(
  auth: AuthContext,
  filters?: MonitorListFilters,
): Promise<MonitorDefinitionRow[]> {
  return db
    .select()
    .from(monitorDefinitions)
    .where(listConditions(auth, filters))
    .orderBy(asc(monitorDefinitions.name));
}

/**
 * One page of the caller's visible monitor definitions, paged in SQL (#6735),
 * with the total of the whole filtered set.
 *
 * The page and the total come from ONE statement, so they share one snapshot:
 * separate statements under READ COMMITTED can each see a different set, and
 * a concurrent insert or delete between them would make `total`/`hasMore`
 * disagree with the rows returned. The statement reads a one-row count and
 * LEFT JOINs the page onto it, so an empty page (nothing visible, or an
 * offset past the end) still carries the real total with no second query.
 * `id` breaks name ties so the order is deterministic for an unchanged set.
 * This is offset paging (the shared AI-tool cursor carries only an offset):
 * a monitor added or removed between two page requests can still make a
 * later page repeat or skip a row. Each page's own total is consistent.
 */
export async function listMonitorDefinitionsPage(
  auth: AuthContext,
  filters: MonitorListFilters | undefined,
  page: { limit: number; offset: number },
): Promise<{ rows: MonitorDefinitionRow[]; total: number }> {
  const where = listConditions(auth, filters);
  const counted = db
    .select({ total: sql<number>`count(*)::int`.as('total') })
    .from(monitorDefinitions)
    .where(where)
    .as('counted');
  const pageIds = db
    .select({ id: monitorDefinitions.id })
    .from(monitorDefinitions)
    .where(where)
    .orderBy(asc(monitorDefinitions.name), asc(monitorDefinitions.id))
    .limit(page.limit)
    .offset(page.offset);
  const rows = await db
    .select({ total: counted.total, row: monitorDefinitions })
    .from(counted)
    .leftJoin(monitorDefinitions, inArray(monitorDefinitions.id, pageIds))
    .orderBy(asc(monitorDefinitions.name), asc(monitorDefinitions.id));

  return {
    rows: rows.flatMap((r) => (r.row ? [r.row] : [])),
    total: Number(rows[0]?.total ?? 0),
  };
}

export async function getMonitorDefinition(
  id: string,
  auth: AuthContext,
  executor: DbExecutor = db,
): Promise<MonitorDefinitionRow | null> {
  const read = monitorReadCondition(auth);
  const [row] = await executor
    .select()
    .from(monitorDefinitions)
    .where(read ? and(eq(monitorDefinitions.id, id), read) : eq(monitorDefinitions.id, id))
    .limit(1);
  return row ?? null;
}

export async function createMonitorDefinition(
  input: CreateMonitorDefinitionInput,
  auth: AuthContext,
  options: CompileOptions = {},
  executor: DbExecutor = db,
): Promise<MonitorDefinitionRow> {
  const owner = resolveOwnerForCreate(input, auth);
  await assertEscalationPolicyCompatible(input.escalationPolicyId ?? null, owner, executor);
  const shape = validateDefinitionShape({
    kind: input.kind,
    condition: input.condition,
    responses: input.responses,
    recurrenceActions: input.recurrenceActions,
    aiAgentId: input.aiAgentId ?? null,
  });

  try {
    await assertNetworkCheckAssetOwner(input.kind, shape.condition, owner, executor);
  } catch (error) {
    if (error instanceof NetworkCheckAssetError) throw new MonitorValidationError(error.message);
    throw error;
  }

  return createValidatedMonitorInTx(input, auth, owner, shape, options, executor);
}

async function createValidatedMonitorInTx(
  input: CreateMonitorDefinitionInput, auth: AuthContext,
  owner: ReturnType<typeof resolveOwnerForCreate>, shape: ReturnType<typeof validateDefinitionShape>,
  options: CompileOptions, executor: DbExecutor,
): Promise<MonitorDefinitionRow> {
  return executor.transaction(async (tx) => {
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
        createdBy: auth.scope === 'system' ? null : auth.user.id,
      })
      .returning();
    if (!created) throw new Error('Failed to create monitor definition');

    const refs = await compileMonitorInTx(tx, created, options);
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
  executor: DbExecutor = db,
): Promise<MonitorDefinitionRow> {
  const existing = await getMonitorDefinition(id, auth, executor);
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
  try {
    await assertNetworkCheckAssetOwner(merged.kind, shape.condition, existing, executor);
  } catch (error) {
    if (error instanceof NetworkCheckAssetError) throw new MonitorValidationError(error.message);
    throw error;
  }

  const effectiveEscalationPolicyId =
    input.escalationPolicyId !== undefined
      ? (input.escalationPolicyId ?? null)
      : existing.escalationPolicyId;
  await assertEscalationPolicyCompatible(effectiveEscalationPolicyId, {
    orgId: existing.orgId,
    partnerId: existing.partnerId,
  }, executor);

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

  return executor.transaction(async (tx) => {
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

export async function deleteMonitorDefinition(id: string, auth: AuthContext, executor: DbExecutor = db): Promise<void> {
  const existing = await getMonitorDefinition(id, auth, executor);
  if (!existing) throw new MonitorNotFoundError(id);
  assertCanWrite(auth, { orgId: existing.orgId, partnerId: existing.partnerId });
  // The compiled template/rule/automation rows and every policy attachment go
  // with it through ON DELETE CASCADE; alerts keep their history with
  // monitor_id (and rule_id, once the cascade reaches the compiled rule) set
  // to NULL.
  try {
    await executor.transaction(async (tx) => {
      // Shared lock order: monitor_definitions → network_monitors → conversion
      // ledger rows. Keep delete aligned with PATCH/recompile and Revert.
      const [lockedDefinition] = await tx.select({ id: monitorDefinitions.id })
        .from(monitorDefinitions).where(eq(monitorDefinitions.id, id)).for('update');
      if (!lockedDefinition) throw new MonitorNotFoundError(id);
      const probes = await tx.select({ id: networkMonitors.id, orgId: networkMonitors.orgId })
        .from(networkMonitors).where(eq(networkMonitors.managedByMonitorId, id))
        .orderBy(asc(networkMonitors.id)).for('update');
      // A live conversion identifies an adopted probe. Release it before the
      // definition cascade so its results and legacy rules remain available.
      // Compiler-created probes have no source ledger entry and still cascade.
      const adopted = probes.length === 0 ? [] : await tx.select({
        id: monitorConversions.sourceId, conversionId: monitorConversions.id,
        sourceState: monitorConversions.sourceState,
      }).from(monitorConversions)
        .where(and(inArray(monitorConversions.sourceId, probes.map((probe) => probe.id)),
          inArray(monitorConversions.orgId, probes.flatMap((probe) => probe.orgId ? [probe.orgId] : [])),
          eq(monitorConversions.sourceTable, 'network_monitors'), isNull(monitorConversions.revertedAt)))
        .orderBy(asc(monitorConversions.id)).for('update');
      const now = new Date();
      for (const source of adopted) {
        await tx.update(networkMonitors).set({ managedByMonitorId: null, isActive: false,
          retiredAt: now, retiredReason: 'monitor_deleted', updatedAt: now })
          .where(and(eq(networkMonitors.id, source.id), eq(networkMonitors.managedByMonitorId, id)));
        await tx.update(monitorConversions).set({ sourceState: { ...source.sourceState, sourceReleased: true } })
          .where(eq(monitorConversions.id, source.conversionId));
      }
      await tx.delete(monitorDefinitions).where(eq(monitorDefinitions.id, id));
    });
  } catch (error) {
    if (isPgForeignKeyViolation(error)) {
      // Belt-and-braces catch-all (see MonitorHasDependentsError's doc
      // comment) — it maps ANY residual FK violation the cascade hits to the
      // same clean 409, which is deliberately the right client behavior but
      // would otherwise discard the one thing that tells an operator WHICH
      // constraint fired if it's ever something other than the known,
      // already-fixed alerts.rule_id case. Log the constraint name and keep
      // the original error as `cause` so Sentry/logs still have it.
      console.error(
        `[deleteMonitorDefinition] ${id} blocked by FK ${pgErrorConstraint(error) ?? '(unknown constraint)'}`,
        error,
      );
      throw new MonitorHasDependentsError(id, { cause: error });
    }
    throw error;
  }
}

/** Count of policy attachments per monitor, for the list view. */
export function attachmentCountSubquery() {
  return sql<number>`(SELECT count(*)::int FROM config_policy_monitors cpm WHERE cpm.monitor_id = ${monitorDefinitions.id})`;
}
