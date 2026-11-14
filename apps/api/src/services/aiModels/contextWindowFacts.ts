/**
 * The effective context window of one offering (#11396 W02, spec §3.3).
 * Pure: no IO. Leaf module (imports only the gateway's window constants), so
 * the candidate loaders can call it without widening their import graphs.
 *
 * Precedence:
 *  1. the operator's override, when set;
 *  2. otherwise the SMALLER of the discovered window (the `/models` listing)
 *     and a FRESH observed one (an endpoint's own context-length rejection):
 *     a serving limit below the advertised maximum (a model served with a
 *     smaller context than its listing states) beats the maximum;
 *  3. otherwise the discovered window: once an observation is past the memo
 *     TTL, a listed window replaces it;
 *  4. otherwise a STALE observed one (#11393): with nothing listed, the last
 *     window the endpoint stated stays as a floor, so an idle hour does not
 *     send `auto` back to `full` and cost a refused turn to re-learn it;
 *  5. otherwise unknown (`auto` then stays `full`).
 *
 * An observation counts only under the connection's CURRENT config_version: a
 * URL, key or model change clears it. It is fresh within the memo TTL; past
 * it, it is replaced by a listed window, an operator override, a later
 * rejection (any window, larger or smaller), or a served prompt larger than it
 * (`clearDisprovenContextWindow`). A stale observation caps `max_tokens` and
 * narrows `auto`, but never refuses a prompt before the endpoint sees it
 * (`KnownWindow.stale`). Every number is plausibility-bounded the same way the
 * gateway bounds a stated window.
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
  /** The stored observation is current (same config_version) and within the memo TTL. It may still lose to a smaller discovered value. */
  observedFresh: boolean;
  /**
   * The stored observation still takes part in the resolution: fresh, or
   * stale with no listed window to replace it (#11393). False once a config
   * change or a listed window has superseded it; the drawer then shows it as
   * a hint only.
   */
  observedApplies: boolean;
}

/** A known window and where it came from (never `unknown`); the gateway's own shape. */
export type KnownContextWindow = KnownWindow;

export function isPlausibleContextWindow(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= MIN_PLAUSIBLE_WINDOW && n <= MAX_PLAUSIBLE_TOKENS;
}

export function resolveEffectiveContextWindow(
  f: ContextWindowFields,
  currentConfigVersion: number | null,
  now: number = Date.now(),
): EffectiveContextWindow {
  const observedAt = f.contextWindowObservedAt ?? null;
  const observedCurrent = isPlausibleContextWindow(f.contextWindowObserved)
    && observedAt !== null
    && currentConfigVersion !== null
    && f.contextWindowObservedConfigVersion === currentConfigVersion;
  const observedFresh = observedCurrent && now - observedAt!.getTime() <= CONTEXT_WINDOW_MEMO_TTL_MS;
  const discovered = isPlausibleContextWindow(f.contextWindowDiscovered) ? f.contextWindowDiscovered : null;
  // A stale observation stays only while nothing listed replaces it (#11393).
  const observedApplies = observedFresh || (observedCurrent && discovered === null);
  const facts = { observedFresh, observedApplies };

  if (isPlausibleContextWindow(f.contextWindowOverride)) {
    return { value: f.contextWindowOverride, source: 'override', ...facts };
  }
  const observed = observedApplies ? f.contextWindowObserved! : null;
  if (observed !== null && (discovered === null || observed < discovered)) {
    return { value: observed, source: 'observed', ...facts };
  }
  if (discovered !== null) return { value: discovered, source: 'discovered', ...facts };
  return { value: null, source: 'unknown', ...facts };
}

/** The window as a `KnownContextWindow`, or null when unknown. A stale observation is marked so the gateway only caps from it. */
export function knownContextWindow(w: EffectiveContextWindow): KnownContextWindow | null {
  if (w.value === null || w.source === 'unknown') return null;
  return w.source === 'observed' && !w.observedFresh
    ? { window: w.value, source: w.source, stale: true }
    : { window: w.value, source: w.source };
}
