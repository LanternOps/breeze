/**
 * Fleet Design → monitors (W05c2 Task 16, #6371).
 *
 * Apply writes each approved watch / rule proposal as a monitor definition on
 * the SAME ownership axis as the target policy (org-owned policy → org monitor,
 * partner-wide policy → partner monitor), through `createMonitorDefinition`
 * (validation, compilation, escalation-owner checks), and attaches it via the
 * policy's single inline `monitors` feature link. It never writes an
 * `alert_rule` or watch-bearing `monitoring` link and never inserts into
 * `monitor_definitions` / `config_policy_monitors` directly.
 *
 * Every call takes the caller's step transaction (a SAVEPOINT on the request's
 * ambient transaction), so a failure rolls back the definitions, their compiled
 * rows, the attachment and the step's ledger rows together.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  createMonitorDefinitionSchema,
  monitorsInlineSettingsSchema,
  type FleetDesignRule,
  type FleetDesignWatch,
} from '@breeze/shared';
import { db } from '../../db';
import { configurationPolicies, monitorDefinitions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { addFeatureLink, listFeatureLinks, policyAccessCondition, updateFeatureLink } from '../configurationPolicy';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { createMonitorDefinition } from '../monitors/monitorService';
import { getMonitorKindSpec } from '../monitors/kinds';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A design watch as a monitor. Restart intent maps to W05c1's agent-local
 * restart response (`command: ''` + `kind: 'restart_service'`), which the
 * compiler delivers as `auto_restart` on the agent watch. `alertOnStop` is not
 * mapped: W05c1 established it was never read by the agent or the sweep.
 */
export function watchMonitorInput(watch: FleetDesignWatch): Record<string, unknown> {
  return {
    name: watch.name,
    kind: watch.watchType,
    description: watch.rationale,
    condition: { [watch.watchType === 'service' ? 'serviceName' : 'processName']: watch.name, consecutiveFailures: 2 },
    severity: getMonitorKindSpec(watch.watchType).defaultSeverity,
    autoResolve: false,
    deliveryMode: 'inherit',
    responses: watch.autoRestart
      ? [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 3, cooldownSeconds: 300, whenOffline: 'queue' }]
      : [],
  };
}

/** A design rule proposal as a monitor. `description` carries the rationale (+ action/paging notes). */
export function ruleMonitorInput(rule: FleetDesignRule, description: string): Record<string, unknown> {
  return {
    name: rule.name,
    kind: rule.kind,
    condition: rule.condition,
    severity: rule.severity,
    cooldownMinutes: rule.cooldownMinutes,
    responses: rule.responses,
    deliveryMode: rule.deliveryMode,
    deliveryChannelIds: rule.deliveryChannelIds,
    description,
  };
}

/**
 * Create one monitor per proposal and append them to the policy's `monitors`
 * link (created cumulative if absent; an existing link keeps its items and its
 * inheritance mode, including `replace`). Returns itemRef → monitor id.
 *
 * Partner-wide policies are gated on `canManagePartnerWidePolicies` before any
 * write, exactly as the legacy link writers were; the monitor service
 * re-checks the same capability for the partner-owned definition.
 */
export async function attachFleetMonitors(
  policyId: string,
  proposals: Array<{ itemRef: string; definition: Record<string, unknown> }>,
  auth: AuthContext,
  tx: Tx,
): Promise<Record<string, string>> {
  if (proposals.length === 0) return {};
  const access = policyAccessCondition(auth);
  const [policy] = await tx
    .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId })
    .from(configurationPolicies)
    .where(access ? and(eq(configurationPolicies.id, policyId), access) : eq(configurationPolicies.id, policyId))
    .limit(1);
  if (!policy) throw new Error('policy_missing');
  const partnerWide = policy.orgId === null;
  if (partnerWide && !canManagePartnerWidePolicies(auth)) throw new Error('partner_wide_write_denied');
  if (partnerWide && policy.partnerId !== auth.partnerId) throw new Error('partner_axis_mismatch');

  // Validate every proposal before the first write, so a bad one fails the
  // step without relying on the savepoint to undo earlier creates.
  const inputs = proposals.map((proposal) => ({
    itemRef: proposal.itemRef,
    input: createMonitorDefinitionSchema.parse({
      ...proposal.definition,
      ownerScope: partnerWide ? 'partner' : 'organization',
      ...(partnerWide ? {} : { orgId: policy.orgId }),
    }),
  }));

  const links = await listFeatureLinks(policyId, tx);
  const link = links.find((value) => value.featureType === 'monitors' && !value.featurePolicyId);
  const settings = monitorsInlineSettingsSchema.parse(link?.inlineSettings ?? { items: [] });

  const ids: Record<string, string> = {};
  for (const { itemRef, input } of inputs) {
    const monitor = await createMonitorDefinition(input, auth, {}, tx);
    ids[itemRef] = monitor.id;
    settings.items.push({ monitorId: monitor.id, enabled: true, sortOrder: settings.items.length });
  }

  const saved = link
    ? await updateFeatureLink(link.id, { inlineSettings: settings }, policyId, undefined, tx)
    : await addFeatureLink(policyId, 'monitors', null, settings, undefined, tx);
  if (!saved) throw new Error(`monitor_link_missing: ${policyId}`);
  return ids;
}

/**
 * Author-controlled fields of a definition — the rollback "unmodified since
 * apply" comparison. Compiler-owned columns (compiled ids/hash, timestamps)
 * are excluded so a recompile is not mistaken for a technician's edit.
 */
const SNAPSHOT_FIELDS = [
  'name', 'description', 'kind', 'enabled', 'condition', 'severity', 'cooldownMinutes', 'autoResolve',
  'autoResolveConditions', 'responses', 'deliveryMode', 'deliveryChannelIds', 'escalationPolicyId',
  'recurrenceThreshold', 'recurrenceWindowHours', 'recurrenceActions', 'pauseResponsesOnEscalation', 'aiAgentId',
  'orgId', 'partnerId',
] as const;

export async function snapshotFleetMonitors(
  ids: string[],
  executor: typeof db | Tx = db,
): Promise<Record<string, Record<string, unknown>>> {
  if (ids.length === 0) return {};
  const rows = await executor.select().from(monitorDefinitions).where(inArray(monitorDefinitions.id, ids));
  return Object.fromEntries(rows.map((row) => {
    const source = row as unknown as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const field of SNAPSHOT_FIELDS) if (field in source) picked[field] = source[field];
    return [row.id, JSON.parse(JSON.stringify(picked))];
  }));
}
