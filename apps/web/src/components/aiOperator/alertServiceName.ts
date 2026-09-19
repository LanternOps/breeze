/**
 * Best-effort service-name prefill for the "Delegate to Operator" dialog
 * (#5205 W08, #5246).
 *
 * There is NO structured service name on an alert. The service condition
 * handler (`apps/api/src/services/alertConditions/handlers/service.ts`) writes
 * the name only into prose:
 *
 *   "Service spooler stopped (3 consecutive failures, threshold: 3)"
 *   "Service spooler is running"
 *
 * so the only thing available is a text match. That is exactly why this
 * returns `null` rather than a guess it cannot justify, and why the dialog's
 * service field is a REQUIRED, editable input rather than a hidden value: a
 * prefill is a convenience, and the operator confirms the actual name before
 * anything is admitted. The server re-validates it either way — `serviceName`
 * is part of the argument digest, so a wrong one is a different operation and
 * a different approval (spec §7.1), never a silently widened one.
 */
const SERVICE_PATTERNS: readonly RegExp[] = [
  // "Service spooler stopped", "Service 'W32Time' is running"
  /\bservice\s+["'`]?([A-Za-z0-9._$-]{1,255})["'`]?\s+(?:stopped|is\s|has\s|not\s|failed)/i,
  // Trailing form: "... stopped: spooler"
  /\bservice\s*:\s*["'`]?([A-Za-z0-9._$-]{1,255})["'`]?/i,
];

/** Words that are never a service name, only the sentence around one. */
const NON_NAMES = new Set(['is', 'was', 'has', 'not', 'the', 'a', 'an']);

export function extractServiceNameFromAlert(alert: {
  title?: string | null;
  message?: string | null;
  context?: Record<string, unknown> | null;
}): string | null {
  // A structured value, if a future rule ever supplies one, always wins over
  // parsing prose.
  const fromContext = alert.context?.serviceName;
  if (typeof fromContext === 'string' && fromContext.trim()) {
    return fromContext.trim().slice(0, 255);
  }

  for (const text of [alert.message, alert.title]) {
    if (!text) continue;
    for (const pattern of SERVICE_PATTERNS) {
      const name = pattern.exec(text)?.[1]?.trim();
      if (name && !NON_NAMES.has(name.toLowerCase())) return name.slice(0, 255);
    }
  }
  return null;
}
