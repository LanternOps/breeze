export const READINESS_TRANSITION_VISIBILITY_THRESHOLD_MS = 10_000;
export const DEFAULT_READINESS_CACHE_TTL_MS = 5_000;
export const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 3_000;

type ReadinessTimingName =
  | 'READINESS_CACHE_TTL_MS'
  | 'READINESS_PROBE_TIMEOUT_MS';

function parseInteger(raw: string | undefined, fallback: number): number {
  if (!raw || !/^-?\d+$/u.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function clamp(
  name: ReadinessTimingName,
  requested: number,
  minimum: number,
  maximum: number,
  onClamp?: (name: ReadinessTimingName, requested: number, effective: number) => void,
): number {
  const effective = Math.min(Math.max(requested, minimum), maximum);
  if (effective !== requested) onClamp?.(name, requested, effective);
  return effective;
}

export function resolveReadinessTiming(
  env: NodeJS.ProcessEnv,
  onClamp?: (name: ReadinessTimingName, requested: number, effective: number) => void,
): {
  ttlMs: number;
  probeTimeoutMs: number;
  transitionVisibilityThresholdMs: 10_000;
} {
  const requestedProbeTimeoutMs = parseInteger(
    env.READINESS_PROBE_TIMEOUT_MS,
    DEFAULT_READINESS_PROBE_TIMEOUT_MS,
  );
  const probeTimeoutMs = clamp(
    'READINESS_PROBE_TIMEOUT_MS',
    requestedProbeTimeoutMs,
    100,
    5_000,
    onClamp,
  );
  const requestedTtlMs = parseInteger(
    env.READINESS_CACHE_TTL_MS,
    DEFAULT_READINESS_CACHE_TTL_MS,
  );
  const ttlMs = clamp(
    'READINESS_CACHE_TTL_MS',
    requestedTtlMs,
    0,
    READINESS_TRANSITION_VISIBILITY_THRESHOLD_MS - probeTimeoutMs,
    onClamp,
  );

  return {
    ttlMs,
    probeTimeoutMs,
    transitionVisibilityThresholdMs: READINESS_TRANSITION_VISIBILITY_THRESHOLD_MS,
  };
}
