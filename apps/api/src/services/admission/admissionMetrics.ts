/**
 * W08 admission-control Prometheus series. Leaf: `prom-client` + the shared
 * registry (and type-only imports). Labels are closed sets — `route` is a
 * template from agentRouteClasses, never request data.
 *
 * No pool gauges here: W04 owns `breeze_db_pool_admission_*` (in-use, waiting,
 * abandoned, effective permits, acquire timeouts). This module publishes only
 * what the admission controller itself decided and the signal values it used.
 */
import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from '../metricsRegistry';
import type { AdmissionMode } from './admissionConfig';
import type { AdmissionSignals } from './admissionSignals';

export type ShedReason = 'level' | 'bulk_in_flight' | 'ws_bucket' | 'ws_setups';

function counter<L extends string>(name: string, help: string, labelNames: L[]): Counter<L> {
  return (metricsRegistry.getSingleMetric(name) as Counter<L> | undefined)
    ?? new Counter<L>({ name, help, labelNames, registers: [metricsRegistry] });
}

function gauge<L extends string>(name: string, help: string, labelNames: L[] = []): Gauge<L> {
  return (metricsRegistry.getSingleMetric(name) as Gauge<L> | undefined)
    ?? new Gauge<L>({ name, help, labelNames, registers: [metricsRegistry] });
}

const decisions = counter(
  'breeze_admission_decisions_total',
  'Agent requests refused by admission control (shed), or that would have been in observe mode (would_shed)',
  ['class', 'route', 'outcome', 'reason'],
);
const transitions = counter('breeze_admission_transitions_total', 'Admission level changes', ['from', 'to', 'trigger']);
const riseSuppressed = counter(
  'breeze_admission_rise_suppressed_total',
  'Rise streaks that ended before BREEZE_ADMISSION_RISE_TICKS consecutive ticks: a level rise the consecutive-tick gate held back (#9353). `to` is the level it would have entered',
  ['to', 'trigger'],
);
const offlineDeferred = counter(
  'breeze_admission_offline_deferred_total',
  'Agent WS closes/errors whose immediate offline write was left to the offline detector because admission was at level 1+',
  ['event'],
);
const tickFailures = counter(
  'breeze_admission_tick_failures_total',
  'Admission controller ticks that threw (signal sampling or controller step); 5 in a row fail open to level 0',
  [],
);
const level = gauge('breeze_admission_level', 'Current admission level: 0 normal, 1 shed bulk, 2 shed standard, 3 critical');
const mode = gauge('breeze_admission_mode', '1 for the active admission mode', ['mode']);
const lagSignal = gauge('breeze_admission_signal_lag_seconds', 'Median event-loop lag the controller used (-1 = monitor not running)');
const dbSignal = gauge('breeze_admission_signal_db_wait_seconds', 'DB pool wait the controller used (max of grant-wait p95 and oldest waiter, from the W04 gate)');
const elu = gauge('breeze_nodejs_eventloop_utilization', 'Event-loop utilization over the last admission tick (0..1)');
const wsTokens = gauge('breeze_admission_ws_bucket_tokens', 'Agent WS upgrade tokens available at the current level');
const wsSetups = gauge('breeze_admission_ws_setups_in_flight', 'Agent WS upgrades between admission and the end of onOpen');
const bulkInFlight = gauge('breeze_admission_bulk_in_flight', 'Bulk-class agent requests admitted and not yet finished');

const MODES: AdmissionMode[] = ['off', 'observe', 'enforce'];
level.set(0);

export function recordAdmissionDecision(cls: string, route: string, outcome: 'shed' | 'would_shed', reason: ShedReason): void {
  decisions.labels(cls, route, outcome, reason).inc();
}

export function recordAdmissionTransition(from: number, to: number, trigger: string): void {
  transitions.labels(String(from), String(to), trigger).inc();
}

export function recordAdmissionRiseSuppressed(to: number, trigger: string): void {
  riseSuppressed.labels(String(to), trigger).inc();
}

export function recordAdmissionTickFailure(): void {
  tickFailures.inc();
}

/** Fail-open after repeated tick failures: the level gauge must not keep showing a stale shedding level. */
export function recordAdmissionFailOpen(from: number): void {
  if (from !== 0) transitions.labels(String(from), '0', 'tick_failure').inc();
  level.set(0);
}

export function recordOfflineDeferred(event: 'close' | 'error'): void {
  offlineDeferred.labels(event).inc();
}

export interface AdmissionTickSnapshot {
  mode: AdmissionMode;
  level: number;
  signals: AdmissionSignals;
  wsTokens: number;
  wsSetupsInFlight: number;
  bulkInFlight: number;
}

export function publishAdmissionTick(input: AdmissionTickSnapshot): void {
  for (const m of MODES) mode.labels(m).set(m === input.mode ? 1 : 0);
  level.set(input.level);
  lagSignal.set(input.signals.lagMs === null ? -1 : input.signals.lagMs / 1000);
  dbSignal.set(input.signals.dbWaitMs / 1000);
  elu.set(input.signals.eluRatio);
  wsTokens.set(input.wsTokens);
  wsSetups.set(input.wsSetupsInFlight);
  bulkInFlight.set(input.bulkInFlight);
}

const dbSaturationResponses = counter(
  'breeze_admission_db_saturation_responses_total',
  'Requests answered 503 + Retry-After because the DB pool or the RLS prologue timed out (the caller work never ran)',
  ['error'],
);

export function recordDbSaturationResponse(kind: 'pool_acquire_timeout' | 'prologue_timeout'): void {
  dbSaturationResponses.labels(kind).inc();
}
