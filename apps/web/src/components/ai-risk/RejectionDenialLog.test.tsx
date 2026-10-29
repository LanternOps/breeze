import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RejectionDenialLog } from './RejectionDenialLog';
import type { ToolExecution } from './AiRiskDashboard';

function execution(overrides: Partial<ToolExecution>): ToolExecution {
  return {
    id: 'exec-1',
    sessionId: 'sess-1',
    toolName: 'query_devices',
    status: 'completed',
    toolInput: {},
    approvedBy: null,
    approvedAt: null,
    durationMs: 0,
    errorMessage: null,
    createdAt: '2026-10-29T00:00:00Z',
    completedAt: '2026-10-29T00:00:00Z',
    intentId: null,
    tempPasswordState: null,
    ...overrides,
  };
}

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

    fireEvent.click(screen.getByRole('button', { name: 'Rejected' }));
    expect(screen.queryByText('Rate limit exceeded for query_devices')).toBeNull();
    expect(screen.getByText('Denied by approver')).toBeTruthy();
  });
});
