import type { M365SyncActionId } from '@breeze/shared/m365';

/**
 * Prometheus text exposition for the executor (spec §7, executor row).
 *
 * Hand-rolled on purpose: this process holds the only customer credential, so
 * its dependency set stays minimal and Trivy-scannable. The registry is a
 * fixed, CLOSED set — there is no dynamic metric creation, so a typo cannot
 * silently mint a new series.
 *
 * Names are unprefixed, per the wave's shared interface contract. The API's
 * own counters carry `breeze_` and live behind a different scrape target.
 */

const COUNTERS = {
  m365_sync_actions_total: {
    help: 'M365 whole-domain sync actions executed, by action and outcome',
    labelNames: ['action', 'outcome'] as readonly string[],
  },
  m365_sync_capacity_rejected_total: {
    help: 'Requests refused because a per-instance in-flight cap was reached',
    labelNames: ['kind'] as readonly string[],
  },
} as const;

const GAUGES = {
  m365_sync_in_flight: 'Sync actions currently executing on this instance',
  m365_in_flight_total: 'All executor operations currently executing on this instance',
  m365_signin_limiter_tokens: 'Whole tokens available in the app-wide sign-in activity bucket',
  m365_signin_events_limiter_tokens: 'Whole tokens available in the app-wide sign-in EVENTS bucket',
} as const;

type CounterName = keyof typeof COUNTERS;
type GaugeName = keyof typeof GAUGES;

const counterValues = new Map<CounterName, Map<string, { labels: string[]; value: number }>>();
const gaugeValues = new Map<GaugeName, number>();

function increment(name: CounterName, labels: string[]): void {
  let series = counterValues.get(name);
  if (!series) {
    series = new Map();
    counterValues.set(name, series);
  }
  const key = labels.join('\u0000');
  const existing = series.get(key);
  if (existing) existing.value += 1;
  else series.set(key, { labels, value: 1 });
}

export function incrementSyncAction(action: M365SyncActionId, outcome: string): void {
  increment('m365_sync_actions_total', [action, outcome]);
}

export function incrementSyncCapacityRejected(kind: 'sync' | 'interactive'): void {
  increment('m365_sync_capacity_rejected_total', [kind]);
}

export function setSyncInFlight(value: number): void {
  gaugeValues.set('m365_sync_in_flight', value);
}

export function setTotalInFlight(value: number): void {
  gaugeValues.set('m365_in_flight_total', value);
}

export function setSigninLimiterTokens(value: number): void {
  gaugeValues.set('m365_signin_limiter_tokens', value);
}

/** #5784 W05. /auditLogs/signIns has its own bucket, so its own series. */
export function setSigninEventsLimiterTokens(value: number): void {
  gaugeValues.set('m365_signin_events_limiter_tokens', value);
}

/** Label values here are closed enums, but escape anyway — the format is a contract. */
function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const name of Object.keys(COUNTERS) as CounterName[]) {
    const definition = COUNTERS[name];
    lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} counter`);
    for (const { labels, value } of counterValues.get(name)?.values() ?? []) {
      const rendered = definition.labelNames
        .map((labelName, index) => `${labelName}="${escapeLabelValue(labels[index] ?? '')}"`)
        .join(',');
      lines.push(`${name}{${rendered}} ${value}`);
    }
  }
  for (const name of Object.keys(GAUGES) as GaugeName[]) {
    lines.push(`# HELP ${name} ${GAUGES[name]}`, `# TYPE ${name} gauge`, `${name} ${gaugeValues.get(name) ?? 0}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Test-only. Never called from the serving path. */
export function resetMetrics(): void {
  counterValues.clear();
  gaugeValues.clear();
}
