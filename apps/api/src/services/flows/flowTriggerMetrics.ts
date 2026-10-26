/**
 * Tool catalog W04 (#5219), plan Task A9 — the trigger refusals an operator
 * must be able to see (Review Focus "event storms and loops").
 *
 * A LEAF module (`prom-client` + `../metricsRegistry`), registered where the
 * work happens: the schedule tick and the event subscriber run in the worker
 * role, which never loads routes/metrics.ts (the aiOperatorOutboxMetrics.ts
 * rationale).
 */
import { Counter } from 'prom-client';

import { metricsRegistry } from '../metricsRegistry';

const scheduleAdmissionRefused = new Counter({
  name: 'flow_schedule_admission_refused_total',
  help: 'Scheduled flow fires refused at admission (active-run cap) for one org; the occurrence is not retried',
  registers: [metricsRegistry],
});

const eventAdmissionRefused = new Counter({
  name: 'flow_event_admission_refused_total',
  help: 'Event-triggered flow runs refused at admission (active-run cap) for one org; the event is not retried for that flow',
  registers: [metricsRegistry],
});

const chainDepthRefused = new Counter({
  name: 'flow_chain_depth_refused_total',
  help: 'Events that would have started a flow run past the maximum chain depth (loop guard)',
  registers: [metricsRegistry],
});

export function recordFlowScheduleAdmissionRefused(): void {
  scheduleAdmissionRefused.inc();
}

export function recordFlowEventAdmissionRefused(): void {
  eventAdmissionRefused.inc();
}

export function recordFlowChainDepthRefused(): void {
  chainDepthRefused.inc();
}
