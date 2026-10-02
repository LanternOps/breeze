/**
 * The invocation ledger (#7600, spec §5.5). recordInvocation inserts one
 * append-only row in the caller's context. In W02 the only producer is the
 * SHADOW listener below: it re-prices every legacy cost record with the
 * registry (priceInvocation) and logs a structured diff — it never feeds
 * billing, budgets or credits. W03 makes recordInvocation the cost path.
 */
import { eq } from 'drizzle-orm';
import type { AiSurface, ModelRates, OfferingOptions } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runAfterDbContextExit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiInvocations, aiSessions, organizations } from '../../db/schema';
import { captureException } from '../sentry';
import { throttledReporter } from '../sentryThrottle';
import { getCompatConnection } from './connections';
import { onLegacyCostRecorded, type LegacyCostEvent } from './legacyCostEvents';
import { findOfferingIdForModel, getOffering, type Offering } from './offerings';
import { getPlatformModelByModelId, type PlatformModel } from './platformModels';
import { platformRateSnapshot, priceInvocation, type RateSnapshot, type TokenComponents } from './pricing';
import { errorSqlstate, safeErrorMessage } from './safeDbError';

export interface NewInvocation {
  orgId: string;
  surface: AiSurface;
  role?: string;
  userId?: string | null;
  sessionId?: string | null;
  agentRunId?: string | null;
  sourceRef?: string | null;
  offeringId?: string | null;
  connectionId?: string | null;
  fundingSource: 'platform' | 'partner_key';
  requestedModel: string;
  servedModel: string;
  optionsSent?: OfferingOptions;
  thinkingModeSent?: 'adaptive' | 'budget' | 'none' | 'unknown' | null;
  inferenceGeoSent?: string | null;
  stopReason?: string | null;
  refusalCategory?: string | null;
  fallbackUsed?: boolean;
  catalogRevisionId?: string | null;
  connectionConfigVersion?: number | null;
  tokens: TokenComponents;
  rateSnapshot: RateSnapshot | null;
  costCents: number | null;
  chargeable?: boolean;
  sdkReportedCostUsd?: number | null;
  ledgerMode: 'shadow' | 'authoritative';
  legacyCostCents?: number | null;
}

export async function recordInvocation(row: NewInvocation): Promise<string> {
  const [inserted] = await db.insert(aiInvocations).values({
    orgId: row.orgId,
    surface: row.surface,
    role: row.role ?? 'default',
    userId: row.userId ?? null,
    sessionId: row.sessionId ?? null,
    agentRunId: row.agentRunId ?? null,
    sourceRef: row.sourceRef ?? null,
    offeringId: row.offeringId ?? null,
    connectionId: row.connectionId ?? null,
    fundingSource: row.fundingSource,
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    optionsSent: (row.optionsSent ?? {}) as Record<string, unknown>,
    thinkingModeSent: row.thinkingModeSent ?? null,
    inferenceGeoSent: row.inferenceGeoSent ?? null,
    stopReason: row.stopReason ?? null,
    refusalCategory: row.refusalCategory ?? null,
    fallbackUsed: row.fallbackUsed ?? false,
    catalogRevisionId: row.catalogRevisionId ?? null,
    connectionConfigVersion: row.connectionConfigVersion ?? null,
    inputTokens: row.tokens.input,
    outputTokens: row.tokens.output,
    cacheReadTokens: row.tokens.cacheRead,
    cacheWriteTokens: row.tokens.cacheWrite,
    rateSnapshot: row.rateSnapshot as unknown as Record<string, unknown> | null,
    costCents: row.costCents,
    chargeable: row.chargeable ?? false,
    sdkReportedCostUsd: row.sdkReportedCostUsd ?? null,
    ledgerMode: row.ledgerMode,
    legacyCostCents: row.ledgerMode === 'shadow' ? row.legacyCostCents ?? null : null,
  }).returning({ id: aiInvocations.id });
  return inserted!.id;
}

export function surfaceFromSession(row: { type: string; clientUserId: string | null; contextSnapshot: unknown }): AiSurface {
  if (row.type === 'script_builder') return 'script_builder';
  if (row.clientUserId !== null || row.type.endsWith('_client')) return 'office_chat';
  if (row.type === 'agent') return 'ai_agents';
  const snapshot = row.contextSnapshot as { source?: unknown } | null;
  if (snapshot && snapshot.source === 'helper') return 'helper';
  return 'chat';
}

const ownRates = (o: Pick<Offering, 'priceInputCentsPerM' | 'priceOutputCentsPerM' | 'priceCacheReadCentsPerM' | 'priceCacheWriteCentsPerM'>): ModelRates | null =>
  [o.priceInputCentsPerM, o.priceOutputCentsPerM, o.priceCacheReadCentsPerM, o.priceCacheWriteCentsPerM].every((v) => v !== null && v !== undefined)
    ? { inputCentsPerM: Number(o.priceInputCentsPerM), outputCentsPerM: Number(o.priceOutputCentsPerM), cacheReadCentsPerM: Number(o.priceCacheReadCentsPerM), cacheWriteCentsPerM: Number(o.priceCacheWriteCentsPerM) }
    : null;

/** Spec §8 precedence. Platform traffic is priced ONLY from the platform row (invariant 5). */
export function buildShadowRateSnapshot(input: {
  funding: 'platform' | 'partner_key';
  catalogPricing: LegacyCostEvent['catalogPricing'];
  platformModel: Pick<PlatformModel, 'rates' | 'optionRates'> | null;
  offering: Pick<Offering, 'priceInputCentsPerM' | 'priceOutputCentsPerM' | 'priceCacheReadCentsPerM' | 'priceCacheWriteCentsPerM' | 'platformModelId'> | null;
  linkedPlatformModel: Pick<PlatformModel, 'rates' | 'optionRates'> | null;
}): RateSnapshot | null {
  if (input.catalogPricing) {
    const { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM } = input.catalogPricing;
    return { source: 'catalog', standard: { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM } };
  }
  if (input.funding === 'platform') {
    return input.platformModel ? platformRateSnapshot(input.platformModel) : null;
  }
  if (input.offering) {
    const own = ownRates(input.offering);
    if (own) return { source: 'offering', standard: own };
    const linked = input.linkedPlatformModel ? platformRateSnapshot(input.linkedPlatformModel) : null;
    if (linked) return { ...linked, source: 'linked_platform' };
  }
  return null;
}

export function shadowCostDiff(ledgerCents: number | null, legacyTokenCents: number): { differs: boolean; reason: 'unpriced' | 'price_mismatch' | null; deltaCents: number | null } {
  if (ledgerCents === null) return { differs: true, reason: 'unpriced', deltaCents: null };
  const delta = Math.round((ledgerCents - legacyTokenCents) * 100) / 100;
  return Math.abs(delta) >= 0.01 ? { differs: true, reason: 'price_mismatch', deltaCents: delta } : { differs: false, reason: null, deltaCents: delta };
}

const warnedMissingContext = new Set<string>();

export async function recordShadowInvocation(event: LegacyCostEvent): Promise<'written' | 'skipped_no_context' | 'skipped_zero'> {
  if (getCurrentDbAccessContext()?.scope !== 'system') throw new Error('recordShadowInvocation requires a held system DB context');
  const t = event.tokens;
  if (t.input + t.output + t.cacheRead + t.cacheWrite === 0 && event.legacyCostCents === 0) return 'skipped_zero';

  let surface = event.ledger?.surface ?? null;
  let userId = event.ledger?.userId ?? null;
  let model = event.model;
  if (event.sessionId) {
    const [session] = await db
      .select({ type: aiSessions.type, clientUserId: aiSessions.clientUserId, contextSnapshot: aiSessions.contextSnapshot, userId: aiSessions.userId, model: aiSessions.model })
      .from(aiSessions).where(eq(aiSessions.id, event.sessionId)).limit(1);
    if (session) {
      surface ??= surfaceFromSession(session);
      userId ??= session.userId ?? null;
      model ??= session.model;
    }
  }
  if (!surface || !model) {
    const key = `${surface ?? 'no-surface'}:${event.legacyCostSource}`;
    if (!warnedMissingContext.has(key)) {
      warnedMissingContext.add(key);
      console.warn(`[ai-ledger] ai_invocation_ledger_context_missing ${JSON.stringify({ orgId: event.orgId, source: event.legacyCostSource })}`);
    }
    return 'skipped_no_context';
  }

  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, event.orgId)).limit(1);
  if (!org?.partnerId) throw new Error(`organization ${event.orgId} has no partner`);

  const connection = event.billingSource === 'partner_key' ? await getCompatConnection(org.partnerId) : null;
  const offeringId = event.billingSource === 'platform' || connection
    ? await findOfferingIdForModel({ partnerId: org.partnerId, connectionId: connection?.id ?? null, modelId: model })
    : null;
  const offering = offeringId && event.billingSource === 'partner_key' ? await getOffering(offeringId) : null;
  const platformModel = event.billingSource === 'platform' ? await getPlatformModelByModelId(model) : null;
  const linkedPlatformModel = offering?.platformModelId ? await getPlatformModelByModelId(model) : null;

  const rateSnapshot = buildShadowRateSnapshot({ funding: event.billingSource, catalogPricing: event.catalogPricing, platformModel, offering, linkedPlatformModel });
  const costCents = rateSnapshot ? priceInvocation(rateSnapshot, t, {}) : null;

  await recordInvocation({
    orgId: event.orgId,
    surface,
    role: event.ledger?.role,
    userId,
    sessionId: event.sessionId,
    agentRunId: event.ledger?.agentRunId ?? null,
    sourceRef: event.ledger?.sourceRef ?? null,
    offeringId,
    connectionId: connection?.id ?? null,
    fundingSource: event.billingSource,
    requestedModel: model,
    servedModel: model,
    catalogRevisionId: event.catalogPricing?.revisionId ?? null,
    connectionConfigVersion: connection?.configVersion ?? null,
    tokens: t,
    rateSnapshot,
    costCents,
    sdkReportedCostUsd: event.sdkReportedCostUsd,
    ledgerMode: 'shadow',
    legacyCostCents: event.legacyCostCents,
  });

  const diff = shadowCostDiff(costCents, event.legacyCostCents);
  // The env OpenAI-compatible path (MCP_LLM_*) has no registry offering until
  // W06, so every one of its rows is unpriced by design: record it, don't log it.
  if (diff.differs && event.legacyCostSource !== 'openai_env') {
    console.warn(JSON.stringify({
      event: 'ai_invocation_shadow_cost_diff',
      reason: diff.reason,
      surface,
      orgId: event.orgId,
      model,
      fundingSource: event.billingSource,
      offeringId,
      rateSource: rateSnapshot?.source ?? null,
      legacySource: event.legacyCostSource,
      legacyCents: event.legacyCostCents,
      legacyAdditionalCents: event.legacyAdditionalCostCents,
      ledgerCents: costCents,
      deltaCents: diff.deltaCents,
    }));
  }
  return 'written';
}

/** A shadow-write failure reduced to what is safe to log (the shared scrubber: safeDbError.ts). */
function shadowFailure(error: unknown): Error & { code?: string } {
  const safe: Error & { code?: string } = new Error(safeErrorMessage(error));
  safe.name = 'AiInvocationShadowError';
  const code = errorSqlstate(error);
  if (code) safe.code = code;
  return safe;
}

type ShadowOutcome = 'written' | 'failed' | 'skipped_no_context' | 'skipped_zero';
const SHADOW_FAILURE_REPORT_WINDOW_MS = 60_000;
const shadowCounters: Record<ShadowOutcome, number> = { written: 0, failed: 0, skipped_no_context: 0, skipped_zero: 0 };
/** One reporter per fingerprint: the first failure, then at most one per window. */
const shadowFailureReporters = new Map<string, { latest: { orgId: string; safe: Error }; report: () => void }>();

/** Process-lifetime counts of shadow outcomes (they never feed billing). */
export function getInvocationLedgerShadowCounters(): Readonly<Record<ShadowOutcome, number>> {
  return { ...shadowCounters };
}

/**
 * A shadow-write failure is logged and sent to Sentry THROTTLED: a broken
 * ledger fails on every AI call, and an unthrottled capture would turn one
 * fault into a storm. The fingerprint is fixed + the SQLSTATE (bounded), so
 * Sentry groups every occurrence into one issue per cause.
 */
function reportShadowFailure(orgId: string, error: unknown): void {
  const safe = shadowFailure(error);
  const fingerprint = ['ai_invocation_shadow', safe.code ?? 'unknown'];
  const key = fingerprint.join(':');
  let entry = shadowFailureReporters.get(key);
  if (!entry) {
    const created: { latest: { orgId: string; safe: Error }; report: () => void } = {
      latest: { orgId, safe },
      report: throttledReporter(SHADOW_FAILURE_REPORT_WINDOW_MS, (suppressedSinceLastReport) => {
        const { orgId: latestOrgId, safe: latestSafe } = created.latest;
        console.error('[ai-ledger] ai_invocation_shadow_failed (billing unaffected)', {
          orgId: latestOrgId,
          error: latestSafe.message,
          sqlstate: fingerprint[1],
          suppressedSinceLastReport,
          counters: getInvocationLedgerShadowCounters(),
        });
        captureException(latestSafe, undefined, { area: 'ai_invocation_shadow' }, { fingerprint });
      }),
    };
    entry = created;
    shadowFailureReporters.set(key, entry);
  }
  entry.latest = { orgId, safe };
  entry.report();
}

let registered = false;

/** Call once per process at boot (API index.ts, worker.ts). Idempotent. */
export function registerInvocationLedgerShadow(): void {
  if (registered) return;
  registered = true;
  onLegacyCostRecorded((event) => {
    runAfterDbContextExit('aiInvocationLedger.shadow', async () => {
      try {
        const outcome = await runOutsideDbContext(() => withSystemDbAccessContext(() => recordShadowInvocation(event), 'aiInvocationLedger.shadow'));
        shadowCounters[outcome] += 1;
      } catch (error) {
        shadowCounters.failed += 1;
        reportShadowFailure(event.orgId, error);
      }
    });
  });
}

export function __resetInvocationLedgerShadowForTests(): void {
  registered = false;
  shadowFailureReporters.clear();
  for (const k of Object.keys(shadowCounters) as ShadowOutcome[]) shadowCounters[k] = 0;
}
