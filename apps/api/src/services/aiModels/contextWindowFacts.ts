/**
 * The effective context window of one offering (#11396 W02, spec §3.3).
 * Pure: no IO. Leaf module (imports only the gateway's window constants), so
 * the candidate loaders can call it without widening their import graphs.
 *
 * Precedence:
 *  1. the operator's override, when set;
 *  2. otherwise the SMALLER of the discovered window (the `/models` listing)
 *     and a FRESH observed one (an endpoint's own context-length rejection):
 *     a serving limit below the advertised maximum (an LM Studio model loaded
 *     at 8k) beats the maximum;
 *  3. otherwise unknown (`auto` then stays `full`).
 *
 * An observation is fresh only under the connection's CURRENT config_version
 * and within the memo TTL; past either it is a hint the drawer can show, and
 * it no longer constrains. Every number is plausibility-bounded the same way
 * the gateway bounds a stated window.
 */
import { CONTEXT_WINDOW_MEMO_TTL_MS, MAX_PLAUSIBLE_TOKENS, MIN_PLAUSIBLE_WINDOW, type KnownWindow } from './gateway/openai/contextWindow';

/** The `partner_ai_models` window columns, as Drizzle reads them. Absent = null (older fixtures). */
export interface ContextWindowFields {
  contextWindowOverride?: number | null;
  contextWindowDiscovered?: number | null;
  contextWindowObserved?: number | null;
  contextWindowObservedAt?: Date | null;
  contextWindowObservedConfigVersion?: number | null;
}

export type ContextWindowSource = 'override' | 'discovered' | 'observed' | 'unknown';

export interface EffectiveContextWindow {
  value: number | null;
  source: ContextWindowSource;
  /** The stored observation is current (same config_version, within the TTL). It may still lose to a smaller discovered value. */
  observedFresh: boolean;
}

/** A known window and where it came from (never `unknown`); the gateway's own shape. */
export type KnownContextWindow = KnownWindow;

export const UNKNOWN_CONTEXT_WINDOW: Readonly<EffectiveContextWindow> = Object.freeze({
  value: null, source: 'unknown', observedFresh: false,
});

export function isPlausibleContextWindow(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= MIN_PLAUSIBLE_WINDOW && n <= MAX_PLAUSIBLE_TOKENS;
}

export function resolveEffectiveContextWindow(
  f: ContextWindowFields,
  currentConfigVersion: number | null,
  now: number = Date.now(),
): EffectiveContextWindow {
  const observedAt = f.contextWindowObservedAt ?? null;
  const observedFresh = isPlausibleContextWindow(f.contextWindowObserved)
    && observedAt !== null
    && currentConfigVersion !== null
    && f.contextWindowObservedConfigVersion === currentConfigVersion
    && now - observedAt.getTime() <= CONTEXT_WINDOW_MEMO_TTL_MS;

  if (isPlausibleContextWindow(f.contextWindowOverride)) {
    return { value: f.contextWindowOverride, source: 'override', observedFresh };
  }
  const discovered = isPlausibleContextWindow(f.contextWindowDiscovered) ? f.contextWindowDiscovered : null;
  const observed = observedFresh ? f.contextWindowObserved! : null;
  if (observed !== null && (discovered === null || observed < discovered)) {
    return { value: observed, source: 'observed', observedFresh };
  }
  if (discovered !== null) return { value: discovered, source: 'discovered', observedFresh };
  return { value: null, source: 'unknown', observedFresh };
}

/** The window as a `KnownContextWindow`, or null when unknown. */
export function knownContextWindow(w: EffectiveContextWindow): KnownContextWindow | null {
  return w.value === null || w.source === 'unknown' ? null : { window: w.value, source: w.source };
}
