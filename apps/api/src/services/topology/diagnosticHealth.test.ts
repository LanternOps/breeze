import { describe, expect, it } from 'vitest';
import type { TopologyDiagnosticPlan, TopologyDiagnosticStep } from '@breeze/shared';
import { topologyHealthSummarySchema } from '@breeze/shared';
import {
  assessTopologyDiagnostic,
  assessTopologyDiagnosticRun,
  DIAGNOSTIC_FRESHNESS_WINDOW_MS,
  type TopologyAssessmentStep,
} from './diagnosticHealth';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 30_000).toISOString();
const STALE = new Date(NOW.getTime() - DIAGNOSTIC_FRESHNESS_WINDOW_MS - 1_000).toISOString();

let counter = 0;
function identifier(): string {
  counter += 1;
  return `70000000-0000-4000-8000-${counter.toString().padStart(12, '0')}`;
}

type PlanStepInput = {
  id: string;
  method: TopologyDiagnosticPlan['steps'][number]['method'];
  required?: boolean;
};

/** Only the fields the assessment reads; the planner owns full plan validity. */
function plan(steps: PlanStepInput[]): TopologyDiagnosticPlan {
  return {
    steps: steps.map((step) => ({
      id: step.id,
      method: step.method,
      required: step.required ?? true,
      destinationId: null,
    })),
  } as unknown as TopologyDiagnosticPlan;
}

function step(input: {
  id: string;
  state: TopologyDiagnosticStep['state'];
  method?: TopologyAssessmentStep['attribution']['requestedMethod'];
  receivedAt?: string | null;
  historicalOnly?: boolean;
}): TopologyAssessmentStep {
  const method = input.method ?? 'icmp';
  return {
    id: input.id,
    state: input.state,
    reason: null,
    attribution: {
      originDeviceId: identifier(),
      originAgentId: 'agent',
      requestedMethod: method,
      actualMethod: method,
      destinationId: null,
      resolvedIp: null,
      family: 'ipv4',
      port: null,
      interfaceId: null,
      localAddress: null,
      contextKey: null,
      tableKey: null,
      nextHop: null,
      proxyUsed: null,
      quality: 'observed',
      routeChanged: false,
      evidenceRefs: [],
    },
    startedAt: input.receivedAt === undefined ? FRESH : input.receivedAt,
    finishedAt: input.receivedAt === undefined ? FRESH : input.receivedAt,
    receivedAt: input.receivedAt === undefined ? FRESH : input.receivedAt,
    truncated: false,
    details: {},
    historicalOnly: input.historicalOnly ?? false,
  };
}

describe('assessTopologyDiagnostic', () => {
  it('reports partial dual-family success as degraded with the failing protocol named', () => {
    const tcp = identifier();
    const tls = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: tcp, method: 'tcp' }, { id: tls, method: 'tls' }]),
      [
        step({ id: tcp, state: 'succeeded', method: 'tcp' }),
        step({ id: tls, state: 'failed_check', method: 'tls' }),
      ],
      { now: NOW },
    );

    expect(result).toMatchObject({ status: 'degraded', coverage: 'monitored' });
    expect(result.reasons).toContain('tls_check_failed');
    expect(result.reasons).toContain('tcp_succeeded');
    expect(result.evidenceRefs).toEqual([tcp, tls]);
    expect(topologyHealthSummarySchema.safeParse(result).success).toBe(true);
  });

  it('treats evidence older than the on-demand freshness window as unknown', () => {
    const icmp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: icmp, method: 'icmp' }]),
      [step({ id: icmp, state: 'succeeded', receivedAt: STALE })],
      { now: NOW },
    );

    expect(result.status).toBe('unknown');
    expect(result.coverage).toBe('unavailable');
    expect(result.reasons).toContain('missing_required_evidence');
    expect(result.reasons).toContain('stale_required_evidence');
    expect(result.evidenceRefs).toEqual([]);
  });

  it('never infers health from a late historical result', () => {
    const icmp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: icmp, method: 'icmp' }]),
      [step({ id: icmp, state: 'succeeded', historicalOnly: true })],
      { now: NOW },
    );

    expect(result.status).toBe('unknown');
    expect(result.reasons).toContain('missing_required_evidence');
  });

  it('reports unsupported required evidence as unknown with unsupported coverage', () => {
    const icmp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: icmp, method: 'icmp' }]),
      [step({ id: icmp, state: 'unsupported' })],
      { now: NOW },
    );

    expect(result).toMatchObject({ status: 'unknown', coverage: 'unsupported' });
    expect(result.reasons).toContain('icmp_unsupported');
  });

  it('is healthy only when every planned step produced fresh success', () => {
    const route = identifier();
    const icmp = identifier();
    const planned = plan([{ id: route, method: 'route_lookup' }, { id: icmp, method: 'icmp' }]);

    expect(assessTopologyDiagnostic(planned, [
      step({ id: route, state: 'succeeded', method: 'route_lookup' }),
      step({ id: icmp, state: 'succeeded' }),
    ], { now: NOW })).toMatchObject({ status: 'healthy', coverage: 'monitored' });
  });

  it('keeps one successful optional endpoint from claiming whole coverage', () => {
    const first = identifier();
    const second = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: first, method: 'tcp' }, { id: second, method: 'tcp', required: false }]),
      [step({ id: first, state: 'succeeded', method: 'tcp' })],
      { now: NOW },
    );

    expect(result).toMatchObject({ status: 'healthy', coverage: 'partial' });
    expect(result.reasons).toContain('partial_coverage');
  });

  it('calls an unanswered gateway ping a failed check without claiming the router is down', () => {
    const icmp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: icmp, method: 'icmp' }]),
      [step({ id: icmp, state: 'timeout' })],
      { now: NOW },
    );

    expect(result.status).toBe('failed_check');
    expect(result.reasons).toContain('icmp_no_response');
    expect(result.reasons.join(' ')).not.toMatch(/router|gateway_down|isp/);
  });

  it('separates a failed resolver from successful direct reachability', () => {
    const dns = identifier();
    const tcp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: dns, method: 'dns' }, { id: tcp, method: 'tcp' }]),
      [
        step({ id: dns, state: 'failed_check', method: 'dns' }),
        step({ id: tcp, state: 'succeeded', method: 'tcp' }),
      ],
      { now: NOW },
    );

    expect(result.status).toBe('degraded');
    expect(result.reasons).toEqual(expect.arrayContaining(['dns_check_failed', 'tcp_succeeded']));
  });

  // PR #7117 review C2: target_connectivity plans a local route lookup plus the
  // TCP probe. A successful local read is not "a working protocol": when every
  // on-the-wire probe failed the target is down, so the run is a failed check
  // (a 'degraded' result would reset the recurring failure streak every time).
  it.each(['timeout', 'failed_check'] as const)('is a failed check when every probe %s even though a local route lookup succeeded', (state) => {
    const route = identifier();
    const tcp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: route, method: 'route_lookup' }, { id: tcp, method: 'tcp' }]),
      [
        step({ id: route, state: 'succeeded', method: 'route_lookup' }),
        step({ id: tcp, state, method: 'tcp' }),
      ],
      { now: NOW },
    );

    expect(result).toMatchObject({ status: 'failed_check', coverage: 'monitored' });
  });

  it('is a failed check only when every required probe actually failed', () => {
    const icmp = identifier();
    const tcp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: icmp, method: 'icmp' }, { id: tcp, method: 'tcp' }]),
      [
        step({ id: icmp, state: 'timeout' }),
        step({ id: tcp, state: 'failed_check', method: 'tcp' }),
      ],
      { now: NOW },
    );

    expect(result.status).toBe('failed_check');
  });

  it('does not treat an orchestration error as measurement evidence', () => {
    const icmp = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: icmp, method: 'icmp' }]),
      [step({ id: icmp, state: 'execution_error' })],
      { now: NOW },
    );

    expect(result).toMatchObject({ status: 'unknown', coverage: 'unavailable' });
    expect(result.reasons).toContain('execution_error');
  });

  it('ignores a result whose step is not part of the accepted plan', () => {
    const icmp = identifier();
    const forged = identifier();
    const result = assessTopologyDiagnostic(
      plan([{ id: icmp, method: 'icmp' }]),
      [step({ id: icmp, state: 'succeeded' }), step({ id: forged, state: 'failed_check' })],
      { now: NOW },
    );

    expect(result.status).toBe('healthy');
    expect(result.evidenceRefs).toEqual([icmp]);
  });
});

describe('assessTopologyDiagnosticRun', () => {
  it('derives complete run coverage when every planned step was attempted', () => {
    const first = identifier();
    const second = identifier();
    const assessment = assessTopologyDiagnosticRun(
      plan([{ id: first, method: 'icmp' }, { id: second, method: 'tcp', required: false }]),
      [step({ id: first, state: 'succeeded' }), step({ id: second, state: 'unsupported', method: 'tcp' })],
      { now: NOW },
    );

    expect(assessment.coverage).toBe('complete');
    expect(assessment.summary.status).toBe('healthy');
  });

  it('derives partial coverage when a planned step never ran', () => {
    const first = identifier();
    const second = identifier();
    const assessment = assessTopologyDiagnosticRun(
      plan([{ id: first, method: 'icmp' }, { id: second, method: 'tcp' }]),
      [step({ id: first, state: 'succeeded' }), step({ id: second, state: 'pending', method: 'tcp' })],
      { now: NOW },
    );

    expect(assessment.coverage).toBe('partial');
    expect(assessment.summary.status).toBe('unknown');
  });

  it('derives no coverage from a cancelled run and still returns a storable assessment', () => {
    const first = identifier();
    const assessment = assessTopologyDiagnosticRun(
      plan([{ id: first, method: 'icmp' }]),
      [step({ id: first, state: 'cancelled' })],
      { now: NOW },
    );

    expect(assessment.coverage).toBe('none');
    expect(assessment.summary.status).toBe('unknown');
    expect(topologyHealthSummarySchema.safeParse(assessment.summary).success).toBe(true);
  });

  it('counts a stale attempt as attempted even though it is not usable evidence', () => {
    const first = identifier();
    const assessment = assessTopologyDiagnosticRun(
      plan([{ id: first, method: 'icmp' }]),
      [step({ id: first, state: 'succeeded', receivedAt: STALE })],
      { now: NOW },
    );

    expect(assessment.coverage).toBe('complete');
    expect(assessment.summary.status).toBe('unknown');
  });
});

describe('routed trace evidence (M3 Task 9)', () => {
  it('treats an unconfirmed trace as missing evidence, never as a failed path', () => {
    const route = identifier();
    const trace = identifier();
    for (const state of ['failed_check', 'timeout'] as const) {
      const summary = assessTopologyDiagnostic(
        plan([{ id: route, method: 'route_lookup' }, { id: trace, method: 'trace' }]),
        [step({ id: route, state: 'succeeded', method: 'route_lookup' }), step({ id: trace, state, method: 'trace' })],
        { now: NOW },
      );
      expect(summary.status).toBe('unknown');
      expect(summary.reasons).toContain('trace_destination_not_confirmed');
      expect(summary.reasons).not.toContain('trace_check_failed');
      expect(summary.evidenceRefs).toEqual([route]);
    }
  });

  it('counts a trace that confirmed its destination as fresh success', () => {
    const route = identifier();
    const trace = identifier();
    const summary = assessTopologyDiagnostic(
      plan([{ id: route, method: 'route_lookup' }, { id: trace, method: 'trace' }]),
      [step({ id: route, state: 'succeeded', method: 'route_lookup' }), step({ id: trace, state: 'succeeded', method: 'trace' })],
      { now: NOW },
    );
    expect(summary).toMatchObject({ status: 'healthy', coverage: 'monitored', evidenceRefs: [route, trace] });
    expect(summary.reasons).toContain('trace_succeeded');
  });
});
