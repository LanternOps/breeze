import { createHash } from 'node:crypto';
import type { NetworkCheckMonitorCondition } from '@breeze/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { alertTemplates, alertRules } from '../../db/schema/alerts';
import { automations } from '../../db/schema/automations';
import { monitorDefinitions } from '../../db/schema/monitorDefinitions';
import { discoveredAssets } from '../../db/schema/discovery';
import { networkMonitors } from '../../db/schema/monitors';
import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';
import { getMonitorKindSpec } from './kinds';
import {
  replaceAutomationResourceBindings,
  resolveAutomationReferencesForOwner,
} from '../automationRuntime';
import type { AutomationAction } from '../automationRuntime';
import type { RootCondition } from '../alertConditions/types';

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
export type DbExecutor = typeof db | DbTx;
export interface CompileOptions {
  /** Adopt an unmanaged, same-org network row before updating it in place. */
  adoptNetworkMonitorId?: string;
}

export class NetworkMonitorAdoptionError extends Error {
  constructor(public readonly networkMonitorId: string) {
    super(`network_monitors row ${networkMonitorId} cannot be adopted: already managed, retired, or not owned by the definition's org`);
    this.name = 'NetworkMonitorAdoptionError';
  }
}

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

/**
 * The diagnostic script a `script` monitor probes with, expressed as a
 * `run_script` action purely so it joins the RESPONSE actions in the ownership
 * resolution below (#5291 W04).
 *
 * Before W04 the diagnostic script was bound by nothing: only response actions
 * went through `resolveAutomationReferencesForOwner`, so a PARTNER-WIDE monitor
 * could name an ORG-OWNED script and compile happily — and then fail at 3am
 * inside the dispatch worker, for every org except the one that owns the
 * script. Including it here turns that into an
 * `AutomationReferenceAuthorizationError` at AUTHORING time, surfaced as a 400
 * by the route. This is the mitigation the spec's §Risks bullet names.
 *
 * It is NOT added to the compiled automation's `actions`: the probe is
 * dispatched by monitorScriptWorker on its own interval, not by the automation
 * worker on alert.triggered. Only the ownership check is shared.
 */
export function buildDiagnosticScriptReferences(
  def: MonitorDefinitionRow,
): AutomationAction[] {
  if (def.kind !== 'script') return [];
  const scriptId = (def.condition as { scriptId?: unknown } | null)?.scriptId;
  if (typeof scriptId !== 'string' || scriptId.length === 0) return [];
  return [{ type: 'run_script', scriptId, whenOffline: 'queue' } as AutomationAction];
}

/** The condition the alertConditions registry will evaluate for this monitor. */
export function buildCompiledCondition(def: MonitorDefinitionRow): RootCondition {
  const spec = getMonitorKindSpec(def.kind);
  const condition = spec.conditionSchema.parse(def.condition);
  // W04: `script` and `network_check` read their evidence back through a row
  // stamped with the monitor's own id, so the compile context carries it.
  return spec.toAlertCondition(condition, { monitorId: def.id });
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
    category: spec.alertCategory ?? 'monitor',
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

function omitUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/** Agent payload names; headers and packetSize are preserved but currently ignored by the agent. */
export function buildCompiledNetworkMonitorConfig(c: NetworkCheckMonitorCondition): Record<string, unknown> {
  switch (c.checkType) {
    case 'icmp_ping':
      return omitUndefined({ count: c.count, packetSize: c.packetSize });
    case 'tcp_port':
      return omitUndefined({ port: c.port, expectBanner: c.expectBanner });
    case 'http_check':
      return omitUndefined({
        url: c.target,
        method: c.method,
        expectedStatus: c.expectStatus,
        expectedBody: c.expectedBody,
        headers: c.headers,
        // #6510: observe the redirect hop when expecting 3xx, unless explicitly overridden.
        followRedirects: c.followRedirects ?? (c.expectStatus != null && c.expectStatus >= 300 && c.expectStatus < 400 ? false : undefined),
        verifySsl: c.verifySsl,
      });
    case 'dns_check':
      return omitUndefined({ hostname: c.target, recordType: c.recordType, expectedValue: c.expectedValue, nameserver: c.nameserver });
  }
}

/** Pure authoring projection. The executor-backed site binding is resolved separately. */
export function buildCompiledNetworkMonitor(
  def: MonitorDefinitionRow,
): typeof networkMonitors.$inferInsert {
  const spec = getMonitorKindSpec(def.kind);
  const c = spec.conditionSchema.parse(def.condition) as NetworkCheckMonitorCondition;
  return {
    orgId: def.orgId,
    partnerId: def.partnerId,
    name: `[monitor] ${def.name}`,
    monitorType: c.checkType,
    target: c.target,
    assetId: c.assetId ?? null,
    config: buildCompiledNetworkMonitorConfig(c),
    pollingInterval: c.pollingIntervalSeconds,
    timeout: c.timeoutSeconds,
    isActive: def.enabled,
    managedByMonitorId: def.id,
  };
}

async function buildCompiledNetworkMonitorWithSite(def: MonitorDefinitionRow, executor: DbExecutor) {
  const row = buildCompiledNetworkMonitor(def);
  if (!row.assetId) return { ...row, siteId: null };
  if (!def.orgId) throw new Error('Asset-bound network checks require an organization owner');
  const [asset] = await executor.select({ siteId: discoveredAssets.siteId })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.id, row.assetId), eq(discoveredAssets.orgId, def.orgId)))
    .limit(1);
  if (!asset) throw new Error('Network check asset not found in the monitor organization');
  return { ...row, siteId: asset.siteId };
}

async function upsertManaged<T extends { id: string }>(
  tx: DbTx,
  table: typeof alertTemplates | typeof alertRules | typeof automations | typeof networkMonitors,
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
  options: CompileOptions = {},
): Promise<CompiledRefs> {
  const now = new Date();

  const template = buildCompiledTemplate(def);
  const t = await upsertManaged(tx, alertTemplates, def.id, { ...template, updatedAt: now });

  const rule = buildCompiledRule(def, t.id);
  const r = await upsertManaged(tx, alertRules, def.id, rule);

  const automation = buildCompiledAutomation(def, r.id);
  const a = await upsertManaged(tx, automations, def.id, { ...automation, updatedAt: now });

  // A `network_check` compiles to a FOURTH managed row. Idempotent through the
  // same read-then-write upsert, keyed on the partial unique index over
  // `managed_by_monitor_id`, so a recompile keeps the row id and therefore its
  // whole result history.
  if (def.kind === 'network_check') {
    // Stamp ownership first so the upsert preserves the legacy row and history.
    // Failure to acquire it must never fall through to a fresh insert.
    if (options.adoptNetworkMonitorId) {
      const [adopted] = await tx
        .update(networkMonitors)
        .set({ managedByMonitorId: def.id })
        .where(and(
          eq(networkMonitors.id, options.adoptNetworkMonitorId),
          isNull(networkMonitors.managedByMonitorId),
          isNull(networkMonitors.retiredAt),
          def.orgId ? eq(networkMonitors.orgId, def.orgId) : sql`false`,
        ))
        .returning({ id: networkMonitors.id });
      if (!adopted) throw new NetworkMonitorAdoptionError(options.adoptNetworkMonitorId);
    }
    await upsertManaged(tx, networkMonitors, def.id, {
      ...await buildCompiledNetworkMonitorWithSite(def, tx),
      updatedAt: now,
    });
  }

  // Resource bindings are the durable ownership snapshot the automation worker
  // re-checks at admission time. Without them a compiled automation's
  // run_script action would be refused at execution with no explanation.
  const owner = { orgId: def.orgId, partnerId: def.partnerId };
  const resolved = await resolveAutomationReferencesForOwner(
    tx,
    owner,
    [
      ...(automation.actions as AutomationAction[]),
      ...buildDiagnosticScriptReferences(def),
    ],
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

  // The fourth managed row (#5291 W04). Same key-by-key comparison, so a hand
  // edit to the managed check's target shows up as drift here rather than as a
  // probe quietly aimed somewhere else.
  if (def.kind === 'network_check') {
    const [check] = await executor
      .select()
      .from(networkMonitors)
      .where(eq(networkMonitors.managedByMonitorId, def.id))
      .limit(1);
    if (!check) {
      diff.push('network_monitors: missing');
    } else {
      const expectedCheck = await buildCompiledNetworkMonitorWithSite(def, executor);
      for (const key of Object.keys(expectedCheck) as Array<keyof typeof expectedCheck>) {
        const expected = canonical(expectedCheck[key]);
        const actual = canonical((check as Record<string, unknown>)[key as string]);
        if (expected !== actual) diff.push(`network_monitors.${String(key)}: ${actual} !== ${expected}`);
      }
    }
  }

  if (def.compiledHash !== computeCompiledHash(def)) diff.push('monitor_definitions.compiled_hash');

  return { inSync: diff.length === 0, diff };
}
