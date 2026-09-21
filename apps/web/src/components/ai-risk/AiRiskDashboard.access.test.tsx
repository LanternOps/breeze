import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #6498 (G4-7): /ai/admin/tool-executions, /security-events and
// /script-proposals-metrics all require organizations:read. A role without it
// used to get empty tables plus a misleading "denial data may be incomplete"
// banner — a 403 is not a transient load failure, so the dashboard must say so.

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('./TierOverviewMatrix', () => ({ TierOverviewMatrix: () => <div data-testid="tier-matrix" /> }));
vi.mock('./RateLimitStatus', () => ({ RateLimitStatus: () => <div data-testid="rate-limits" /> }));
vi.mock('./ToolExecutionAnalytics', () => ({ ToolExecutionAnalytics: () => <div data-testid="analytics-panel" /> }));
vi.mock('./ApprovalHistoryFeed', () => ({ ApprovalHistoryFeed: () => <div data-testid="approvals-panel" /> }));
vi.mock('./RejectionDenialLog', () => ({ RejectionDenialLog: () => <div data-testid="denials-panel" /> }));
vi.mock('./ScriptProposalsPanel', () => ({ ScriptProposalsPanel: () => <div data-testid="proposals-panel" /> }));

import AiRiskDashboard from './AiRiskDashboard';

const res = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('AiRiskDashboard - 403 access state (#6498)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the access-denied state instead of empty tables when the admin reads 403', async () => {
    fetchWithAuthMock.mockResolvedValue(res(403, { error: 'Forbidden' }));
    render(<AiRiskDashboard />);

    fireEvent.click(screen.getByRole('button', { name: /analytics/i }));

    await waitFor(() => expect(screen.getByTestId('ai-risk-access-denied')).toBeInTheDocument());
    expect(screen.queryByTestId('analytics-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/denial data may be incomplete/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument();
  });

  it('keeps the permission-free guardrails tab usable under a 403', async () => {
    fetchWithAuthMock.mockResolvedValue(res(403, { error: 'Forbidden' }));
    render(<AiRiskDashboard />);

    await waitFor(() => expect(screen.getByTestId('tier-matrix')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-risk-access-denied')).not.toBeInTheDocument();
  });

  it('still renders the data panels when the reads succeed', async () => {
    fetchWithAuthMock.mockResolvedValue(
      res(200, { summary: { total: 0, byStatus: {}, byTool: [] }, timeSeries: [], executions: [], data: [] }),
    );
    render(<AiRiskDashboard />);

    fireEvent.click(screen.getByRole('button', { name: /analytics/i }));

    await waitFor(() => expect(screen.getByTestId('analytics-panel')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-risk-access-denied')).not.toBeInTheDocument();
  });
});
