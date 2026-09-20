import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../../db';
import { escalationPolicies, organizations } from '../../../db/schema';
import type { AuthContext } from '../../../middleware/auth';
import { getMonitorConversionPreviewQueue, previewJobKey } from '../../../jobs/monitorConversionPreviewWorker';
import { getRedis } from '../../redis';
import { computeEquivalence } from './equivalence';
import { resolveDeviceIdsForPolicy, type DbExecutor } from './legacyBaseline';
import { loadPolicySources, type PolicySources } from './loadSources';
import { canonical, mapAutomationResponses, mapInlineRule, mapWatch, mergeResponseProposals, previewHash, sha, type MappingResult } from './mapping';
import { authorizePreview, previewFreshness, previewScopeHash, snapshotPreviewAccess } from './previewScope';
import { missingConversionPrerequisites } from './prerequisites';
import { EQUIVALENCE_JOB_THRESHOLD, type ConversionPreviewItem, type PolicyConversionPreview, type PolicyConversionPreviewPending } from './types';

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

export async function buildPolicyConversionPreview(policyId: string, ctx: { userId: string | null; auth: AuthContext }, opts?: { expectedFreshness?: string; onProgress?: (checked: number, total: number) => Promise<void> | void }): Promise<PolicyConversionPreview> {
  const snapshot = snapshotPreviewAccess(ctx.auth);
  return withDbAccessContext(snapshot.dbContext, async () => {
    await authorizePreview(policyId, ctx.auth);
    const scopeHash = previewScopeHash(snapshotPreviewAccess(ctx.auth));
    return db.transaction(async (tx) => {
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
      const append = (sourceTable: ConversionPreviewItem['sourceTable'], row: { id: string; name: string }, mapped: MappingResult) => {
        items.push({ sourceTable, sourceId: row.id, name: row.name, outcome: mapped.ok ? 'convertible' : 'unconvertible',
          ...(!mapped.ok ? { reason: mapped.reason } : {}), proposed: mapped.ok ? mapped.proposed : [], notes: mapped.notes,
          openAlerts: sources.openAlertsBySource.get(row.id) ?? 0 });
      };
      if (!blockedBy) {
        for (const row of sources.inlineRules) append('config_policy_alert_rules', row, mapInlineRule(row));
        for (const row of sources.watches) append('config_policy_monitoring_watches', row, mapWatch(row));
        for (const row of sources.policyAutomations) items.push({ sourceTable: 'config_policy_automations', sourceId: row.id,
          name: row.name, outcome: 'convertible', proposed: [], notes: [], openAlerts: 0,
          workflow: { policyId, sourceId: row.id, name: row.name, enabled: row.enabled, actions: Array.isArray(row.actions) ? row.actions : [], onFailure: row.onFailure } });
        for (const row of [...sources.standaloneAutomations].sort((a, b) => a.id.localeCompare(b.id))) {
          const target = (row.trigger as { filter?: { configPolicyAlertRuleId?: string } }).filter?.configPolicyAlertRuleId;
          const mapped = mapAutomationResponses(row);
          items.push({ sourceTable: 'automations', sourceId: row.id, name: row.name,
            outcome: row.enabled && target ? 'convertible' : 'unconvertible', proposed: [], notes: mapped.notes, openAlerts: 0,
            ...(row.enabled && target ? { responseTargetSourceId: target, responseActions: mapped.actions }
              : { reason: row.enabled ? 'unconvertible:target_unconvertible' : 'unconvertible:disabled_response_automation' }) });
        }
        for (const item of items) for (const monitor of item.proposed) {
          if (monitor.escalationPolicyId && !await compatibleEscalation(monitor.escalationPolicyId, sources.policy, tx)) {
            item.outcome = 'unconvertible'; item.reason = 'unconvertible:escalation_policy_axis'; item.proposed = []; break;
          }
        }
      }
      const merged = mergeResponseProposals(items);
      const ids = blockedBy ? [] : await resolveDeviceIdsForPolicy(policyId, tx);
      const equivalence = blockedBy ? { devicesChecked: 0, deltas: [] } : await computeEquivalence({ policy: sources.policy, inheritanceMode,
        bySource: merged.filter((item) => item.outcome === 'convertible').map((item) => ({ sourceTable: item.sourceTable, sourceId: item.sourceId,
          monitors: item.proposed, workflow: item.workflow, responseTargetSourceId: item.responseTargetSourceId })),
      }, ids, ctx.auth, opts?.onProgress, tx);
      // Staging must leave the snapshot unchanged after its rollback.
      if (await previewFreshness(policyId, tx) !== freshness) throw new ConversionError('preview_stale', 'Preview inputs changed');
      return { policyId, items: merged, inheritanceMode, equivalence,
        previewHash: sha(canonical({ proposal: previewHash({ policyId, items: merged, inheritanceMode }), scopeHash, freshness })),
        ...(blockedBy ? { blockedBy } : {}), ...(missing.length ? { missingPrerequisites: missing } : {}) };
    });
  }, { isolationLevel: 'repeatable read' });
}

export async function previewPolicyConversion(policyId: string, auth: AuthContext, opts?: { mode?: 'auto' | 'inline' }): Promise<PolicyConversionPreview | PolicyConversionPreviewPending> {
  await authorizePreview(policyId, auth);
  const ids = await resolveDeviceIdsForPolicy(policyId, db);
  if (opts?.mode === 'inline' || ids.length <= EQUIVALENCE_JOB_THRESHOLD) {
    return buildPolicyConversionPreview(policyId, { userId: auth.scope === 'system' ? null : auth.user.id, auth });
  }
  const snapshot = snapshotPreviewAccess(auth);
  const scopeHash = previewScopeHash(snapshot);
  const sourcesHash = await previewFreshness(policyId, db);
  const key = previewJobKey(policyId, scopeHash, sourcesHash);
  const redis = getRedis();
  if (!redis) throw new Error('Preview requires Redis');
  const raw = await redis.get(key);
  if (raw) {
    try {
      const cached = JSON.parse(raw) as { status?: string; scopeHash?: string; sourcesHash?: string; result?: PolicyConversionPreview; progress?: { checked: number; total: number } };
      if (cached.scopeHash === scopeHash && cached.sourcesHash === sourcesHash) {
        if (cached.status === 'done' && cached.result) return cached.result;
        if (cached.status === 'running' && cached.progress) return { status: 'running', progress: cached.progress };
      }
    } catch { /* A malformed cache entry is recomputed from authorized current inputs. */ }
  }
  await runOutsideDbContext(() => getMonitorConversionPreviewQueue().add('preview', { policyId, snapshot, scopeHash, sourcesHash },
    { jobId: sha(key), removeOnComplete: true, removeOnFail: true }));
  return { status: 'running', progress: { checked: 0, total: ids.length } };
}
