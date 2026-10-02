/**
 * Per-partner AI model registry gate (W03 #7601 Task 6A; W08 #7606).
 *
 * W03 projected each partner from legacy config once. W08 deleted the
 * projection: a partner without its ai_model_registry_partner_cutover row now
 * gets a registry-native bootstrap (registryBootstrap.ts) in the same
 * transaction as the row, and the row means "this partner's registry rows
 * exist". Every entrypoint — the resolver, every registry write, agent model
 * binding, session creation, W06's env bootstrap — calls ensurePartnerCutover
 * first, so no boot sweep is needed and /health is never involved.
 */
import { captureException, captureMessage } from '../sentry';
import { bootstrapPartnerRegistryInTx, type BootstrapReport } from './registryBootstrap';
import { hasCutoverRow, withPartnerCutoverTx } from './registryCutoverStore';
import { carriesQueryValues, safeErrorMessage } from './safeDbError';

export type PartnerCutoverResult = 'done' | 'already';

/** A Drizzle/postgres error carries the statement's bound values: report only its safe fields. */
export function reportableCutoverError(error: unknown): unknown {
  return carriesQueryValues(error) ? new Error(`AI model registry bootstrap failed: ${safeErrorMessage(error)}`) : error;
}

function report(error: unknown, partnerId?: string): void {
  captureException(reportableCutoverError(error), undefined, {
    area: 'ai_model_registry_cutover',
    ...(partnerId ? { partnerId } : {}),
  });
}

function noteBootstrap(partnerId: string, r: BootstrapReport): void {
  if (r.destination === 'ambiguous') {
    captureException(new Error('AI registry: partner has several AI connections and no registry row; bootstrapped with no defaults (fail closed)'), undefined, {
      area: 'ai_model_registry_cutover', partnerId,
    });
    return;
  }
  if (r.destination === 'connection') {
    // Only a deployment that skipped the W03 cutover release gets here (its W02
    // migration copied a legacy key). Funding is kept; model choices made in the
    // legacy settings are not (W08b archives them).
    captureMessage('AI registry: partner bootstrapped onto its existing AI connection; legacy model settings were never migrated', {
      eventCode: 'ai_registry_bootstrap_existing_connection',
      tags: { partner_id: partnerId },
    });
  }
  if (r.offeringId === null) {
    console.warn(`[aiModels] partner ${partnerId} bootstrapped with no usable default model (${r.defaultModelId} has no platform row); an operator must price it on /admin/ai-models`);
  }
}

export async function cutoverPartner(
  partnerId: string,
  deps: { bootstrapInTx?: typeof bootstrapPartnerRegistryInTx } = {},
): Promise<PartnerCutoverResult> {
  // A holder object, not a `let`: TS does not track assignments made inside the callback.
  const outcome: { result: PartnerCutoverResult; report: BootstrapReport | null } = { result: 'already', report: null };
  await withPartnerCutoverTx(partnerId, async (exists) => {
    if (exists) return;
    outcome.report = await (deps.bootstrapInTx ?? bootstrapPartnerRegistryInTx)(partnerId);
    outcome.result = 'done';
  });
  // Reported after commit, so a rolled-back bootstrap never reports.
  if (outcome.report) noteBootstrap(partnerId, outcome.report);
  return outcome.result;
}

/** Partners known bootstrapped in this process. A row is never removed, so the memo cannot go stale. */
const cutOver = new Set<string>();

export function __resetRegistryCutoverMemoForTests(): void {
  cutOver.clear();
}

/** true once the partner's cutover row exists. */
export async function isPartnerCutOver(partnerId: string): Promise<boolean> {
  if (cutOver.has(partnerId)) return true;
  if (await hasCutoverRow(partnerId)) {
    cutOver.add(partnerId);
    return true;
  }
  return false;
}

/** The registry gate. false = the partner could not be bootstrapped now; the caller refuses (recoverable). */
export async function ensurePartnerCutover(partnerId: string): Promise<boolean> {
  try {
    if (await isPartnerCutOver(partnerId)) return true;
    await cutoverPartner(partnerId);
    cutOver.add(partnerId);
    return true;
  } catch (error) {
    report(error, partnerId);
    return false;
  }
}
