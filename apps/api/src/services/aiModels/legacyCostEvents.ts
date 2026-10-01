/**
 * Dependency-free bridge from the legacy cost tracker to the invocation
 * ledger (#7600 W02). aiCostTracker emits AFTER it has computed the legacy
 * cost; listeners are registered only at process boot
 * (registerInvocationLedgerShadow), so every unit test that exercises the
 * tracker without booting sees exactly today's behaviour. emit never throws.
 * W03 deletes this file when the ledger becomes the cost path.
 */
import type { AiSurface } from '@breeze/shared';
import type { AiBillingSource, CatalogPricingSnapshot } from '../aiCostTracker';

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
      console.error('[ai-ledger] legacy cost listener threw (ignored; billing unaffected):', error);
    }
  }
}

export function __resetLegacyCostListenersForTests(): void {
  listeners.clear();
}
