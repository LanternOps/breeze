import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { alertTemplates, alertRules } from '../../db/schema/alerts';
import { automations } from '../../db/schema/automations';
import { monitorDefinitions } from '../../db/schema/monitorDefinitions';
import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';
import { getMonitorKindSpec } from './kinds';
import {
  replaceAutomationResourceBindings,
  resolveAutomationReferencesForOwner,
} from '../automationRuntime';
import type { AutomationAction } from '../automationRuntime';
import type { AlertCondition } from '../alertConditions/types';

/**
 * The monitor COMPILER (#5287 W02).
 *
 * A monitor definition is what a technician authors; the sweep, the
 * notification dispatcher and the automation worker keep executing exactly the
 * rows they already understand. This module is the ONLY writer of those rows:
 * every other writer (routes, AI tools) refuses a row carrying
 * `managed_by_monitor_id` with a 409, so a managed row can never drift away
 * from its definition by a side edit.
 *
 * The three builders are pure so the same code can (a) write the rows and
 * (b) re-derive them for `verifyCompiled`, which is what proves a stored row
 * still matches its definition without re-running a compile.
 */

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExecutor = typeof db | DbTx;

export interface CompiledRefs {
  alertTemplateId: string;
  alertRuleId: string;
  automationId: string;
  hash: string;
}

/**
 * Everything that changes what the compiled rows look like. Deliberately
 * EXCLUDES `compiled_*`, `created_*` and `updated_at`: the compile itself
 * writes those, so including them would make every hash differ from the hash
 * computed one statement earlier and defeat the whole point.
 */
const COMPILE_FIELDS = [
  'orgId',
  'partnerId',
  'name',
  'description',
  'kind',
  'enabled',
  'condition',
  'severity',
  'cooldownMinutes',
  'autoResolve',
  'autoResolveConditions',
  'responses',
  'deliveryMode',
  'deliveryChannelIds',
  'escalationPolicyId',
  'recurrenceThreshold',
  'recurrenceWindowHours',
  'recurrenceActions',
  'pauseResponsesOnEscalation',
  'aiAgentId',
] as const satisfies readonly (keyof MonitorDefinitionRow)[];

/**
 * Key-sorted JSON. `JSON.stringify` preserves insertion order, so two
 * semantically identical conditions authored in different field orders would
 * otherwise hash differently and look permanently out of sync.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function computeCompiledHash(def: MonitorDefinitionRow): string {
  const picked: Record<string, unknown> = {};
  for (const field of COMPILE_FIELDS) picked[field] = def[field];
  return createHash('sha256').update(canonical(picked)).digest('hex');
}

/** The condition the alertConditions registry will evaluate for this monitor. */
export function buildCompiledCondition(def: MonitorDefinitionRow): AlertCondition {
  const spec = getMonitorKindSpec(def.kind);
  const condition = spec.conditionSchema.parse(def.condition);
  return spec.toAlertCondition(condition);
}

export function buildCompiledTemplate(
  def: MonitorDefinitionRow,
): typeof alertTemplates.$inferInsert {
  const spec = getMonitorKindSpec(def.kind);
  return {
    orgId: def.orgId,
    partnerId: def.partnerId,
    name: `[monitor] ${def.name}`,
    description: def.description,
    category: 'monitor',
    // A SINGLE root condition object, never an array: `validateConditions`
    // accepts both, but the sweep's override path replaces this wholesale from
    // the kind spec, which only ever produces one root node.
    conditions: buildCompiledCondition(def),
    severity: def.severity,
    titleTemplate: spec.titleTemplate,
    messageTemplate: spec.messageTemplate,
    targets: null,
    autoResolve: def.autoResolve,
    autoResolveConditions: def.autoResolveConditions ?? null,
    cooldownMinutes: def.cooldownMinutes,
    isBuiltIn: true,
    managedByMonitorId: def.id,
  };
}

export function buildCompiledRule(
  def: MonitorDefinitionRow,
  templateId: string,
): typeof alertRules.$inferInsert {
  return {
    orgId: def.orgId,
    partnerId: def.partnerId,
    templateId,
    name: def.name,
    // The 'monitor' target type is resolved by resolveMonitorsForDevice: a
    // device gets the rule only when a policy assigned to it attaches the
    // monitor. targetId is NOT NULL, so it carries the definition id.
    targetType: 'monitor',
    targetId: def.id,
    overrideSettings: {
      // 'none' and 'inherit' both compile to an EMPTY list, but they differ
      // downstream: the dispatcher falls back to routing rules / org channels
      // when the list is empty, and W03 carries the mode through so 'none' can
      // suppress that fallback. Storing the mode keeps the intent recoverable.
      notificationChannelIds: def.deliveryMode === 'channels' ? def.deliveryChannelIds : [],
      escalationPolicyId: def.escalationPolicyId ?? null,
      deliveryMode: def.deliveryMode,
    },
    isActive: def.enabled,
    managedByMonitorId: def.id,
  };
}

export function buildCompiledAutomation(
  def: MonitorDefinitionRow,
  ruleId: string,
): typeof automations.$inferInsert {
  const responses = (def.responses ?? []) as AutomationAction[];
  return {
    orgId: def.orgId,
    partnerId: def.partnerId,
    name: `[monitor] ${def.name}`,
    description: def.description,
    // An automation with no responses would be a permanently no-op row that
    // still costs a worker dispatch on every alert.
    enabled: def.enabled && responses.length > 0,
    // `filter.ruleId` is what keeps this automation from firing on EVERY
    // alert.triggered event in the tenant — normalizeAutomationTrigger already
    // passes `filter` through, so the runtime narrows on it unchanged.
    trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId } },
    conditions: null,
    actions: responses,
    onFailure: 'stop',
    notificationTargets: null,
    // ai_triage resolves its agent through this column (#3824), which is why a
    // definition carrying an ai_triage response must set aiAgentId.
    managedByAgentId: def.aiAgentId ?? null,
    managedByMonitorId: def.id,
  };
}

async function upsertManaged<T extends { id: string }>(
  tx: DbTx,
  table: typeof alertTemplates | typeof alertRules | typeof automations,
  monitorId: string,
  values: Record<string, unknown>,
): Promise<T> {
  // Read-then-write rather than onConflictDoUpdate: the uniqueness is a
  // PARTIAL unique index (managed_by_monitor_id IS NOT NULL), and expressing
  // that as a conflict target is version-dependent in Drizzle. Both statements
  // run inside the caller's transaction, so the pair is still atomic.
  const anyTable = table as unknown as typeof alertRules;
  const [existing] = await tx
    .select({ id: anyTable.id })
    .from(anyTable)
    .where(eq(anyTable.managedByMonitorId, monitorId))
    .limit(1);

  if (existing) {
    const [updated] = await tx
      .update(anyTable)
      .set(values as never)
      .where(eq(anyTable.id, existing.id))
      .returning({ id: anyTable.id });
    return updated as T;
  }

  const [created] = await tx
    .insert(anyTable)
    .values(values as never)
    .returning({ id: anyTable.id });
  return created as T;
}

/**
 * Compile one definition into its three managed rows, inside the caller's
 * transaction. Idempotent: re-running keeps the same three row ids so alert
 * history and automation runs stay attached across every edit.
 */
export async function compileMonitorInTx(
  tx: DbTx,
  def: MonitorDefinitionRow,
): Promise<CompiledRefs> {
  const now = new Date();

  const template = buildCompiledTemplate(def);
  const t = await upsertManaged(tx, alertTemplates, def.id, { ...template, updatedAt: now });

  const rule = buildCompiledRule(def, t.id);
  const r = await upsertManaged(tx, alertRules, def.id, rule);

  const automation = buildCompiledAutomation(def, r.id);
  const a = await upsertManaged(tx, automations, def.id, { ...automation, updatedAt: now });

  // Resource bindings are the durable ownership snapshot the automation worker
  // re-checks at admission time. Without them a compiled automation's
  // run_script action would be refused at execution with no explanation.
  const owner = { orgId: def.orgId, partnerId: def.partnerId };
  const resolved = await resolveAutomationReferencesForOwner(
    tx,
    owner,
    automation.actions as AutomationAction[],
  );
  await replaceAutomationResourceBindings(tx, a.id, owner, resolved);

  const hash = computeCompiledHash(def);
  await tx
    .update(monitorDefinitions)
    .set({
      compiledAlertTemplateId: t.id,
      compiledAlertRuleId: r.id,
      compiledAutomationId: a.id,
      compiledHash: hash,
      compiledAt: now,
      updatedAt: now,
    })
    .where(eq(monitorDefinitions.id, def.id));

  return { alertTemplateId: t.id, alertRuleId: r.id, automationId: a.id, hash };
}

export interface CompiledVerification {
  inSync: boolean;
  diff: string[];
}

/**
 * Re-derive the three rows from the definition and compare them to what is
 * stored. Used by the integration contract test now and by W03's reconcile
 * job; a drift here means something wrote a managed row behind the compiler.
 */
export async function verifyCompiled(
  def: MonitorDefinitionRow,
  executor: DbExecutor = db,
): Promise<CompiledVerification> {
  const diff: string[] = [];

  const [template] = await executor
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.managedByMonitorId, def.id))
    .limit(1);
  const [rule] = await executor
    .select()
    .from(alertRules)
    .where(eq(alertRules.managedByMonitorId, def.id))
    .limit(1);
  const [automation] = await executor
    .select()
    .from(automations)
    .where(eq(automations.managedByMonitorId, def.id))
    .limit(1);

  if (!template) diff.push('alert_templates: missing');
  if (!rule) diff.push('alert_rules: missing');
  if (!automation) diff.push('automations: missing');
  if (!template || !rule || !automation) return { inSync: false, diff };

  const expectedTemplate = buildCompiledTemplate(def);
  for (const key of Object.keys(expectedTemplate) as Array<keyof typeof expectedTemplate>) {
    const expected = canonical(expectedTemplate[key]);
    const actual = canonical((template as Record<string, unknown>)[key as string]);
    if (expected !== actual) diff.push(`alert_templates.${String(key)}: ${actual} !== ${expected}`);
  }

  const expectedRule = buildCompiledRule(def, template.id);
  for (const key of Object.keys(expectedRule) as Array<keyof typeof expectedRule>) {
    const expected = canonical(expectedRule[key]);
    const actual = canonical((rule as Record<string, unknown>)[key as string]);
    if (expected !== actual) diff.push(`alert_rules.${String(key)}: ${actual} !== ${expected}`);
  }

  const expectedAutomation = buildCompiledAutomation(def, rule.id);
  for (const key of Object.keys(expectedAutomation) as Array<keyof typeof expectedAutomation>) {
    const expected = canonical(expectedAutomation[key]);
    const actual = canonical((automation as Record<string, unknown>)[key as string]);
    if (expected !== actual) diff.push(`automations.${String(key)}: ${actual} !== ${expected}`);
  }

  if (def.compiledHash !== computeCompiledHash(def)) diff.push('monitor_definitions.compiled_hash');

  return { inSync: diff.length === 0, diff };
}
