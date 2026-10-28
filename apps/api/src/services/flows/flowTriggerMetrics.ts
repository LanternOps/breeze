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
import type { FlowAdmissionRefusal } from '@breeze/shared';

import { metricsRegistry } from '../metricsRegistry';

// `code` is one of FLOW_ADMISSION_REFUSALS (bounded cardinality): the active
// cap (W04) or a monthly cap (W05, #5220 Decision 15).
const scheduleAdmissionRefused = new Counter({
  name: 'flow_schedule_admission_refused_total',
  help: 'Scheduled flow fires refused at admission (active-run or monthly cap) for one org; the occurrence is not retried',
  labelNames: ['code'] as const,
  registers: [metricsRegistry],
});

const eventAdmissionRefused = new Counter({
  name: 'flow_event_admission_refused_total',
  help: 'Event-triggered flow runs refused at admission (active-run or monthly cap) for one org; the event is not retried for that flow',
  labelNames: ['code'] as const,
  registers: [metricsRegistry],
});


const chainDepthRefused = new Counter({
  name: 'flow_chain_depth_refused_total',
  help: 'Events that would have started a flow run past the maximum chain depth (loop guard)',
  registers: [metricsRegistry],
});

export function recordFlowScheduleAdmissionRefused(code: FlowAdmissionRefusal): void {
  scheduleAdmissionRefused.inc({ code });
}

export function recordFlowEventAdmissionRefused(code: FlowAdmissionRefusal): void {
  eventAdmissionRefused.inc({ code });
}

export function recordFlowChainDepthRefused(): void {
  chainDepthRefused.inc();
}
