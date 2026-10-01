/**
 * Dependency-free bridge from a legacy cost path to the invocation ledger
 * (#7600 W02). Listeners are registered only at process boot
 * (registerInvocationLedgerShadow), so a unit test that does not boot sees
 * no listener. emit never throws.
 *
 * W03 Task 17 deleted the cost tracker's recorders, so the ONLY remaining
 * emitter is the env-only OpenAI-compatible chat path
 * (llm/openaiSessionManager.ts), which W06 moves onto resolveModel /
 * settleInvocation. W06 deletes this file and the shadow listener with it.
 */
import type { AiSurface } from '@breeze/shared';
import type { AiBillingSource, CatalogPricingSnapshot } from '../aiCostTracker';
import { safeErrorMessage } from './safeDbError';

export interface InvocationLedgerContext {
  surface: AiSurface;
  role?: string;
  userId?: string | null;
  agentRunId?: string | null;
  sourceRef?: string | null;
}

export interface LegacyCostEvent {
  orgId: string;
  sessionId: string | null;
  /** null when the tracker priced from the SDK and never needed the id; the listener reads the session's model. */
  model: string | null;
  billingSource: AiBillingSource;
  catalogPricing: CatalogPricingSnapshot | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The token part of the legacy cost, in cents. */
  legacyCostCents: number;
  /** Non-token legacy cost on the same record (e.g. web-search fees), cents. */
  legacyAdditionalCostCents: number;
  legacyCostSource: 'sdk' | 'model_pricing' | 'catalog' | 'precomputed' | 'openai_env';
  sdkReportedCostUsd: number | null;
  ledger: InvocationLedgerContext | null;
}

type Listener = (event: LegacyCostEvent) => void;
const listeners = new Set<Listener>();

export function onLegacyCostRecorded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitLegacyCostRecorded(event: LegacyCostEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      // Message only, scrubbed: a raw query error carries its SQL params.
      console.error('[ai-ledger] legacy cost listener threw (ignored; billing unaffected):', safeErrorMessage(error));
    }
  }
}

export function __resetLegacyCostListenersForTests(): void {
  listeners.clear();
}
