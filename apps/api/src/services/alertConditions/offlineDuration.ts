/**
 * Shared cap tying config-policy offline-rule durations to the offline re-eval
 * sweep horizon (issue #1982).
 *
 * The re-evaluation sweep (jobs/offlineDetector.ts) only re-checks devices last
 * seen within the horizon, so an offline rule whose duration exceeds the
 * horizon would never fire — the device ages out of the sweep before the rule's
 * duration elapses. To avoid silently-unfireable rules, config-time validation
 * (the offline condition validator + the config-policy feature-link route)
 * rejects offline durations greater than the horizon. Both the validator and
 * the sweep read this same env, so the cap always matches the horizon that
 * actually governs re-evaluation.
 */
export const DEFAULT_REEVAL_HORIZON_MINUTES = 1440; // 24h

/** Resolve the re-eval horizon (minutes) from env, clamped to >= 1. */
export function resolveReevalHorizonMinutes(): number {
  return Math.max(
    1,
    Number(process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES ?? String(DEFAULT_REEVAL_HORIZON_MINUTES))
  );
}

/**
 * Read an offline condition's configured duration in minutes, tolerating both
 * the canonical `durationMinutes` and the legacy `duration` field. Returns
 * undefined when neither is a number.
 */
function readDurationMinutes(condition: Record<string, unknown>): number | undefined {
  if (typeof condition.durationMinutes === 'number') return condition.durationMinutes;
  if (typeof condition.duration === 'number') return condition.duration;
  return undefined;
}

/**
 * Walk an alert-rule feature link's `inlineSettings` looking for an offline
 * condition whose configured duration exceeds the re-eval horizon. Returns a
 * human-readable error message for the first violation found, or null when all
 * offline durations are within range.
 *
 * Scoped deliberately to offline conditions only — it never rejects any other
 * condition type, so it can't reject saves that were previously accepted.
 */
export function findOfflineDurationViolation(inlineSettings: unknown): string | null {
  const max = resolveReevalHorizonMinutes();
  const items = (inlineSettings as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;

  for (const item of items) {
    const offending = walkForOversizedOfflineDuration((item as { conditions?: unknown })?.conditions, max);
    if (offending !== null) {
      const name = (item as { name?: unknown })?.name;
      const label = typeof name === 'string' && name.length > 0 ? ` "${name}"` : '';
      return `Offline rule${label} duration of ${offending} min exceeds the maximum of ${max} min ` +
        `(the offline re-evaluation horizon). A rule longer than this would never fire — lower the ` +
        `duration, or raise OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES.`;
    }
  }
  return null;
}

/** Recursively search a condition tree; returns the first oversized offline duration, or null. */
function walkForOversizedOfflineDuration(node: unknown, max: number): number | null {
  if (!node) return null;

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = walkForOversizedOfflineDuration(child, max);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof node === 'object') {
    const c = node as Record<string, unknown>;
    // `status` is the legacy alias for offline conditions.
    if (c.type === 'offline' || c.type === 'status') {
      const duration = readDurationMinutes(c);
      if (typeof duration === 'number' && duration > max) return duration;
    }
    if (Array.isArray(c.conditions)) {
      return walkForOversizedOfflineDuration(c.conditions, max);
    }
  }

  return null;
}
