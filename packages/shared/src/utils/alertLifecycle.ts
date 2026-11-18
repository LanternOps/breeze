import { DEFAULT_ALERT_COOLDOWN_MINUTES } from '../constants/alertLifecycle';

/**
 * Alert lifecycle settings (spec 2026-10-29-alert-rearm-lifecycle §6).
 *
 * One resolver for auto-resolve, re-arm and cooldown. Monitor-managed rules
 * resolve monitor override → device org override → that org's partner default
 * → built-in. Legacy (non-monitor) rules keep their template / rule-override
 * values for auto-resolve and cooldown and get the built-in re-arm (OD8).
 *
 * The monitor beating the org is a stated exception to settings rule 3: the
 * monitor is the object being configured, like a line on a document.
 */

export const REARM_MODES = ['new_evidence', 'after_delay'] as const;
export type RearmMode = (typeof REARM_MODES)[number];

export interface AlertLifecycleValues {
  autoResolve: boolean;
  rearmMode: RearmMode;
  /** Minutes after close before consumed evidence may re-open. Non-null iff `rearmMode === 'after_delay'`. */
  rearmDelayMinutes: number | null;
  cooldownMinutes: number;
}

export type LifecycleSource = 'monitor' | 'org' | 'partner' | 'builtin' | 'legacy';
export type AlertLifecycleSources = Record<keyof AlertLifecycleValues, LifecycleSource>;
export type ResolvedAlertLifecycle = AlertLifecycleValues & { sources: AlertLifecycleSources };

/** One level's settings. `null` or `undefined` means "inherit from the next level". */
export interface PartialLifecycle {
  autoResolve?: boolean | null;
  rearmMode?: RearmMode | null;
  rearmDelayMinutes?: number | null;
  cooldownMinutes?: number | null;
}

export const BUILTIN_ALERT_LIFECYCLE: AlertLifecycleValues = Object.freeze({
  autoResolve: false,
  rearmMode: 'new_evidence',
  rearmDelayMinutes: null,
  cooldownMinutes: DEFAULT_ALERT_COOLDOWN_MINUTES,
});

export const ALERT_LIFECYCLE_FIELDS = ['autoResolve', 'rearmMode', 'rearmDelayMinutes', 'cooldownMinutes'] as const;

/**
 * `GET /alerts/lifecycle-defaults` response. `org` is the selected org's raw
 * overrides (each `null` = inherit), or `null` at partner scope. `effective` /
 * `sources` resolve partner → org (no monitor). `monitorOverrideCounts` is the
 * number of monitors in scope that set each field themselves.
 */
export interface AlertLifecycleDefaultsResponse {
  partner: AlertLifecycleValues;
  org: PartialLifecycle | null;
  effective: AlertLifecycleValues;
  sources: AlertLifecycleSources;
  monitorOverrideCounts: Record<keyof AlertLifecycleValues, number>;
}

export interface ResolveAlertLifecycleInput {
  monitor?: PartialLifecycle | null;
  org?: PartialLifecycle | null;
  partner?: PartialLifecycle | null;
  /**
   * Set for a rule NOT managed by a monitor: its rule override ?? template
   * values. When present, monitor/org/partner are ignored entirely (OD8).
   */
  legacy?: { autoResolve: boolean; cooldownMinutes: number } | null;
}

const isRearmDelay = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440;

export function resolveAlertLifecycle(input: ResolveAlertLifecycleInput): ResolvedAlertLifecycle {
  if (input.legacy) {
    return {
      autoResolve: input.legacy.autoResolve,
      cooldownMinutes: input.legacy.cooldownMinutes,
      rearmMode: BUILTIN_ALERT_LIFECYCLE.rearmMode,
      rearmDelayMinutes: BUILTIN_ALERT_LIFECYCLE.rearmDelayMinutes,
      sources: { autoResolve: 'legacy', cooldownMinutes: 'legacy', rearmMode: 'builtin', rearmDelayMinutes: 'builtin' },
    };
  }

  const levels: Array<[Exclude<LifecycleSource, 'builtin' | 'legacy'>, PartialLifecycle | null | undefined]> = [
    ['monitor', input.monitor],
    ['org', input.org],
    ['partner', input.partner],
  ];

  const scalar = <K extends 'autoResolve' | 'cooldownMinutes'>(field: K): [AlertLifecycleValues[K], LifecycleSource] => {
    for (const [source, level] of levels) {
      // `??`-semantics: only null/undefined inherit. `false` and `0` are real values.
      const value = level?.[field];
      if (value !== null && value !== undefined) return [value as AlertLifecycleValues[K], source];
    }
    return [BUILTIN_ALERT_LIFECYCLE[field], 'builtin'];
  };

  // Re-arm mode and delay resolve as ONE pair from the first level that sets
  // the mode: a delay is meaningless without `after_delay`, and mixing one
  // level's mode with another's delay would produce a value nobody chose. A
  // level whose `after_delay` has no usable delay (the DB CHECK forbids it) is
  // skipped rather than given an invented delay.
  let rearm: [RearmMode, number | null, LifecycleSource] = [
    BUILTIN_ALERT_LIFECYCLE.rearmMode, BUILTIN_ALERT_LIFECYCLE.rearmDelayMinutes, 'builtin',
  ];
  for (const [source, level] of levels) {
    const mode = level?.rearmMode;
    if (mode === 'new_evidence') { rearm = ['new_evidence', null, source]; break; }
    if (mode === 'after_delay' && isRearmDelay(level?.rearmDelayMinutes)) {
      rearm = ['after_delay', level.rearmDelayMinutes, source];
      break;
    }
  }

  const [autoResolve, autoResolveSource] = scalar('autoResolve');
  const [cooldownMinutes, cooldownSource] = scalar('cooldownMinutes');
  return {
    autoResolve,
    rearmMode: rearm[0],
    rearmDelayMinutes: rearm[1],
    cooldownMinutes,
    sources: {
      autoResolve: autoResolveSource,
      rearmMode: rearm[2],
      rearmDelayMinutes: rearm[2],
      cooldownMinutes: cooldownSource,
    },
  };
}
