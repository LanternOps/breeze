/**
 * Free fix-memory attach (AI Suggested Fixes W1, spec P3): a PROVEN hit for a
 * new problem becomes a remediation_suggestions row with origin 'memory'. No
 * LLM, no cost. Broad signatures never auto-attach. W1 attaches script fixes
 * only (the only execution rail /execute has today). An existing untouched
 * ('suggested') keyword-matcher row for the same script is upgraded in place.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { remediationSuggestions } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { shouldProduceMlOutput } from '../mlFeatureFlags';
import { inSystemDbContext } from '../outcomeProbes';
import { resolveOrgPartnerId } from './catalog';
import { lookupFixes, type FixTrackRecord } from './lookup';
import { requestResearch } from './research';
import { signatureForSource, sourceRefFor } from './signatureLoader';

const ATTACH_LIMIT = 3;

export function memoryRationale(fix: Pick<FixTrackRecord, 'verified' | 'attempts' | 'scope'>): string {
  const where = fix.scope === 'all_clients' ? 'across your clients' : 'for this client';
  return `Proven fix: worked ${fix.verified} of ${fix.attempts} times ${where}.`;
}

export async function attachProvenFixes(input: {
  sourceType: 'alert' | 'anomaly' | 'correlation' | 'rca';
  sourceId: string;
  orgId: string;
}): Promise<number> {
  if (!(await shouldProduceMlOutput(input.orgId, 'ml.remediation_suggestions.enabled'))) return 0;
  const ref = sourceRefFor({ sourceType: input.sourceType, sourceId: input.sourceId });
  if (!ref) return 0;
  const resolved = await signatureForSource(ref);
  if (!resolved || resolved.signature.broad) return 0;
  const partnerId = await resolveOrgPartnerId(input.orgId);
  if (!partnerId) return 0;

  const { proven } = await lookupFixes({ orgId: input.orgId, partnerId, signature: resolved.signature, limit: ATTACH_LIMIT });
  let attached = 0;
  for (const fix of proven) {
    if (!fix.scriptId || !fix.scriptName) continue;
    const rationale = memoryRationale(fix);
    const evidence = {
      origin: 'memory', memoryId: fix.memoryId, scope: fix.scope, attempts: fix.attempts, verifiedCount: fix.verified,
      successRate: fix.successRate, lastVerifiedAt: fix.lastVerifiedAt, signatureVersion: resolved.signature.version,
    };
    const now = new Date();
    await db.insert(remediationSuggestions).values({
      orgId: input.orgId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      deviceId: resolved.deviceId,
      alertId: input.sourceType === 'alert' ? input.sourceId : null,
      anomalyId: input.sourceType === 'anomaly' ? input.sourceId : null,
      correlationGroupId: input.sourceType === 'correlation' ? input.sourceId : null,
      targetType: 'script',
      scriptId: fix.scriptId,
      title: fix.scriptName.slice(0, 255),
      rationale,
      expectedAction: `Run script "${fix.scriptName}" through the existing script execution flow.`,
      riskTier: 'medium',
      status: 'suggested',
      confidence: null,
      evidence,
      parameters: {},
      targetDeviceIds: [resolved.deviceId],
      origin: 'memory',
    }).onConflictDoUpdate({
      target: [remediationSuggestions.orgId, remediationSuggestions.sourceType, remediationSuggestions.sourceId, remediationSuggestions.scriptId],
      targetWhere: sql`target_type = 'script'`,
      set: { origin: 'memory', evidence, rationale, updatedAt: now },
      setWhere: sql`${remediationSuggestions.status} = 'suggested'`,
    });
    attached += 1;
  }
  return attached;
}

/** Durable subscriber 'fix-memory-attach' on alert.triggered (W1) + auto research (W2). */
export async function handleAlertTriggeredForFixMemory(event: BreezeEvent): Promise<void> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const alertId = typeof payload.alertId === 'string' ? payload.alertId : null;
  if (!alertId || !event.orgId) return;
  const attached = await inSystemDbContext(
    () => attachProvenFixes({ sourceType: 'alert', sourceId: alertId, orgId: event.orgId }),
    'fixMemory.attach',
  );
  // Spec P3: LLM research runs automatically only for high/critical severity when memory has no hit.
  // Dedupe, the per-org hourly cap and credits are requestResearch's job. A refusal is an answer, and a
  // research failure must never fail this durable subscriber (it would retry the already-done attach).
  const severity = typeof payload.severity === 'string' ? payload.severity : null;
  if (attached > 0 || (severity !== 'high' && severity !== 'critical')) return;
  try {
    const result = await inSystemDbContext(
      () => requestResearch({ orgId: event.orgId, sourceType: 'alert', sourceId: alertId, depth: 'quick', trigger: 'auto', actorUserId: null }),
      'fixMemory.autoResearch',
    );
    if (result.status === 'denied') {
      console.info('[fixMemory] auto research not started', { orgId: event.orgId, alertId, code: result.code });
    }
  } catch (err) {
    console.error('[fixMemory] auto research failed', { orgId: event.orgId, alertId, err });
  }
}
