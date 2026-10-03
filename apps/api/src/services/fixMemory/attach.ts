/**
 * Free fix-memory attach (AI Suggested Fixes W1, spec P3): a PROVEN hit for a
 * new problem becomes a remediation_suggestions row with origin 'memory'. No
 * LLM, no cost. Broad signatures never auto-attach. Script, built-in
 * (params derived from the signature's structured discriminator; disk_cleanup
 * never) and reviewed-steps fixes attach. An existing untouched
 * ('suggested') keyword-matcher row for the same script is upgraded in place.
 */
import { sql } from 'drizzle-orm';
import type { ResearchBuiltinAction } from '@breeze/shared';
import { db } from '../../db';
import { remediationSuggestions } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { captureException } from '../sentry';
import { shouldProduceMlOutput } from '../mlFeatureFlags';
import { inSystemDbContext } from '../outcomeProbes';
import { clampBuiltinRisk } from './builtinRisk';
import { resolveOrgPartnerId } from './catalog';
import { builtinParamsFromSignature, loadActiveInstructions } from './instructions';
import { lookupFixes, type FixTrackRecord } from './lookup';
import { requestResearch } from './research';
import { signatureForSource, sourceRefFor, type ResolvedFixSource } from './signatureLoader';

const ATTACH_LIMIT = 3;

export function memoryRationale(fix: Pick<FixTrackRecord, 'verified' | 'attempts' | 'scope'>): string {
  const where = fix.scope === 'all_clients' ? 'across your clients' : 'for this client';
  return `Proven fix: worked ${fix.verified} of ${fix.attempts} times ${where}.`;
}

type Insert = typeof remediationSuggestions.$inferInsert;
type AttachInput = { sourceType: 'alert' | 'anomaly' | 'correlation' | 'rca'; sourceId: string; orgId: string };

/** One memory-origin row per proven fix kind; null = proven but not attachable runnable (still counts as proven). */
async function memorySuggestionValues(fix: FixTrackRecord, resolved: ResolvedFixSource, input: AttachInput): Promise<Insert | null> {
  const common = {
    orgId: input.orgId, sourceType: input.sourceType, sourceId: input.sourceId, deviceId: resolved.deviceId,
    alertId: input.sourceType === 'alert' ? input.sourceId : null,
    anomalyId: input.sourceType === 'anomaly' ? input.sourceId : null,
    correlationGroupId: input.sourceType === 'correlation' ? input.sourceId : null,
    rationale: memoryRationale(fix), status: 'suggested' as const, confidence: null, origin: 'memory' as const,
    targetDeviceIds: [resolved.deviceId],
    evidence: {
      origin: 'memory', memoryId: fix.memoryId, scope: fix.scope, attempts: fix.attempts, verifiedCount: fix.verified,
      successRate: fix.successRate, lastVerifiedAt: fix.lastVerifiedAt, signatureVersion: resolved.signature.version,
    },
  };
  if (fix.scriptId && fix.scriptName) {
    return {
      ...common, targetType: 'script', scriptId: fix.scriptId, title: fix.scriptName.slice(0, 255), riskTier: 'medium', parameters: {},
      expectedAction: `Run script "${fix.scriptName}" through the existing script execution flow.`,
    };
  }
  if (fix.fixKind === 'builtin_action' && fix.builtinAction) {
    const action = fix.builtinAction as ResearchBuiltinAction;
    const params = builtinParamsFromSignature(action, resolved.signature.facets.discriminator);
    if (!params) return null;
    const label = action.replace('_', ' ');
    return {
      ...common, targetType: 'builtin_action', builtinAction: action, parameters: params, riskTier: clampBuiltinRisk(action, 'low'),
      title: `Built-in: ${label}`, expectedAction: `Run the built-in ${label} action on this device.`,
    };
  }
  if (fix.fixKind === 'manual_steps' && fix.instructionsRef) {
    const reviewed = await loadActiveInstructions(fix.instructionsRef);
    if (!reviewed) return null;
    return {
      ...common, targetType: 'manual_steps', instructionsId: reviewed.id, parameters: { steps: reviewed.steps }, riskTier: 'low',
      title: reviewed.title, expectedAction: reviewed.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'),
    };
  }
  return null;
}

async function insertMemorySuggestion(values: Insert): Promise<void> {
  const q = db.insert(remediationSuggestions).values(values);
  if (values.targetType === 'script') {
    // W1's upgrade-in-place for an untouched matcher row of the same script.
    await q.onConflictDoUpdate({
      target: [remediationSuggestions.orgId, remediationSuggestions.sourceType, remediationSuggestions.sourceId, remediationSuggestions.scriptId],
      targetWhere: sql`target_type = 'script'`,
      set: { origin: 'memory', evidence: values.evidence, rationale: values.rationale, updatedAt: new Date() },
      setWhere: sql`${remediationSuggestions.status} = 'suggested'`,
    });
    return;
  }
  // Built-in / reviewed-steps memory rows: one per source + action / + reviewed row (partial unique indexes,
  // 2026-12-07-100200: origin <> 'ai_research'). A bare ON CONFLICT DO NOTHING matches either index.
  await q.onConflictDoNothing();
}

export async function attachProvenFixes(input: AttachInput): Promise<{ proven: number; attached: number }> {
  const none = { proven: 0, attached: 0 };
  if (!(await shouldProduceMlOutput(input.orgId, 'ml.remediation_suggestions.enabled'))) return none;
  const ref = sourceRefFor({ sourceType: input.sourceType, sourceId: input.sourceId });
  if (!ref) return none;
  const resolved = await signatureForSource(ref);
  if (!resolved || resolved.signature.broad) return none;
  const partnerId = await resolveOrgPartnerId(input.orgId);
  if (!partnerId) return none;

  const { proven } = await lookupFixes({ orgId: input.orgId, partnerId, signature: resolved.signature, limit: ATTACH_LIMIT });
  let attached = 0;
  for (const fix of proven) {
    const values = await memorySuggestionValues(fix, resolved, input);
    if (!values) continue;
    await insertMemorySuggestion(values);
    attached += 1;
  }
  return { proven: proven.length, attached };
}

/** Durable subscriber 'fix-memory-attach' on alert.triggered (W1) + auto research (W2). */
export async function handleAlertTriggeredForFixMemory(event: BreezeEvent): Promise<void> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const alertId = typeof payload.alertId === 'string' ? payload.alertId : null;
  if (!alertId || !event.orgId) return;
  const { proven } = await inSystemDbContext(
    () => attachProvenFixes({ sourceType: 'alert', sourceId: alertId, orgId: event.orgId }),
    'fixMemory.attach',
  );
  // Spec P3: LLM research runs automatically only for high/critical severity when memory has NO proven fix (a proven non-script fix still counts).
  // Dedupe, the per-org hourly cap and credits are requestResearch's job. A refusal is an answer, and a
  // research failure must never fail this durable subscriber (it would retry the already-done attach).
  const severity = typeof payload.severity === 'string' ? payload.severity : null;
  if (proven > 0 || (severity !== 'high' && severity !== 'critical')) return;
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
    captureException(err, undefined, { component: 'fixMemory.autoResearch' });
  }
}
