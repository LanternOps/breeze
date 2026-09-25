import { and, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withDbAccessContext } from '../../../db';
import { escalationPolicies, organizations, partners, sites, deviceGroups, devices, deviceGroupMemberships, notificationRoutingRules, notificationChannels, configPolicyAssignments, alerts, alertRules, alertTemplates, automations, configPolicyAlertRules, configPolicyAutomations, configPolicyFeatureLinks, configPolicyMonitoringSettings, configPolicyMonitoringWatches, configPolicyMonitors, configurationPolicies, monitorConversions, monitorConversionOutputs, monitorDefinitions } from '../../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../../middleware/auth';
import { getMonitorConversionPreviewQueue, previewJobKey } from '../../../jobs/monitorConversionPreviewWorker';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { compileMonitorInTx } from '../monitorCompiler';
import { createMonitorDefinition, deleteMonitorDefinition } from '../monitorService';
import { rekeyConfigPolicyCooldowns, rekeyCooldownsBackToConfigPolicy, rekeyRuleCooldowns } from '../../alertCooldown';
import { captureException } from '../../sentry';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { restoreMovedAlertRefs, carryOpenAlerts, canDeleteConversionMonitor } from './history';
import { isRevertAvailable, findLiveTargetDependencies } from './lifecycle';
import { createConfigPolicy, assignPolicy, addFeatureLink } from '../../configurationPolicy';
import { assignmentForRule } from '../ruleConversionService';
import { resolveDelivery } from '../../delivery/resolveDelivery';
import { getRedis } from '../../redis';
import { computeEquivalence, applyProposalInTx, type EquivalenceProposal, signatureMapForLegacy, signatureMapForMonitors, diffSignatureSets } from './equivalence';
import { resolveDeviceIdsForPolicy, resolveLegacyBaseline, type DbExecutor } from './legacyBaseline';
import { loadPolicySources, type PolicySources } from './loadSources';
import { canonical, mapStandaloneRule, monitorSignature, mapAutomationResponses, mapInlineRule, mapWatch, mergeResponseProposals, previewHash, sha, type MappingResult } from './mapping';
import { authorizePreview, previewFreshness, previewScopeHash, snapshotPreviewAccess } from './previewScope';
import { missingConversionPrerequisites } from './prerequisites';
import { EQUIVALENCE_JOB_THRESHOLD, type ConversionPreviewItem, type PolicyConversionPreview, type PolicyConversionPreviewPending, type PolicyConversionPreviewFailed, type ConversionSourceTable, type PartnerConversionPreview } from './types';

export class ConversionError extends Error {
  constructor(readonly code: 'policy_not_found' | 'partner_wide_denied' | 'prerequisite_missing' | 'blocked' | 'preview_stale' | 'equivalence_delta' | 'source_not_found' | 'already_converted' | 'invalid_reason' | 'conversion_not_found' | 'conversion_revert_unavailable', message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ConversionError';
  }
}

async function compatibleEscalation(id: string, owner: PolicySources['policy'], executor: DbExecutor): Promise<boolean> {
  const [policy] = await executor.select().from(escalationPolicies).where(eq(escalationPolicies.id, id)).limit(1);
  if (!policy) return false;
  if (!owner.orgId) return policy.orgId === null && policy.partnerId === owner.partnerId;
  if (policy.orgId === owner.orgId) return true;
  if (policy.orgId !== null) return false;
  const [org] = await executor.select().from(organizations).where(eq(organizations.id, owner.orgId)).limit(1);
  return !!org?.partnerId && org.partnerId === policy.partnerId;
}

type PreviewOptions = { expectedFreshness?: string; onProgress?: (checked: number, total: number) => Promise<void> | void; };
export async function buildPolicyConversionPreview(policyId: string, ctx: { userId: string | null; auth: AuthContext; }, opts?: PreviewOptions): Promise<PolicyConversionPreview> {
  const snapshot = snapshotPreviewAccess(ctx.auth);
  return withDbAccessContext(snapshot.dbContext, async () => {
    await authorizePreview(policyId, ctx.auth);
    return db.transaction(tx => buildPolicyPreviewInTx(policyId, ctx.auth, tx, opts));
  }, { isolationLevel: 'repeatable read' });
}

async function buildPolicyPreviewInTx(policyId: string, auth: AuthContext, tx: DbExecutor, opts?: PreviewOptions): Promise<PolicyConversionPreview> {
  const scopeHash = previewScopeHash(snapshotPreviewAccess(auth));
  const sources = await loadPolicySources(policyId, tx);
  if (!sources) throw new ConversionError('policy_not_found', 'Policy not found');
  const freshness = await previewFreshness(policyId, tx);
  if (opts?.expectedFreshness !== undefined && opts.expectedFreshness !== freshness) {
    throw new ConversionError('preview_stale', 'Preview inputs changed');
  }
  const inheritanceMode = 'replace' as const;
  const missing = missingConversionPrerequisites();
  const blockedBy = missing.length ? 'prerequisite_missing' as const : sources.parentUnconverted ? 'parent_unconverted' as const : undefined;
  const items: ConversionPreviewItem[] = [];
  const append = (sourceTable: ConversionPreviewItem['sourceTable'], row: { id: string; name: string; }, mapped: MappingResult) => {
    items.push({
      sourceTable, sourceId: row.id, name: row.name, outcome: mapped.ok ? 'convertible' : 'unconvertible',
      ...(!mapped.ok ? { reason: mapped.reason } : {}), proposed: mapped.ok ? mapped.proposed : [], notes: mapped.notes,
      openAlerts: sources.openAlertsBySource.get(row.id) ?? 0
    });
  };
  if (!blockedBy) {
    for (const row of sources.inlineRules) append('config_policy_alert_rules', row, mapInlineRule(row));
    for (const row of sources.watches) append('config_policy_monitoring_watches', row, mapWatch(row));
    for (const row of sources.policyAutomations) items.push({
      sourceTable: 'config_policy_automations', sourceId: row.id,
      name: row.name, outcome: 'convertible', proposed: [], notes: [], openAlerts: 0,
      workflow: { policyId, sourceId: row.id, name: row.name, enabled: row.enabled, actions: Array.isArray(row.actions) ? row.actions : [], onFailure: row.onFailure }
    });
    for (const row of [...sources.standaloneAutomations].sort((a, b) => a.id.localeCompare(b.id))) {
      const target = (row.trigger as { filter?: { configPolicyAlertRuleId?: string; }; }).filter?.configPolicyAlertRuleId;
      const mapped = mapAutomationResponses(row);
      items.push({
        sourceTable: 'automations', sourceId: row.id, name: row.name,
        outcome: row.enabled && target ? 'convertible' : 'unconvertible', proposed: [], notes: mapped.notes, openAlerts: 0,
        ...(row.enabled && target ? { responseTargetSourceId: target, responseActions: mapped.actions }
          : { reason: row.enabled ? 'unconvertible:target_unconvertible' : 'unconvertible:disabled_response_automation' })
      });
    }
    for (const item of items) for (const monitor of item.proposed) {
      if (monitor.escalationPolicyId && !await compatibleEscalation(monitor.escalationPolicyId, sources.policy, tx)) {
        item.outcome = 'unconvertible'; item.reason = 'unconvertible:escalation_policy_axis'; item.proposed = []; break;
      }
    }
  }
  const merged = mergeResponseProposals(items);
  const ids = blockedBy ? [] : await resolveDeviceIdsForPolicy(policyId, tx);
  const equivalence = blockedBy ? { devicesChecked: 0, deltas: [] } : await computeEquivalence({
    policy: sources.policy, inheritanceMode,
    bySource: merged.filter((item) => item.outcome === 'convertible').map((item) => ({
      sourceTable: item.sourceTable, sourceId: item.sourceId,
      monitors: item.proposed, workflow: item.workflow, responseTargetSourceId: item.responseTargetSourceId
    })),
  }, ids, auth, opts?.onProgress, tx);
  // Staging must leave the snapshot unchanged after its rollback.
  if (await previewFreshness(policyId, tx) !== freshness) throw new ConversionError('preview_stale', 'Preview inputs changed');
  return {
    policyId, items: merged, inheritanceMode, equivalence,
    previewHash: sha(canonical({ proposal: previewHash({ policyId, items: merged, inheritanceMode }), scopeHash, freshness })),
    ...(blockedBy ? { blockedBy } : {}), ...(missing.length ? { missingPrerequisites: missing } : {})
  };
}

/**
 * Run pre-transaction reads under the caller's own DB context. The conversion
 * routes are self-managed (D30) so nothing is ambient, and a contextless read
 * is denied by RLS rather than bypassing it. Deliberately not
 * `withAuthDbAccessContext` (`middleware/auth.ts`): that canonical helper calls
 * `runOutsideDbContext` first, which would open a *second* pooled connection
 * under an ambient context — the #1105 shape this route must avoid. Reuses
 * rather than nests when a caller (a test) already holds a context — that
 * branch defers the throw rather than making the call work under an ambient
 * context; no production worker takes it.
 */
async function withCallerContext<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()) return fn();
  return withDbAccessContext(dbAccessContextFromAuth(auth), fn);
}

export async function previewPolicyConversion(policyId: string, auth: AuthContext, opts?: { mode?: 'auto' | 'inline'; }): Promise<PolicyConversionPreview | PolicyConversionPreviewPending | PolicyConversionPreviewFailed> {
  // These reads happen BEFORE the isolated preview transaction, and this route
  // is self-managed (D30), so there is no ambient context to inherit — a
  // contextless read is DENIED, not bypassed. Take a short caller-scoped
  // transaction for them and let it close before the isolated one opens.
  const ids = await withCallerContext(auth, async () => {
    await authorizePreview(policyId, auth);
    return resolveDeviceIdsForPolicy(policyId, db);
  });
  if (opts?.mode === 'inline' || ids.length <= EQUIVALENCE_JOB_THRESHOLD) {
    return buildPolicyConversionPreview(policyId, { userId: auth.scope === 'system' ? null : auth.user.id, auth });
  }
  // Only the queued path needs sourcesHash (the job/cache key), and it is not
  // cheap: previewFreshness does a loadPolicySources per sibling policy on the
  // axis plus device/org/routing/channel/escalation/policy/assignment reads.
  // Keep it out of the inline path above, which would otherwise pay for it and
  // throw it away.
  const sourcesHash = await withCallerContext(auth, () => previewFreshness(policyId, db));
  const snapshot = snapshotPreviewAccess(auth);
  const scopeHash = previewScopeHash(snapshot);
  const key = previewJobKey(policyId, scopeHash, sourcesHash);
  const redis = getRedis();
  if (!redis) throw new Error('Preview requires Redis');
  const raw = await redis.get(key);
  if (raw) {
    try {
      const cached = JSON.parse(raw) as { status?: string; scopeHash?: string; sourcesHash?: string; result?: PolicyConversionPreview; progress?: { checked: number; total: number; }; attempts?: number; };
      if (cached.scopeHash === scopeHash && cached.sourcesHash === sourcesHash) {
        if (cached.status === 'done' && cached.result) return cached.result;
        if (cached.status === 'running' && cached.progress) return { status: 'running', progress: cached.progress };
        // A failed entry is retried — a preview failure is usually transient —
        // but only MAX_PREVIEW_ATTEMPTS times. Past that the caller is told it
        // failed instead of polling `running` for ever against a job that
        // cannot succeed for these inputs.
        if (cached.status === 'failed' && (cached.attempts ?? 1) >= MAX_PREVIEW_ATTEMPTS) {
          return { status: 'failed', error: 'preview_failed' };
        }
      }
    } catch { /* A malformed cache entry is recomputed from authorized current inputs. */ }
  }
  await getMonitorConversionPreviewQueue().add('preview', { policyId, snapshot, scopeHash, sourcesHash },
    { jobId: sha(key), removeOnComplete: true, removeOnFail: true });
  return { status: 'running', progress: { checked: 0, total: ids.length } };
}

type Owner = { orgId: string | null; partnerId: string | null; };
/** Background preview attempts for one (policy, scope, sources) before the caller is told it failed. */
const MAX_PREVIEW_ATTEMPTS = 3;
const actor = (auth: AuthContext) => auth.scope === 'system' ? null : auth.user.id;
function assertOwner(owner: Owner, auth: AuthContext) {
  if (!canMutateOrgWideGovernance(auth)) throw new ConversionError('partner_wide_denied', 'Full governance scope required');
  if (owner.orgId) {
    if (!auth.canAccessOrg(owner.orgId)) throw new ConversionError('source_not_found', 'Source not found');
  } else if (!owner.partnerId || !canManagePartnerWidePolicies(auth)
    || (auth.scope !== 'system' && auth.partnerId !== owner.partnerId)) {
    throw new ConversionError('partner_wide_denied', 'Full partner access required');
  }
}
async function inCallerTransaction<T>(auth: AuthContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  const snapshot = snapshotPreviewAccess(auth);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await withDbAccessContext(snapshot.dbContext, () => db.transaction(fn), { isolationLevel: 'serializable' });
    } catch (error) {
      // Retry only after the entire transaction has aborted, never inside a
      // poisoned request transaction. The callback reloads visibility and hashes.
      // 40001 = serialization_failure. pgErrorCode unwraps Drizzle's .cause.
      if (pgErrorCode(error) !== '40001') throw error;
      if (attempt === 1) throw new ConversionError('preview_stale', 'Conversion inputs changed concurrently');
    }
  }
  throw new ConversionError('preview_stale', 'Conversion inputs changed concurrently');
}
async function lockConversion(tx: DbExecutor, owner: Owner) {
  let partnerId = owner.partnerId;
  if (owner.orgId) {
    const [org] = await tx.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, owner.orgId)).limit(1);
    if (!org) throw new ConversionError('source_not_found', 'Owner not found');
    partnerId = org.partnerId;
  }
  // All policy, template, retirement and revert operations in a partner use the same lock.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`monitor-conversion:${partnerId ?? owner.orgId}`}, 0))`);
}
function assertPreview(preview: PolicyConversionPreview, expectedHash?: string) {
  if (expectedHash !== undefined && preview.previewHash !== expectedHash) throw new ConversionError('preview_stale', 'Preview inputs changed');
  if (preview.blockedBy) throw new ConversionError(preview.blockedBy === 'prerequisite_missing' ? 'prerequisite_missing' : 'blocked', preview.blockedBy);
  if (preview.equivalence.deltas.length) throw new ConversionError('equivalence_delta', 'Conversion changes effective behavior', preview.equivalence.deltas);
}
function proposalFrom(preview: PolicyConversionPreview, policy: PolicySources['policy'], sourceIds?: string[]): EquivalenceProposal {
  const selected = sourceIds ? new Set(sourceIds) : new Set(preview.items.filter(i => i.outcome === 'convertible').map(i => i.sourceId));
  for (const id of selected) {
    const item = preview.items.find(i => i.sourceId === id);
    if (!item) throw new ConversionError('source_not_found', 'Source not found');
    if (item.outcome !== 'convertible') throw new ConversionError('blocked', 'Selected source is unconvertible');
  }
  for (const item of preview.items) if (item.outcome === 'convertible' && item.responseTargetSourceId
    && selected.has(item.sourceId) !== selected.has(item.responseTargetSourceId)) {
    throw new ConversionError('blocked', 'Select the target and all dependent responses together');
  }
  return {
    policy, previewHash: preview.previewHash, inheritanceMode: preview.inheritanceMode,
    bySource: preview.items.filter(i => selected.has(i.sourceId)).map(i => ({
      sourceTable: i.sourceTable, sourceId: i.sourceId,
      monitors: i.proposed, workflow: i.workflow, responseTargetSourceId: i.responseTargetSourceId
    }))
  };
}
async function lockPolicyInputs(tx: DbExecutor, policyId: string, auth: AuthContext) {
  const [policy] = await tx.select().from(configurationPolicies).where(eq(configurationPolicies.id, policyId)).limit(1).for('update');
  if (!policy) throw new ConversionError('policy_not_found', 'Policy not found');
  assertOwner(policy, auth);
  const sources = await loadPolicySources(policyId, tx);
  if (!sources) throw new ConversionError('policy_not_found', 'Policy not found');
  for (const [table, ids] of [
    [configPolicyAlertRules, sources.inlineRules.map(r => r.id)],
    [configPolicyMonitoringWatches, sources.watches.map(r => r.id)],
    [configPolicyAutomations, sources.policyAutomations.map(r => r.id)],
    [automations, sources.standaloneAutomations.map(r => r.id)],
  ] as const) if (ids.length) await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids)).orderBy(table.id).for('update');
  await tx.select({ id: configPolicyFeatureLinks.id }).from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, policyId)).orderBy(configPolicyFeatureLinks.id).for('update');
  await tx.select({ id: monitorDefinitions.id }).from(monitorDefinitions).where(policy.orgId ? eq(monitorDefinitions.orgId, policy.orgId)
    : and(isNull(monitorDefinitions.orgId), eq(monitorDefinitions.partnerId, policy.partnerId!))).orderBy(monitorDefinitions.id).for('update');
  return sources;
}
async function cooldownPairs(tx: DbExecutor, ids: string[]) {
  if (!ids.length) return [];
  return tx.select({ sourceId: monitorConversions.sourceId, compiledRuleId: monitorDefinitions.compiledAlertRuleId })
    .from(monitorConversions).innerJoin(monitorConversionOutputs, eq(monitorConversionOutputs.conversionId, monitorConversions.id))
    .innerJoin(monitorDefinitions, eq(monitorDefinitions.id, monitorConversionOutputs.monitorId))
    .where(and(inArray(monitorConversions.id, ids), eq(monitorConversions.sourceTable, 'config_policy_alert_rules'), eq(monitorConversionOutputs.role, 'primary')));
}
/**
 * The cooldown rekey runs AFTER its transaction has committed, so a Redis
 * failure here must never reject the caller: the conversion (or revert) has
 * already landed, and rejecting would report a failure for work that is done
 * and then answer `already_converted` on the retry. Failures go to Sentry.
 */
export async function rekeyCommittedCooldowns(
  pairs: readonly { sourceId: string; compiledRuleId: string | null }[],
  direction: 'to_monitor' | 'back_to_config_policy' | 'rule_to_monitor' | 'monitor_to_rule',
): Promise<void> {
  for (const pair of pairs) {
    if (!pair.compiledRuleId) continue;
    try {
      if (direction === 'to_monitor') await rekeyConfigPolicyCooldowns(pair.sourceId, pair.compiledRuleId);
      else if (direction === 'back_to_config_policy') await rekeyCooldownsBackToConfigPolicy(pair.compiledRuleId, pair.sourceId);
      else if (direction === 'rule_to_monitor') await rekeyRuleCooldowns(pair.sourceId, pair.compiledRuleId);
      else await rekeyRuleCooldowns(pair.compiledRuleId, pair.sourceId);
    } catch (error) {
      captureException(error, undefined, {
        errorId: 'monitor-conversion-cooldown-rekey-failed',
        sourceId: pair.sourceId, compiledRuleId: pair.compiledRuleId, direction,
      });
      console.error(`[MonitorConversion] cooldown rekey (${direction}) failed for source ${pair.sourceId}; the conversion itself is committed:`, error);
    }
  }
}

export async function convertPolicy(policyId: string, expectedHash: string, auth: AuthContext, opts?: { sourceIds?: string[]; }) {
  // Self-managed route (D30): no ambient context, so scope this read too.
  const policy = await withCallerContext(auth, async () => {
    const found = await authorizePreview(policyId, auth);
    assertOwner(found, auth);
    return found;
  });
  const committed = await inCallerTransaction(auth, async tx => {
    await lockConversion(tx, policy);
    const sources = await lockPolicyInputs(tx, policyId, auth);
    const [completed] = await tx.select().from(monitorConversions).where(and(
      eq(monitorConversions.policyId, policyId), eq(monitorConversions.previewHash, expectedHash),
      isNull(monitorConversions.revertedAt), opts?.sourceIds ? inArray(monitorConversions.sourceId, opts.sourceIds) : undefined,
    )).limit(1);
    if (completed) {
      await visibleSource(tx, completed.sourceTable, completed.sourceId, auth);
      throw new ConversionError('already_converted', 'Source already converted');
    }
    const preview = await buildPolicyPreviewInTx(policyId, auth, tx);
    assertPreview(preview, expectedHash);
    const proposal = proposalFrom(preview, sources.policy, opts?.sourceIds);
    // `preview.equivalence` (validated above) proves the FULL convertible set is
    // behavior-preserving. When the caller commits only a subset (`sourceIds`),
    // that proof does not cover it: the unselected sources stay live as legacy
    // configuration instead of being retired, which is a materially different
    // resulting state. Re-run the proof against exactly what will be applied.
    if (opts?.sourceIds) {
      const deviceIds = await resolveDeviceIdsForPolicy(policyId, tx);
      const subsetEquivalence = await computeEquivalence({ ...proposal, previewHash: preview.previewHash }, deviceIds, auth, undefined, tx);
      if (subsetEquivalence.deltas.length) {
        throw new ConversionError('equivalence_delta', 'Conversion changes effective behavior', subsetEquivalence.deltas);
      }
    }
    const result = await applyProposalInTx(tx, proposal, auth);
    return { result, pairs: await cooldownPairs(tx, result.conversionIds) };
  });
  await rekeyCommittedCooldowns(committed.pairs, 'to_monitor');
  return committed.result;
}

function sourceTableFor(sourceTable: ConversionSourceTable) {
  switch (sourceTable) {
    case 'config_policy_alert_rules': return configPolicyAlertRules;
    case 'config_policy_monitoring_watches': return configPolicyMonitoringWatches;
    case 'config_policy_automations': return configPolicyAutomations;
    case 'automations': return automations;
    case 'alert_templates': return alertTemplates;
    // W05e adds retirement columns and its supported network source here.
    default: throw new ConversionError('source_not_found', 'Source runtime not available');
  }
}
async function visibleSource(tx: DbExecutor, kind: ConversionSourceTable, id: string, auth: AuthContext, lock = false) {
  const table = sourceTableFor(kind);
  const query = tx.select().from(table).where(eq(table.id, id)).limit(1);
  const [source] = await (lock ? query.for('update') : query);
  if (!source) throw new ConversionError('source_not_found', 'Source not found');
  let owner: Owner;
  let policyId: string | null = null;
  if ('orgId' in source) {
    owner = { orgId: source.orgId, partnerId: source.partnerId };
    if ('managedByMonitorId' in source && source.managedByMonitorId) throw new ConversionError('source_not_found', 'Managed source unavailable');
  } else {
    let linkId: string;
    if ('settingsId' in source) {
      const [settings] = await tx.select().from(configPolicyMonitoringSettings).where(eq(configPolicyMonitoringSettings.id, source.settingsId)).limit(1);
      if (!settings) throw new ConversionError('source_not_found', 'Source not found');
      linkId = settings.featureLinkId;
    } else linkId = source.featureLinkId;
    const [link] = await tx.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, linkId)).limit(1);
    if (!link) throw new ConversionError('source_not_found', 'Source not found');
    const [policy] = await tx.select().from(configurationPolicies).where(eq(configurationPolicies.id, link.configPolicyId)).limit(1);
    if (!policy) throw new ConversionError('source_not_found', 'Source not found');
    owner = { orgId: policy.orgId, partnerId: policy.partnerId }; policyId = policy.id;
  }
  assertOwner(owner, auth);
  return { table, source, owner, policyId };
}
async function liveLedger(tx: DbExecutor, sourceTable: ConversionSourceTable, sourceId: string) {
  const [live] = await tx.select().from(monitorConversions).where(and(eq(monitorConversions.sourceTable, sourceTable), eq(monitorConversions.sourceId, sourceId), isNull(monitorConversions.revertedAt))).limit(1);
  return live;
}
export async function retireSource(sourceTable: ConversionSourceTable, sourceId: string, reason: string, auth: AuthContext): Promise<{ conversionId: string; }> {
  if (reason !== 'operator' && !/^unconvertible:[a-z][a-z0-9_]*$/.test(reason)) throw new ConversionError('invalid_reason', 'Invalid retirement reason');
  return inCallerTransaction(auth, async tx => {
    const first = await visibleSource(tx, sourceTable, sourceId, auth);
    await lockConversion(tx, first.owner);
    const { table, source, owner, policyId } = await visibleSource(tx, sourceTable, sourceId, auth, true);
    if (source.retiredAt || await liveLedger(tx, sourceTable, sourceId)) throw new ConversionError('already_converted', 'Source already retired');
    const rules = sourceTable === 'alert_templates' ? await tx.select().from(alertRules).where(and(eq(alertRules.templateId, sourceId), isNull(alertRules.retiredAt), isNull(alertRules.managedByMonitorId))).orderBy(alertRules.id).for('update') : [];
    for (const rule of rules) {
      assertOwner(rule, auth);
      if (rule.orgId !== owner.orgId || rule.partnerId !== owner.partnerId) throw new ConversionError('blocked', 'Mixed template owners');
    }
    const [ledger] = await tx.insert(monitorConversions).values({
      ...owner, sourceTable, sourceId, policyId, convertedBy: actor(auth),
      previewHash: sha(canonical({ source, rules, reason })), sourceState: { source, rules }
    }).onConflictDoNothing().returning();
    if (!ledger) throw new ConversionError('already_converted', 'Source already retired');
    const retired = await tx.update(table).set({ retiredAt: new Date(), retiredReason: reason }).where(and(eq(table.id, sourceId), isNull(table.retiredAt))).returning({ id: table.id });
    if (!retired.length) throw new ConversionError('already_converted', 'Source already retired');
    for (const rule of rules) await tx.update(alertRules).set({ retiredAt: new Date(), retiredReason: reason }).where(eq(alertRules.id, rule.id));
    return { conversionId: ledger.id };
  });
}

export function partnerPreviewHash(partnerId: string, scopeHash: string,
  parts: Array<{ sourceTable: ConversionSourceTable; sourceId: string; inputHash: string; reason: string | null; }>): string {
  return sha(canonical({ partnerId, scopeHash, parts: [...parts].sort((a, b) => a.sourceTable.localeCompare(b.sourceTable) || a.sourceId.localeCompare(b.sourceId)) }));
}
function assertPartner(partnerId: string, auth: AuthContext) {
  if (!canManagePartnerWidePolicies(auth) || !canMutateOrgWideGovernance(auth)
    || (auth.scope !== 'system' && auth.partnerId !== partnerId)) throw new ConversionError('partner_wide_denied', 'Full partner access required');
}
class PartnerPreviewRollback extends Error { }
async function partnerPlanInTx(partnerId: string, auth: AuthContext, tx: DbExecutor, expectedHash?: string) {
  const [partner] = await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).limit(1);
  if (!partner) throw new ConversionError('source_not_found', 'Partner not found');
  await lockConversion(tx, { orgId: null, partnerId });
  const orgs = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, partnerId));
  const orgIds = orgs.map(o => o.id);
  const ownership = (table: typeof configurationPolicies | typeof alertTemplates) => or(
    orgIds.length ? inArray(table.orgId, orgIds) : sql`false`, and(isNull(table.orgId), eq(table.partnerId, partnerId)));
  const policies = await tx.select().from(configurationPolicies).where(and(ownership(configurationPolicies), eq(configurationPolicies.status, 'active'))).orderBy(configurationPolicies.id).for('update');
  const templates = await tx.select().from(alertTemplates).where(and(ownership(alertTemplates), eq(alertTemplates.isBuiltIn, false), isNull(alertTemplates.managedByMonitorId), isNull(alertTemplates.retiredAt))).orderBy(alertTemplates.id).for('update');
  for (const row of [...policies, ...templates]) assertOwner(row, auth);
  const ordered: typeof policies = [], remaining = [...policies];
  while (remaining.length) {
    const index = remaining.findIndex(p => !p.parentPolicyId || !remaining.some(parent => parent.id === p.parentPolicyId));
    if (index < 0) throw new ConversionError('blocked', 'Policy inheritance cycle');
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  // Hash the complete INITIAL snapshot. Staging parent monitors generates UUIDs;
  // those transient ids must never make the confirmation nondeterministic.
  const parts: Parameters<typeof partnerPreviewHash>[2] = [];
  for (const policy of ordered) parts.push({
    sourceTable: 'config_policy_alert_rules', sourceId: policy.id,
    inputHash: sha(canonical({ freshness: await previewFreshness(policy.id, tx), missing: missingConversionPrerequisites() })), reason: null
  });
  for (const template of templates) {
    const preview = await templateGroupPreviewInTx(template.id, auth, tx);
    parts.push({ sourceTable: 'alert_templates', sourceId: template.id, inputHash: preview.previewHash, reason: preview.blockedBy });
  }
  const hash = partnerPreviewHash(partnerId, previewScopeHash(snapshotPreviewAccess(auth)), parts);
  if (expectedHash !== undefined && hash !== expectedHash) throw new ConversionError('preview_stale', 'Partner conversion inputs changed');
  const summary: PartnerConversionPreview = { partnerId, previewHash: hash, policies: 0, rows: 0, convertible: 0, unconvertible: [] };
  const conversionIds: string[] = [];
  // cooldownPairs() only covers config_policy_alert_rules; a converted
  // template retires standalone alert_rules, which rekey rule → rule.
  const rulePairs: Array<{ sourceId: string; compiledRuleId: string | null; }> = [];
  for (const policy of ordered) {
    const sources = await lockPolicyInputs(tx, policy.id, auth);
    const preview = await buildPolicyPreviewInTx(policy.id, auth, tx);
    // Blocked previews intentionally have no proposals; still enumerate every source as a refusal.
    const items = preview.items.length ? preview.items : [
      ...sources.inlineRules.map(row => ({ sourceTable: 'config_policy_alert_rules' as const, ...row })),
      ...sources.watches.map(row => ({ sourceTable: 'config_policy_monitoring_watches' as const, ...row })),
      ...sources.policyAutomations.map(row => ({ sourceTable: 'config_policy_automations' as const, ...row })),
      ...sources.standaloneAutomations.map(row => ({ sourceTable: 'automations' as const, ...row })),
    ].map(row => ({ sourceTable: row.sourceTable, sourceId: row.id, name: row.name, outcome: 'unconvertible' as const, reason: `unconvertible:${preview.blockedBy ?? 'blocked'}` }));
    if (items.length) summary.policies++;
    const blocked = preview.blockedBy || (preview.equivalence.deltas.length ? 'equivalence_delta' : null);
    for (const item of items) {
      summary.rows++;
      if (!blocked && item.outcome === 'convertible') summary.convertible++;
      else summary.unconvertible.push({
        policyId: policy.id, policyName: policy.name, sourceTable: item.sourceTable, sourceId: item.sourceId, name: item.name,
        reason: blocked ? `unconvertible:${blocked}` : item.reason ?? 'unconvertible:blocked'
      });
    }
    if (!blocked) {
      const result = await applyProposalInTx(tx, proposalFrom(preview, sources.policy), auth);
      conversionIds.push(...result.conversionIds);
    }
  }
  for (const template of templates) {
    const preview = await templateGroupPreviewInTx(template.id, auth, tx);
    summary.rows++;
    const reason = preview.blockedBy ?? (preview.equivalence.deltas.length ? 'unconvertible:equivalence_delta' : null);
    if (reason) summary.unconvertible.push({ policyId: null, policyName: null, sourceTable: 'alert_templates', sourceId: template.id, name: template.name, reason });
    else {
      summary.convertible++;
      const result = await applyTemplateGroupInTx(await loadTemplateGroup(template.id, auth, tx, true), preview.previewHash, auth, tx);
      conversionIds.push(result.conversionId);
      rulePairs.push(...result.cooldownPairs);
    }
  }
  return { summary, conversionIds, pairs: await cooldownPairs(tx, conversionIds), rulePairs };
}
export async function previewPartnerConversion(partnerId: string, auth: AuthContext): Promise<PartnerConversionPreview> {
  assertPartner(partnerId, auth);
  let result: PartnerConversionPreview | undefined;
  try {
    await inCallerTransaction(auth, async tx => { result = (await partnerPlanInTx(partnerId, auth, tx)).summary; throw new PartnerPreviewRollback(); });
  } catch (error) { if (!(error instanceof PartnerPreviewRollback)) throw error; }
  if (!result) throw new Error('Partner preview failed');
  return result;
}
export async function convertPartnerLegacy(partnerId: string, expectedHash: string, auth: AuthContext) {
  assertPartner(partnerId, auth);
  const committed = await inCallerTransaction(auth, tx => partnerPlanInTx(partnerId, auth, tx, expectedHash));
  await rekeyCommittedCooldowns(committed.pairs, 'to_monitor');
  await rekeyCommittedCooldowns(committed.rulePairs, 'rule_to_monitor');
  return { policies: committed.summary.policies, converted: committed.conversionIds.length, unconvertible: committed.summary.unconvertible.length };
}

interface TemplateGroupPlan {
  rule: typeof alertRules.$inferSelect;
  target: ReturnType<typeof assignmentForRule>;
  mapped: ReturnType<typeof mapStandaloneRule>;
}
interface TemplateGroupResult {
  conversionId: string;
  convertedRuleIds: string[];
  outputs: Array<{ sourceRuleId: string; role: string; monitorId: string; policyId: string; }>;
  /** Retired rule id → its primary monitor's compiled rule id, for the post-commit cooldown rekey. */
  cooldownPairs: Array<{ sourceId: string; compiledRuleId: string | null; }>;
}
class TemplatePreviewRollback extends Error { }

/** Reads through the caller's executor before the global live-source index is consulted. */
async function loadTemplateGroup(templateId: string, auth: AuthContext, tx: DbExecutor, lock = false) {
  const templateQuery = tx.select().from(alertTemplates).where(eq(alertTemplates.id, templateId)).limit(1);
  const [template] = await (lock ? templateQuery.for('update') : templateQuery);
  if (!template || template.managedByMonitorId) {
    throw new ConversionError('source_not_found', 'Template unavailable');
  }
  assertOwner(template, auth);
  if (template.retiredAt) {
    if (await liveLedger(tx, 'alert_templates', template.id)) throw new ConversionError('already_converted', 'Template group already converted');
    throw new ConversionError('source_not_found', 'Template unavailable');
  }
  const rulesQuery = tx.select().from(alertRules).where(and(eq(alertRules.templateId, templateId),
    isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt))).orderBy(alertRules.id);
  const rules = await (lock ? rulesQuery.for('update') : rulesQuery);
  // Disabled rules remain members of the group. No active-only predicate here.
  const plans = rules.map((rule): TemplateGroupPlan => {
    let mapped = mapStandaloneRule(rule, template);
    const overrides = (rule.overrideSettings ?? {}) as Record<string, unknown>;
    if (overrides.autoResolveConditions ?? template.autoResolveConditions) {
      mapped = { ok: false, reason: 'unconvertible:auto_resolve_conditions', notes: ['Custom legacy resolution behavior must be re-authored.'] };
    } else if (mapped.ok && typeof overrides.autoResolve === 'boolean') {
      mapped = { ...mapped, proposed: mapped.proposed.map((p) => ({ ...p, autoResolve: overrides.autoResolve as boolean })) };
    }
    return { rule, target: assignmentForRule(rule), mapped };
  });
  for (const plan of plans) {
    assertOwner(plan.rule, auth);
    if (plan.target && !await validTemplateTarget(template, plan.target, tx)) plan.target = null;
  }
  return { template, rules, plans };
}

async function applyTemplateGroupInTx(group: Awaited<ReturnType<typeof loadTemplateGroup>>, previewHash: string,
  auth: AuthContext, tx: DbExecutor): Promise<TemplateGroupResult> {
  // Re-read all sources in this transaction, including every member, before any ledger write.
  const current = await loadTemplateGroup(group.template.id, auth, tx, true);
  if (sha(canonical(current)) !== sha(canonical(group))) throw new ConversionError('preview_stale', 'Template group changed');
  const { template, rules, plans } = current;
  if (!plans.length || template.isBuiltIn || (!template.orgId && !template.partnerId)
    || plans.some((p) => !p.target || !p.mapped.ok || p.rule.orgId !== template.orgId || p.rule.partnerId !== template.partnerId)) {
    throw new ConversionError('blocked', 'Template group cannot be converted atomically');
  }
  const [live] = await tx.select().from(monitorConversions).where(and(eq(monitorConversions.sourceTable, 'alert_templates'),
    eq(monitorConversions.sourceId, template.id), isNull(monitorConversions.revertedAt))).limit(1);
  if (live) throw new ConversionError('already_converted', 'Template group already converted');
  const [ledger] = await tx.insert(monitorConversions).values({
    orgId: template.orgId, partnerId: template.partnerId,
    sourceTable: 'alert_templates', sourceId: template.id, policyId: null, convertedBy: actor(auth), previewHash,
    sourceState: { template, rules },
  }).onConflictDoNothing().returning();
  if (!ledger) throw new ConversionError('already_converted', 'Template group already converted');
  const result: TemplateGroupResult = { conversionId: ledger.id, convertedRuleIds: rules.map((r) => r.id), outputs: [], cooldownPairs: [] };
  for (const plan of plans) {
    if (!plan.mapped.ok || !plan.target) throw new ConversionError('blocked', 'Invalid group plan');
    const owner = plan.rule.orgId ? { orgId: plan.rule.orgId } : { partnerId: plan.rule.partnerId! };
    const policy = await createConfigPolicy(owner, { name: `Converted: ${plan.rule.name}` }, actor(auth), tx);
    if (!policy) throw new ConversionError('blocked', 'Could not create conversion policy');
    await assignPolicy(policy.id, plan.target.level, plan.target.targetId, 0, actor(auth), undefined, undefined, tx);
    const created: Array<{ proposed: (typeof plan.mapped.proposed)[number]; monitor: Awaited<ReturnType<typeof createMonitorDefinition>>; }> = [];
    for (const proposed of plan.mapped.proposed) {
      const monitor = await createMonitorDefinition({
        ...proposed, ownerScope: plan.rule.orgId ? 'organization' : 'partner',
        orgId: plan.rule.orgId ?? undefined, recurrenceActions: [], pauseResponsesOnEscalation: true,
      } as Parameters<typeof createMonitorDefinition>[0], { ...auth, partnerId: plan.rule.partnerId ?? auth.partnerId }, {}, tx);
      created.push({ proposed, monitor });
    }
    const link = await addFeatureLink(policy.id, 'monitors', null, {
      inheritance: 'cumulative',
      items: created.map(({ proposed, monitor }, sortOrder) => ({ monitorId: monitor.id, enabled: proposed.enabled, sortOrder })),
    }, undefined, tx);
    if (!link) throw new ConversionError('blocked', 'Could not attach converted monitors');
    let primaryId: string | null = null;
    for (const { proposed, monitor } of created) {
      const [attachment] = await tx.select().from(configPolicyMonitors).where(and(eq(configPolicyMonitors.featureLinkId, link.id),
        eq(configPolicyMonitors.monitorId, monitor.id))).limit(1);
      if (!attachment) throw new ConversionError('blocked', 'Converted attachment unavailable');
      const movedAlertRefs = proposed.role === 'primary' && monitor.compiledAlertRuleId
        ? await carryOpenAlerts(tx, {
          sourceTable: 'alert_templates', sourceId: template.id, ruleId: plan.rule.id,
          compiledRuleId: monitor.compiledAlertRuleId, monitorId: monitor.id
        }) : [];
      await tx.insert(monitorConversionOutputs).values({
        conversionId: ledger.id, orgId: ledger.orgId, partnerId: ledger.partnerId,
        monitorId: monitor.id, role: proposed.role, sourceRuleId: plan.rule.id, policyId: policy.id,
        attachmentId: attachment.id, reusedMonitor: false, movedAlertIds: movedAlertRefs.map((a) => a.id), movedAlertRefs
      });
      result.outputs.push({ sourceRuleId: plan.rule.id, role: proposed.role, monitorId: monitor.id, policyId: policy.id });
      if (proposed.role === 'primary') primaryId = monitor.id;
    }
    const primaryCompiled = created.find((c) => c.proposed.role === 'primary')?.monitor.compiledAlertRuleId ?? null;
    result.cooldownPairs.push({ sourceId: plan.rule.id, compiledRuleId: primaryCompiled });
    const retired = await tx.update(alertRules).set({ retiredAt: new Date(), retiredReason: 'operator', convertedToMonitorId: primaryId })
      .where(and(eq(alertRules.id, plan.rule.id), isNull(alertRules.retiredAt))).returning({ id: alertRules.id });
    if (!retired.length) throw new ConversionError('already_converted', 'Rule already converted');
  }
  const retired = await tx.update(alertTemplates).set({ retiredAt: new Date(), retiredReason: 'operator' })
    .where(and(eq(alertTemplates.id, template.id), isNull(alertTemplates.retiredAt))).returning({ id: alertTemplates.id });
  if (!retired.length) throw new ConversionError('already_converted', 'Template already converted');
  return result;
}

async function templateGroupPreviewInTx(templateId: string, auth: AuthContext, tx: DbExecutor) {
  const group = await loadTemplateGroup(templateId, auth, tx, true);
  const { template, plans } = group;
  for (const plan of plans) if (plan.mapped.ok) for (const monitor of plan.mapped.proposed) {
    if (monitor.escalationPolicyId && !await compatibleEscalation(monitor.escalationPolicyId, { ...template, parentPolicyId: null }, tx)) {
      plan.mapped = { ok: false, reason: 'unconvertible:escalation_policy_axis', notes: [] }; break;
    }
  }
  const missing = missingConversionPrerequisites();
  const firstRefusal = plans.find((p) => !p.mapped.ok);
  const blockedBy = missing.length ? 'prerequisite_missing'
    : template.isBuiltIn || (!template.orgId && !template.partnerId) ? 'unconvertible:built_in'
      : !plans.length ? 'unconvertible:no_rules'
        : plans.some((p) => !p.target || p.rule.orgId !== template.orgId || p.rule.partnerId !== template.partnerId) ? 'unconvertible:target_or_owner'
          : firstRefusal && !firstRefusal.mapped.ok ? firstRefusal.mapped.reason : null;
  // Include every visible device owned by this group, not merely current matches: a new
  // target policy can also change monitor precedence on a formerly unaffected device.
  const orgs = await tx.select().from(organizations).where(template.orgId
    ? eq(organizations.id, template.orgId) : eq(organizations.partnerId, template.partnerId!)).orderBy(organizations.id);
  const orgIds = orgs.map((o) => o.id);
  const deviceRows = orgIds.length ? await tx.select().from(devices).where(inArray(devices.orgId, orgIds)).orderBy(devices.id) : [];
  const deviceIds = deviceRows.map((d) => d.id);
  const memberships = deviceIds.length ? await tx.select().from(deviceGroupMemberships)
    .where(inArray(deviceGroupMemberships.deviceId, deviceIds)).orderBy(deviceGroupMemberships.deviceId, deviceGroupMemberships.groupId) : [];
  // RLS-scoped rows bind delivery, assignment and definition edits, including empty target scopes.
  const routes = await tx.select().from(notificationRoutingRules).orderBy(notificationRoutingRules.id);
  const channels = await tx.select().from(notificationChannels).orderBy(notificationChannels.id);
  const escalations = await tx.select().from(escalationPolicies).orderBy(escalationPolicies.id);
  const policies = await tx.select().from(configurationPolicies).orderBy(configurationPolicies.id);
  const assignments = await tx.select().from(configPolicyAssignments).orderBy(configPolicyAssignments.id);
  const links = await tx.select().from(configPolicyFeatureLinks).orderBy(configPolicyFeatureLinks.id);
  const definitions = await tx.select().from(monitorDefinitions).orderBy(monitorDefinitions.id);
  const signatureMaps = new Map<string, Map<string, string>>();
  const policySignatures = async (deviceId: string, executor: DbExecutor) => new Map([
    ...await signatureMapForLegacy(deviceId, await resolveLegacyBaseline(deviceId, executor), executor),
    ...await signatureMapForMonitors(deviceId, executor),
  ]);
  if (!blockedBy) for (const device of deviceRows) {
    const before = await policySignatures(device.id, tx);
    for (const { rule, mapped } of plans) {
      if (!rule.isActive || !mapped.ok) continue;
      const matches = rule.targetType === 'all' || (rule.targetType === 'org' && rule.targetId === device.orgId)
        || (rule.targetType === 'site' && rule.targetId === device.siteId) || (rule.targetType === 'device' && rule.targetId === device.id)
        || (rule.targetType === 'group' && memberships.some((m) => m.deviceId === device.id && m.groupId === rule.targetId));
      if (!matches) continue;
      for (const proposed of mapped.proposed) {
        const overrides = (rule.overrideSettings ?? {}) as Record<string, unknown>;
        const delivery = await resolveDelivery({
          orgId: device.orgId, siteId: device.siteId, severity: proposed.severity, kind: null,
          legacyOverride: {
            channelIds: Array.isArray(overrides.notificationChannelIds) ? overrides.notificationChannelIds as string[] : [],
            escalationPolicyId: typeof overrides.escalationPolicyId === 'string' ? overrides.escalationPolicyId : null
          },
        }, tx);
        before.set(`standalone:${rule.id}:${proposed.role}`, sha(canonical({
          behavior: monitorSignature({
            ...proposed,
            deliveryMode: 'channels', deliveryChannelIds: delivery.channelIds, escalationPolicyId: delivery.escalationPolicyId
          }),
          skippedChannelIds: [...delivery.skippedChannelIds].sort((a, b) => a.id.localeCompare(b.id)),
        })));
      }
    }
    signatureMaps.set(device.id, before);
  }
  const previewHash = sha(canonical({
    group, scopeHash: previewScopeHash(snapshotPreviewAccess(auth)), blockedBy,
    orgs, deviceRows, memberships, routes, channels, escalations, policies, assignments, links, definitions,
    signatures: [...signatureMaps].map(([id, signatures]) => [id, [...signatures].sort(([a], [b]) => a.localeCompare(b))]),
  }));
  const equivalence: { devicesChecked: number; deltas: Array<{ deviceId: string; detail: string; }>; } = { devicesChecked: 0, deltas: [] };
  if (!blockedBy) {
    try {
      await tx.transaction(async (staged) => {
        await applyTemplateGroupInTx(group, previewHash, auth, staged);
        for (const device of deviceRows) {
          const after = await policySignatures(device.id, staged);
          for (const detail of diffSignatureSets(signatureMaps.get(device.id)!, after)) equivalence.deltas.push({ deviceId: device.id, detail });
          equivalence.devicesChecked++;
        }
        throw new TemplatePreviewRollback();
      });
    } catch (error) {
      if (!(error instanceof TemplatePreviewRollback)) throw error;
    }
  }
  return { templateId, template, rules: group.rules, plans, previewHash, blockedBy, missingPrerequisites: missing, equivalence };
}

export async function previewTemplateGroup(templateId: string, auth: AuthContext, executor: DbExecutor = db) {
  const work = async (tx: DbExecutor) => {
    const group = await loadTemplateGroup(templateId, auth, tx);
    await lockConversion(tx, group.template);
    return templateGroupPreviewInTx(templateId, auth, tx);
  };
  return executor === db ? inCallerTransaction(auth, work) : executor.transaction(work);
}

export async function convertTemplateGroup(templateId: string, expectedHash: string, auth: AuthContext,
  executor: DbExecutor = db): Promise<TemplateGroupResult> {
  const work = async (tx: DbExecutor) => {
    const group = await loadTemplateGroup(templateId, auth, tx);
    await lockConversion(tx, group.template);
    const preview = await templateGroupPreviewInTx(templateId, auth, tx);
    if (preview.previewHash !== expectedHash) throw new ConversionError('preview_stale', 'Template group changed');
    if (preview.blockedBy) throw new ConversionError('blocked', 'Template group cannot be converted', preview);
    if (preview.equivalence.deltas.length) throw new ConversionError('equivalence_delta', 'Template group behavior differs', preview.equivalence);
    return applyTemplateGroupInTx(group, expectedHash, auth, tx);
  };
  const result = executor === db ? await inCallerTransaction(auth, work) : await executor.transaction(work);
  await rekeyCommittedCooldowns(result.cooldownPairs, 'rule_to_monitor');
  return result;
}

function originalRetirement(state: Record<string, unknown>) {
  return {
    retiredAt: state.retiredAt ? new Date(String(state.retiredAt)) : null,
    retiredReason: typeof state.retiredReason === 'string' ? state.retiredReason : null,
    convertedToMonitorId: typeof state.convertedToMonitorId === 'string' ? state.convertedToMonitorId : null
  };
}
async function revertInTx(conversionId: string, auth: AuthContext, tx: DbExecutor) {
  const [first] = await tx.select().from(monitorConversions).where(eq(monitorConversions.id, conversionId)).limit(1);
  if (!first) throw new ConversionError('conversion_not_found', 'Conversion not found');
  assertOwner(first, auth);
  if (!isRevertAvailable(first.sourceTable)) throw new ConversionError('conversion_revert_unavailable', 'This source runtime has been retired');
  // Source visibility precedes every mutation and every lookup of a global live-source key.
  const initialSource = await visibleSource(tx, first.sourceTable, first.sourceId, auth);
  await lockConversion(tx, initialSource.owner);
  const [ledger] = await tx.select().from(monitorConversions).where(eq(monitorConversions.id, conversionId)).limit(1).for('update');
  if (!ledger || ledger.revertedAt) throw new ConversionError('conversion_not_found', 'Live conversion not found');
  assertOwner(ledger, auth);
  if (!isRevertAvailable(ledger.sourceTable)) throw new ConversionError('conversion_revert_unavailable', 'This source runtime has been retired');
  if ((await findLiveTargetDependencies([ledger], tx)).has(ledger.id)) throw new ConversionError('blocked', 'Revert the target conversion before this response');
  const dependentRows = await tx.select().from(monitorConversions).where(and(isNull(monitorConversions.revertedAt),
    sql`${monitorConversions.sourceState}->>'targetConversionId' = ${ledger.id}`)).orderBy(monitorConversions.id).for('update');
  const dependents = dependentRows.filter(row => row.id !== ledger.id && row.sourceState.targetConversionId === ledger.id);
  const entries = [];
  for (const current of [...dependents, ledger]) {
    assertOwner(current, auth);
    if (!isRevertAvailable(current.sourceTable)) throw new ConversionError('conversion_revert_unavailable', 'This source runtime has been retired');
    const source = await visibleSource(tx, current.sourceTable, current.sourceId, auth, true);
    if (source.owner.orgId !== current.orgId || source.owner.partnerId !== current.partnerId) throw new ConversionError('source_not_found', 'Source ownership changed');
    const original = (current.sourceState.source ?? current.sourceState.template) as Record<string, unknown> | undefined;
    if (!original || original.id !== current.sourceId) throw new ConversionError('blocked', 'Original source state unavailable');
    const rules = (current.sourceState.rules ?? []) as Array<Record<string, unknown>>;
    for (const rule of rules) {
      if (typeof rule.id !== 'string') throw new ConversionError('blocked', 'Original rule state unavailable');
      const [visible] = await tx.select().from(alertRules).where(eq(alertRules.id, rule.id)).limit(1).for('update');
      if (!visible || visible.templateId !== current.sourceId) throw new ConversionError('source_not_found', 'Original rule not found');
      assertOwner(visible, auth);
      if (visible.orgId !== current.orgId || visible.partnerId !== current.partnerId) throw new ConversionError('source_not_found', 'Rule ownership changed');
    }
    const outputs = await tx.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, current.id)).orderBy(monitorConversionOutputs.id).for('update');
    for (const output of outputs) if (output.monitorId) {
      await tx.select({ id: monitorDefinitions.id }).from(monitorDefinitions).where(eq(monitorDefinitions.id, output.monitorId)).for('update');
    }
    entries.push({ current, source, original, rules, outputs });
  }
  const pairs = await cooldownPairs(tx, entries.map(e => e.current.id));
  // Restore all response sources alongside the target; no compiled deletion precedes restoration.
  for (const { current, source, original, rules } of entries) {
    if (typeof current.sourceState.workflowId === 'string') await tx.update(automations).set({ enabled: false }).where(eq(automations.id, current.sourceState.workflowId));
    await tx.update(source.table).set({
      ...originalRetirement(original),
      ...(typeof original.enabled === 'boolean' ? { enabled: original.enabled } : {})
    }).where(eq(source.table.id, current.sourceId));
    for (const rule of rules) await tx.update(alertRules).set({
      ...originalRetirement(rule),
      ...(typeof rule.isActive === 'boolean' ? { isActive: rule.isActive } : {}),
      ...(rule.overrideSettings !== undefined ? { overrideSettings: rule.overrideSettings } : {})
    }).where(eq(alertRules.id, rule.id as string));
  }
  for (const { outputs } of entries) for (const output of outputs) await restoreMovedAlertRefs(tx, output.movedAlertRefs);
  for (const { current, outputs } of entries) {
    const priorLink = current.sourceState.monitorsLink as PolicySources['links']['monitors'] | undefined;
    const affectedLinks = new Set<string>(priorLink?.id ? [priorLink.id] : []);
    for (const output of outputs) {
      if (output.attachmentId) {
        const [attachment] = await tx.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.id, output.attachmentId)).limit(1);
        if (attachment) affectedLinks.add(attachment.featureLinkId);
        await tx.delete(configPolicyMonitors).where(eq(configPolicyMonitors.id, output.attachmentId));
      }
      if (!output.monitorId) continue;
      if (output.role === 'response') await removeResponseContribution(tx, current, output.monitorId, entries.map(e => e.current.id), auth);
      const otherLive = await tx.select({ id: monitorConversionOutputs.id }).from(monitorConversionOutputs)
        .innerJoin(monitorConversions, eq(monitorConversions.id, monitorConversionOutputs.conversionId))
        .where(and(eq(monitorConversionOutputs.monitorId, output.monitorId), ne(monitorConversions.id, current.id), isNull(monitorConversions.revertedAt))).limit(1);
      const otherAttachments = await tx.select({ id: configPolicyMonitors.id }).from(configPolicyMonitors).where(eq(configPolicyMonitors.monitorId, output.monitorId)).limit(1);
      if (otherLive.length || otherAttachments.length) continue;
      if (output.sourceRuleId || current.sourceTable === 'config_policy_alert_rules') {
        await tx.update(alerts).set({
          ruleId: output.sourceRuleId ?? null, configPolicyId: output.sourceRuleId ? null : current.sourceId, monitorId: null,
          context: sql`COALESCE(${alerts.context}, '{}'::jsonb) || jsonb_build_object('revertedConversionId', ${current.id}::text)`
        }).where(eq(alerts.monitorId, output.monitorId));
      }
      if (!output.reusedMonitor && await canDeleteConversionMonitor(tx, output.monitorId, current.id)) await deleteMonitorDefinition(output.monitorId, auth, tx);
    }
    for (const linkId of affectedLinks) {
      const [link] = await tx.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, linkId)).limit(1).for('update');
      if (!link) continue;
      const remaining = await tx.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, linkId)).orderBy(configPolicyMonitors.sortOrder);
      const settings = (link.inlineSettings ?? {}) as Record<string, unknown>;
      const prior = current.sourceState.monitorsLink as PolicySources['links']['monitors'] | undefined;
      let inheritance = settings.inheritance ?? 'cumulative';
      const others = await tx.select({ id: monitorConversions.id }).from(monitorConversions)
        .where(and(eq(monitorConversions.policyId, link.configPolicyId), ne(monitorConversions.id, current.id), isNull(monitorConversions.revertedAt))).limit(1);
      if (!others.length) {
        const originalItems = prior?.items ?? [];
        const items = remaining.map(r => ({ monitorId: r.monitorId, enabled: r.enabled, overrides: r.overrides, sortOrder: r.sortOrder }));
        const normalize = (rows: typeof items) => rows.map(r => ({ ...r, overrides: r.overrides ?? null, sortOrder: r.sortOrder ?? 0 })).sort((a, b) => a.monitorId.localeCompare(b.monitorId));
        if (canonical(normalize(items)) !== canonical(normalize(originalItems as typeof items)) || (inheritance !== 'replace' && inheritance !== (prior?.inheritance ?? 'cumulative'))) {
          throw new ConversionError('blocked', 'Monitor settings changed after conversion');
        }
        inheritance = prior?.inheritance ?? 'cumulative';
      }
      await tx.update(configPolicyFeatureLinks).set({ inlineSettings: { ...settings, inheritance, items: remaining.map(r => ({ monitorId: r.monitorId, enabled: r.enabled, overrides: r.overrides, sortOrder: r.sortOrder })) }, updatedAt: new Date() }).where(eq(configPolicyFeatureLinks.id, linkId));
    }
    await tx.update(monitorConversions).set({ revertedAt: new Date() }).where(eq(monitorConversions.id, current.id));
  }
  return pairs;
}
export async function revertConversion(conversionId: string, auth: AuthContext): Promise<void> {
  const pairs = await inCallerTransaction(auth, tx => revertInTx(conversionId, auth, tx));
  await rekeyCommittedCooldowns(pairs, 'back_to_config_policy');
}

async function validTemplateTarget(owner: Owner, target: NonNullable<ReturnType<typeof assignmentForRule>>, tx: DbExecutor) {
  if (target.level === 'partner') return owner.orgId === null && owner.partnerId === target.targetId;
  let orgId: string;
  if (target.level === 'organization') orgId = target.targetId;
  else {
    const table = target.level === 'site' ? sites : target.level === 'device_group' ? deviceGroups : devices;
    const [row] = await tx.select({ id: table.id, orgId: table.orgId }).from(table).where(eq(table.id, target.targetId)).limit(1);
    if (!row || row.id !== target.targetId) return false;
    orgId = row.orgId;
  }
  if (owner.orgId) return orgId === owner.orgId;
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return !!org && org.id === orgId && org.partnerId === owner.partnerId;
}

async function removeResponseContribution(tx: DbExecutor, ledger: typeof monitorConversions.$inferSelect,
  monitorId: string, revertingIds: string[], auth: AuthContext) {
  const added = ledger.sourceState.addedActions;
  if (!Array.isArray(added) || !added.length) return;
  // Reuse never transferred ownership of an existing definition's actions.
  if (ledger.sourceState.targetReusedMonitor === true) return;
  const surviving = await tx.select({ id: monitorConversionOutputs.id }).from(monitorConversionOutputs)
    .innerJoin(monitorConversions, eq(monitorConversions.id, monitorConversionOutputs.conversionId))
    .where(and(eq(monitorConversionOutputs.monitorId, monitorId), notInArray(monitorConversions.id, revertingIds), isNull(monitorConversions.revertedAt))).limit(1);
  if (surviving.length) return;
  const [monitor] = await tx.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, monitorId)).limit(1).for('update');
  if (!monitor) return;
  assertOwner(monitor, auth);
  const responses = [...monitor.responses];
  let start = -1;
  for (let i = responses.length - added.length;i >= 0;i--) if (canonical(responses.slice(i, i + added.length)) === canonical(added)) { start = i; break; }
  if (start < 0) throw new ConversionError('blocked', 'Response actions changed after conversion');
  responses.splice(start, added.length);
  const [updated] = await tx.update(monitorDefinitions).set({ responses, updatedAt: new Date() }).where(eq(monitorDefinitions.id, monitorId)).returning();
  if (!updated) throw new ConversionError('blocked', 'Response monitor unavailable');
  if (!('rollback' in tx)) throw new Error('Response reversal requires a transaction');
  await compileMonitorInTx(tx, updated);
}
