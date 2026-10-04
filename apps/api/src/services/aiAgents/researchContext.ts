// apps/api/src/services/aiAgents/researchContext.ts
/**
 * AI Suggested Fixes W2 — everything a remediation_research run knows,
 * assembled by the SERVER at context load (runLoop.loadRunContext, system
 * scope). The same data is (a) rendered into the task prompt and (b) turned
 * into the `ResearchToolRefs` submit_suggestions validates against, so the
 * model can never be told about a script the validator would reject, and vice
 * versa. Catalog visibility is W1's explicit app-layer condition
 * (system / own-partner partner-wide / own-org, OS-filtered).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { ResearchDepth } from '@breeze/shared';
import { db } from '../../db';
import { alertCorrelationGroups, alerts, devices, metricAnomalies, scripts } from '../../db/schema';
import { listCatalogPlaybooks, listCatalogScripts, resolveOrgPartnerId, scriptVisibilityCondition } from '../fixMemory/catalog';
import { lookupFixes, type FixTrackRecord } from '../fixMemory/lookup';
import { isFixOsFamily, type FixOsFamily } from '../fixMemory/signature';
import { signatureForSource, sourceRefFor } from '../fixMemory/signatureLoader';
import { researchDepthOf } from './researchProfile';
import { cleanupActionsForOs, type ResearchToolRefs } from './researchSubmission';

export const RESEARCH_CATALOG_PROMPT_LIMIT = 60;
const RESEARCH_REF_ID_LIMIT = 2000;

type SourceType = 'alert' | 'anomaly' | 'correlation';

export interface ResearchRunContext {
  depth: ResearchDepth;
  source: { sourceType: SourceType; sourceId: string; title: string | null; severity: string | null; message: string | null };
  device: { id: string; hostname: string; osType: FixOsFamily };
  signature: { family: string; condition: string; discriminatorKind: string | null; broad: boolean } | null;
  memory: { proven: FixTrackRecord[]; similar: FixTrackRecord[] } | null;
  catalog: {
    scripts: Array<{ id: string; name: string; description: string | null }>;
    playbooks: Array<{ id: string; name: string; description: string | null }>;
    cleanupActionIds: string[];
  };
  refs: ResearchToolRefs;
}

export class ResearchContextUnavailableError extends Error {
  constructor(readonly code: 'research_device_unavailable' | 'research_source_unavailable', message: string) {
    super(message);
    this.name = 'ResearchContextUnavailableError';
  }
}

function isSourceType(v: unknown): v is SourceType {
  return v === 'alert' || v === 'anomaly' || v === 'correlation';
}

async function loadSourceText(orgId: string, sourceType: SourceType, sourceId: string) {
  if (sourceType === 'anomaly') {
    const [a] = await db.select({ metricName: metricAnomalies.metricName, anomalyType: metricAnomalies.anomalyType })
      .from(metricAnomalies).where(and(eq(metricAnomalies.id, sourceId), eq(metricAnomalies.orgId, orgId))).limit(1);
    return a ? { title: `${a.anomalyType} anomaly on ${a.metricName}`, severity: null, message: null } : null;
  }
  if (sourceType === 'correlation') {
    // Org-scoped existence check: a foreign or deleted group is "gone".
    const [g] = await db.select({ id: alertCorrelationGroups.id }).from(alertCorrelationGroups)
      .where(and(eq(alertCorrelationGroups.id, sourceId), eq(alertCorrelationGroups.orgId, orgId))).limit(1);
    return g ? { title: 'Correlated alert group (root alert)', severity: null, message: null } : null;
  }
  const [row] = await db.select({ title: alerts.title, severity: alerts.severity, message: alerts.message })
    .from(alerts).where(and(eq(alerts.id, sourceId), eq(alerts.orgId, orgId))).limit(1);
  return row ?? null;
}

export async function loadResearchContext(input: {
  orgId: string; partnerId: string; deviceId: string; triggerRef: Record<string, unknown>;
}): Promise<ResearchRunContext> {
  // Never trust a caller-supplied partner id: system scope has no RLS
  // backstop, so a stale/wrong one would expose another partner's partner-wide
  // scripts and memory. Derive it from the org and require agreement.
  const partnerId = await resolveOrgPartnerId(input.orgId);
  if (!partnerId || partnerId !== input.partnerId) {
    throw new ResearchContextUnavailableError('research_device_unavailable', `partner mismatch for org ${input.orgId}`);
  }
  const [device] = await db.select({ id: devices.id, hostname: devices.hostname, osType: devices.osType })
    .from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.orgId, input.orgId))).limit(1);
  if (!device || !isFixOsFamily(device.osType)) {
    throw new ResearchContextUnavailableError('research_device_unavailable', `device ${input.deviceId} is not a supported device in org ${input.orgId}`);
  }
  const osType = device.osType as FixOsFamily;
  const sourceType = input.triggerRef.sourceType;
  const sourceId = input.triggerRef.sourceId;
  if (!isSourceType(sourceType) || typeof sourceId !== 'string') {
    throw new ResearchContextUnavailableError('research_source_unavailable', 'research run has no usable source reference');
  }
  const text = await loadSourceText(input.orgId, sourceType, sourceId);
  if (!text) throw new ResearchContextUnavailableError('research_source_unavailable', `source ${sourceType}:${sourceId} is gone`);

  const ref = sourceRefFor({ sourceType, sourceId });
  const resolved = ref ? await signatureForSource(ref) : null;
  if (resolved && resolved.deviceId !== device.id) {
    throw new ResearchContextUnavailableError('research_source_unavailable', `source ${sourceType}:${sourceId} belongs to a different device`);
  }
  const memory = resolved
    ? await lookupFixes({ orgId: input.orgId, partnerId, signature: resolved.signature, limit: 5 })
    : null;

  const catalogCtx = { orgId: input.orgId, partnerId, deviceOs: osType };
  const [scriptRows, playbookRows, osIds, anyOsIds] = await Promise.all([
    listCatalogScripts(catalogCtx, RESEARCH_CATALOG_PROMPT_LIMIT),
    listCatalogPlaybooks(catalogCtx, RESEARCH_REF_ID_LIMIT),
    db.select({ id: scripts.id }).from(scripts).where(scriptVisibilityCondition(catalogCtx)).orderBy(desc(scripts.updatedAt), scripts.id).limit(RESEARCH_REF_ID_LIMIT),
    db.select({ id: scripts.id }).from(scripts).where(scriptVisibilityCondition({ ...catalogCtx, deviceOs: null })).orderBy(desc(scripts.updatedAt), scripts.id).limit(RESEARCH_REF_ID_LIMIT),
  ]);
  const cleanup = cleanupActionsForOs(osType);
  // Every script shown in the prompt is validator-visible, and the OS-matched
  // set is always a subset of the any-OS set, whatever the 2000 cap truncated.
  const scriptIds = new Set([...osIds.map((r) => r.id), ...scriptRows.map((s) => s.id)]);
  const scriptIdsAnyOs = new Set([...anyOsIds.map((r) => r.id), ...scriptIds]);

  return {
    depth: researchDepthOf(input.triggerRef),
    source: { sourceType, sourceId, ...text },
    device: { id: device.id, hostname: device.hostname, osType },
    signature: resolved
      ? {
        family: resolved.signature.facets.family, condition: resolved.signature.facets.condition,
        discriminatorKind: resolved.signature.facets.discriminator?.kind ?? null, broad: resolved.signature.broad,
      }
      : null,
    memory: memory ? { proven: memory.proven, similar: memory.similar } : null,
    catalog: {
      scripts: scriptRows.map((s) => ({ id: s.id, name: s.name, description: s.description ?? null })),
      playbooks: playbookRows.slice(0, RESEARCH_CATALOG_PROMPT_LIMIT).map((p) => ({ id: p.id, name: p.name, description: p.description ?? null })),
      cleanupActionIds: [...cleanup],
    },
    refs: {
      deviceOs: osType,
      scriptIds,
      scriptIdsAnyOs,
      playbookIds: new Set(playbookRows.map((p) => p.id)),
    },
  };
}
