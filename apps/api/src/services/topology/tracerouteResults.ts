import type {
  TopologyDiagnosticPlan,
  TopologyDiagnosticStep,
  TopologyTraceView,
} from '@breeze/shared';

/**
 * Routed-trace results (M3 Task 9): the plan-bound integrity check applied at
 * result ingress, and the read model a UI or M4 tool renders.
 *
 * A trace is evidence only. Nothing here — or anywhere downstream of result
 * acceptance — derives topology nodes, relationships or health from a
 * responding hop; the read model is labelled an observed routed path so it can
 * never be confused with the discovered topology path.
 */

type PlanStep = TopologyDiagnosticPlan['steps'][number];
type TracePlanStep = Extract<PlanStep, { method: 'trace' }>;

/**
 * Reason code for a trace result that contradicts its accepted plan, or null.
 * The schema already bounds a trace against its OWN declared limits; this binds
 * those declarations to what the server planned, so an agent cannot report a
 * wider trace than it was authorized to run, claim a confirmation it did not
 * observe, or drop hops without saying so.
 */
export function topologyTraceStepViolation(
  plan: Pick<TopologyDiagnosticPlan, 'steps'>,
  step: TopologyDiagnosticStep,
): string | null {
  const planned = plan.steps.find((entry) => entry.id === step.id);
  const trace = step.details.trace;
  if (!planned || planned.method !== 'trace') return trace ? 'trace_output_unplanned' : null;
  if (!trace) return step.state === 'succeeded' ? 'trace_confirmation_mismatch' : null;
  const bounds = planned as TracePlanStep;
  if (trace.maxHops !== bounds.maxHops || trace.probesPerHop !== bounds.probesPerHop) return 'trace_bounds_mismatch';
  if (trace.hops.some((hop) => hop.ttl > bounds.maxHops || hop.attempt > bounds.probesPerHop)) return 'trace_bounds_mismatch';
  if (trace.hopsOmitted > 0 && !step.truncated) return 'trace_truncation_unmarked';
  if (trace.hops.length + trace.hopsOmitted > bounds.maxHops * bounds.probesPerHop) return 'trace_bounds_mismatch';
  if (trace.destinationReached !== (step.state === 'succeeded')) return 'trace_confirmation_mismatch';
  if (trace.destinationReached) {
    const last = trace.hops[trace.hops.length - 1];
    const destination = step.attribution.resolvedIp;
    if (!last || last.outcome !== 'reply' || destination === null || last.address !== destination) {
      return 'trace_confirmation_mismatch';
    }
  }
  return null;
}

function traceView(
  plan: TopologyDiagnosticPlan,
  planned: TracePlanStep,
  step: TopologyDiagnosticStep | undefined,
): TopologyTraceView {
  const trace = step?.details.trace;
  const byTtl = new Map<number, TopologyTraceView['hops'][number]>();
  for (const hop of trace?.hops ?? []) {
    let entry = byTtl.get(hop.ttl);
    if (!entry) {
      entry = { ttl: hop.ttl, responders: [], gaps: [], alternatives: false };
      byTtl.set(hop.ttl, entry);
    }
    if (hop.address === null) {
      entry.gaps.push({ attempt: hop.attempt, outcome: hop.outcome === 'reply' ? 'timeout' : hop.outcome });
      continue;
    }
    const outcome = hop.outcome === 'unreachable' ? 'unreachable' : 'reply';
    const responder = entry.responders.find((row) => row.address === hop.address && row.outcome === outcome);
    if (responder) {
      responder.attempts.push(hop.attempt);
      responder.rttMs.push(hop.rttMs);
    } else {
      entry.responders.push({ address: hop.address, attempts: [hop.attempt], rttMs: [hop.rttMs], outcome, attributionQuality: hop.attributionQuality });
    }
    entry.alternatives = new Set(entry.responders.map((row) => row.address)).size > 1;
  }
  const attribution = step?.attribution;
  return {
    kind: 'observed_routed_path',
    stepId: planned.id,
    state: step?.state ?? null,
    reason: step?.reason ?? null,
    requestedMethod: 'trace',
    actualMethod: attribution?.actualMethod ?? null,
    protocol: trace?.protocol ?? null,
    origin: {
      deviceId: plan.origin.deviceId,
      agentId: plan.origin.agentId,
      contextKey: attribution?.contextKey ?? plan.origin.contextKey,
      interfaceId: attribution?.interfaceId ?? plan.origin.interfaceId,
      localAddress: attribution?.localAddress ?? null,
      sourceId: plan.origin.sourceId,
    },
    destination: {
      destinationId: planned.destinationId,
      address: attribution?.resolvedIp ?? null,
      family: attribution?.family ?? null,
    },
    attributionQuality: attribution?.quality ?? 'unknown',
    routeChanged: attribution?.routeChanged ?? false,
    destinationReached: trace?.destinationReached ?? false,
    maxHops: planned.maxHops,
    probesPerHop: planned.probesPerHop,
    hops: [...byTtl.values()].sort((a, b) => a.ttl - b.ttl),
    truncated: step?.truncated ?? false,
    hopsOmitted: trace?.hopsOmitted ?? 0,
  };
}

/** One view per planned trace step, in plan order, including unmeasured ones. */
export function buildTopologyTraceViews(
  plan: TopologyDiagnosticPlan,
  steps: TopologyDiagnosticStep[],
): TopologyTraceView[] {
  const results = new Map(steps.map((step) => [step.id, step]));
  return plan.steps
    .filter((entry): entry is TracePlanStep => entry.method === 'trace')
    .map((entry) => traceView(plan, entry, results.get(entry.id)));
}
