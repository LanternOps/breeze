import { describe, expect, it } from 'vitest';
import type { TopologyDiagnosticPlan, TopologyDiagnosticStep } from '@breeze/shared';

import { summarizeTopologyDiagnosticRun } from './diagnosticResults';

const stepId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function plan(required: boolean[]): Pick<TopologyDiagnosticPlan, 'steps'> {
  return {
    steps: required.map((isRequired, index) => ({
      id: stepId(index + 1),
      method: 'icmp',
      destinationId: null,
      required: isRequired,
      packetCount: 3,
      timeoutMs: 1000,
      payloadBytes: 32,
    })) as TopologyDiagnosticPlan['steps'],
  };
}

function step(
  index: number,
  state: TopologyDiagnosticStep['state'],
  reason: string | null = null,
): TopologyDiagnosticStep {
  return {
    id: stepId(index + 1),
    state,
    reason,
    attribution: {
      originDeviceId: stepId(9),
      originAgentId: 'agent-1',
      requestedMethod: 'icmp',
      actualMethod: 'icmp',
      destinationId: null,
      resolvedIp: null,
      family: 'ipv4',
      port: null,
      interfaceId: null,
      localAddress: null,
      contextKey: 'default',
      tableKey: null,
      nextHop: null,
      proxyUsed: null,
      quality: 'observed',
      routeChanged: false,
      evidenceRefs: [],
    },
    startedAt: null,
    finishedAt: null,
    receivedAt: null,
    truncated: false,
    details: {},
  };
}

describe('summarizeTopologyDiagnosticRun', () => {
  it('calls a fully attempted, fully successful required plan healthy and complete', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, true]), [step(0, 'succeeded'), step(1, 'succeeded')]),
    ).toMatchObject({ state: 'completed', assessment: 'healthy', coverage: 'complete' });
  });

  it('calls a mixed required outcome degraded', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, true]), [
        step(0, 'succeeded'),
        step(1, 'failed_check', 'destination_unreachable'),
      ]),
    ).toMatchObject({ state: 'completed', assessment: 'degraded', coverage: 'complete' });
  });

  it('calls every required probe failing a failed check, not an orchestration failure', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, true]), [
        step(0, 'failed_check', 'destination_unreachable'),
        step(1, 'timeout', 'probe_timeout'),
      ]),
    ).toMatchObject({ state: 'completed', assessment: 'failed_check', coverage: 'complete' });
  });

  it('treats missing required evidence as unknown with partial coverage', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, true]), [step(0, 'succeeded')]),
    ).toMatchObject({ assessment: 'unknown', coverage: 'partial' });
  });

  it('treats an unsupported required step as unknown, not a failed check', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true]), [step(0, 'unsupported', 'unsupported_context')]),
    ).toMatchObject({ state: 'completed', assessment: 'unknown', coverage: 'none' });
  });

  it('counts an unsupported step short of coverage without discarding real evidence', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, true]), [
        step(0, 'succeeded'),
        step(1, 'unsupported', 'unsupported_context'),
      ]),
    ).toMatchObject({ state: 'completed', assessment: 'unknown', coverage: 'partial' });
  });

  it('reports an orchestration failure when every required step is indeterminate', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, true]), [
        step(0, 'execution_error', 'outcome_indeterminate'),
        step(1, 'execution_error', 'outcome_indeterminate'),
      ]),
    ).toMatchObject({ state: 'failed', assessment: 'unknown', coverage: 'none' });
  });

  it('reports no coverage and an orchestration failure when nothing was attempted', () => {
    expect(summarizeTopologyDiagnosticRun(plan([true]), [])).toMatchObject({
      state: 'failed',
      assessment: 'unknown',
      coverage: 'none',
    });
  });

  it('ignores optional steps when judging coverage', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, false]), [step(0, 'succeeded')]),
    ).toMatchObject({ assessment: 'healthy', coverage: 'complete' });
  });

  it('collects deduplicated, sorted assessment and step reasons', () => {
    expect(
      summarizeTopologyDiagnosticRun(plan([true, true]), [
        step(0, 'failed_check', 'destination_unreachable'),
        step(1, 'failed_check', 'destination_unreachable'),
      ]).reasons,
    ).toEqual(['destination_unreachable', 'icmp_check_failed']);
  });
});
