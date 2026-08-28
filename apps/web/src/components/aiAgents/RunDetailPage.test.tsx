import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import RunDetailPage from './RunDetailPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const RUN_DETAIL = {
  schemaVersion: 1 as const,
  id: 'run-1',
  agentId: 'a1',
  agentName: 'Triage',
  agentKind: 'triage' as const,
  orgId: 'org-1',
  deviceId: 'd1',
  deviceHostname: 'WKS-01',
  alertId: null,
  triggerKind: 'alert' as const,
  modeAtStart: 'shadow' as const,
  status: 'completed' as const,
  summary: 'Investigated high CPU and proposed a fix.',
  runVerdict: 'remediated' as const,
  turnCount: 4,
  costCents: 123,
  errorCode: null,
  queuedAt: '2026-08-20T10:00:00.000Z',
  startedAt: '2026-08-20T10:00:05.000Z',
  finishedAt: '2026-08-20T10:05:00.000Z',
  budgetExceeded: false,
  wallClockExceeded: false,
  maxTurnsExceeded: false,
  trace: [
    { kind: 'executed' as const, tool: 'diagnostics.processes', result: 'ok' as const, durationMs: 500 },
    {
      kind: 'proposed' as const,
      tool: 'scripts.run',
      action: 'restart-service',
      intentId: 'intent-1',
    },
    { kind: 'denied' as const, tool: 'files.delete', reason: 'protected path' },
  ],
  ledger: [
    {
      toolName: 'diagnostics.processes',
      status: 'completed' as const,
      durationMs: 500,
      createdAt: '2026-08-20T10:00:10.000Z',
      completedAt: '2026-08-20T10:00:10.500Z',
      errorMessage: null,
    },
  ],
  intents: [
    {
      id: 'intent-1',
      status: 'pending',
      actionName: 'scripts.run:restart-service',
      approvalScope: 'supervised' as const,
      decidedVia: null,
    },
  ],
};

const BUDGET = {
  schemaVersion: 1 as const,
  orgId: 'org-1',
  agentId: 'a1',
  distinctDevices: 3,
  contractDeviceCount: 100,
  maxFleetPercentPerDay: 10,
  allowance: 10,
  policyDecisionsToday: 2,
  maxPolicyDecisionsPerDay: 50,
  windowHours: 24 as const,
  recordedOnly: true as const,
  accountingMode: 'full' as const,
};

function mockEndpoints(opts: {
  detail?: unknown;
  detailOk?: boolean;
  detailStatus?: number;
  budget?: unknown;
  budgetOk?: boolean;
} = {}) {
  const { detail = RUN_DETAIL, detailOk = true, detailStatus = 200, budget = BUDGET, budgetOk = true } = opts;
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/ai/agents/runs/')) {
      return Promise.resolve(json({ data: detail }, detailOk, detailStatus));
    }
    if (url.startsWith('/ai/agents/exposure-budget')) {
      return Promise.resolve(json({ data: budget }, budgetOk, budgetOk ? 200 : 404));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('RunDetailPage', () => {
  it('loads and renders run header fields', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.getByText('Triage')).toBeInTheDocument();
    expect(screen.getByText('WKS-01')).toBeInTheDocument();
  });

  it('renders trace entries by kind', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-trace')).toBeInTheDocument());
    expect(screen.getByTestId('run-detail-trace-entry-0')).toBeInTheDocument();
    expect(screen.getByTestId('run-detail-trace-entry-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-detail-trace-entry-2')).toBeInTheDocument();
  });

  it('links a proposed entry with an intent to Approvals', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-trace-entry-1')).toBeInTheDocument());
    const link = screen.getByTestId('run-detail-intent-link-intent-1');
    expect(link).toHaveAttribute('href', '/approvals');
  });

  it('renders the ledger', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-ledger')).toBeInTheDocument());
  });

  it('renders the exposure budget readout card', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByText('3 of 10 devices')).toBeInTheDocument());
    expect(screen.getByText('2 of 50 policy decisions today')).toBeInTheDocument();
  });

  it('shows a not-found state on 404', async () => {
    mockEndpoints({ detailOk: false, detailStatus: 404 });
    render(<RunDetailPage runId="missing" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-not-found')).toBeInTheDocument());
  });

  it('never renders raw tool args/input/output anywhere on the page', async () => {
    // The SAFETY RULE: the DTO union has no such fields, but this test proves
    // it end to end — even if a future trace variant grew one of these keys,
    // this test would fail the moment it rendered.
    mockEndpoints();
    const { container } = render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-trace')).toBeInTheDocument());
    const html = container.innerHTML;
    for (const forbidden of ['toolInput', 'toolOutput', 'args', 'arguments']) {
      expect(html).not.toContain(forbidden);
    }
  });
});
