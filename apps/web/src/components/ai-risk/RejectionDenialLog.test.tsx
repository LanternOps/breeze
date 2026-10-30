import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RejectionDenialLog } from './RejectionDenialLog';
import type { SecurityEvent, ToolExecution } from './AiRiskDashboard';

function execution(overrides: Partial<ToolExecution>): ToolExecution {
  return {
    id: 'exec-1',
    sessionId: 'sess-1',
    toolName: 'run_script',
    status: 'rejected',
    toolInput: {},
    approvedBy: null,
    approvedAt: null,
    durationMs: null,
    errorMessage: null,
    createdAt: '2026-10-25T00:00:00Z',
    completedAt: null,
    intentId: null,
    tempPasswordState: null,
    ...overrides,
  };
}

function guardrailBlock(): SecurityEvent {
  return {
    id: 'evt-1',
    timestamp: '2026-10-25T00:01:00Z',
    actorType: 'user',
    actorEmail: null,
    action: 'ai.tool.execute_command',
    resourceType: null,
    resourceId: null,
    result: 'denied',
    errorMessage: null,
    details: null,
  };
}

const EXECUTIONS = [execution({ id: 'e-denied' }), execution({ id: 'e-failed', status: 'failed' })];

// #10198: a person's decision on an AI action is "Denied" (#10157); a
// guardrail stopping it is "Blocked" (the Tier 4 name). The log used to show
// "Rejected" for the first and the raw enum value in every row badge.
describe('RejectionDenialLog decision vocabulary (#10198)', () => {
  it('labels a human decision "Denied" and a guardrail stop "Blocked", never "rejected"', () => {
    render(<RejectionDenialLog executions={EXECUTIONS} securityEvents={[guardrailBlock()]} loading={false} />);

    expect(screen.getByRole('button', { name: 'Denied' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Blocked' })).toBeTruthy();
    expect(screen.queryByText(/reject/i)).toBeNull();
    // chip + row badge for each status
    expect(screen.getAllByText('Denied')).toHaveLength(2);
    expect(screen.getAllByText('Blocked')).toHaveLength(2);
    expect(screen.getAllByText('Failed')).toHaveLength(2);
  });

  it('filters to human denials with the Denied chip', () => {
    render(<RejectionDenialLog executions={EXECUTIONS} securityEvents={[guardrailBlock()]} loading={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Denied' }));
    expect(screen.getAllByText('Denied')).toHaveLength(2);
    expect(screen.getAllByText('Blocked')).toHaveLength(1);
    expect(screen.getAllByText('Failed')).toHaveLength(1);
  });
});

describe('RejectionDenialLog platform refusals (#10411)', () => {
  const executions = [
    execution({ id: 'exec-refused', toolName: 'query_devices', status: 'refused', errorMessage: 'Rate limit exceeded for query_devices' }),
    execution({ id: 'exec-rejected', toolName: 'run_script', status: 'rejected', errorMessage: 'Denied by approver' }),
  ];

  it('lists a platform refusal with its reason', () => {
    render(<RejectionDenialLog executions={executions} securityEvents={[]} loading={false} />);
    expect(screen.getByText('Rate limit exceeded for query_devices')).toBeTruthy();
    expect(screen.getByText('Denied by approver')).toBeTruthy();
  });

  it('filters refusals apart from approval rejections', () => {
    render(<RejectionDenialLog executions={executions} securityEvents={[]} loading={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refused' }));
    expect(screen.getByText('Rate limit exceeded for query_devices')).toBeTruthy();
    expect(screen.queryByText('Denied by approver')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Denied' }));
    expect(screen.queryByText('Rate limit exceeded for query_devices')).toBeNull();
    expect(screen.getByText('Denied by approver')).toBeTruthy();
  });
});
