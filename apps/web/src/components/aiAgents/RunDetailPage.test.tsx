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
    {
      kind: 'executed' as const,
      tool: 'manage_services',
      action: 'restart',
      result: 'ok' as const,
      durationMs: 250,
      actOpKey: 'service.restart',
      actTargetName: 'Spooler',
    },
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

// Phase 2 wave P2-2 (#4189, Task 14) — a `sweep`-profile run's outcome
// projection (`AiAgentRunSweepDto`). Six findings, one per sweep kind, so the
// table exercises every kind label plus a proposal in each disposition.
const SWEEP = {
  scheduleId: 'sched-1',
  occurrenceKey: '2026-08-29T02:00',
  kinds: ['service_down', 'unpatched_critical', 'disk_pressure', 'stale_agents', 'pending_reboots', 'failed_backups'],
  summary: 'Six problems found across three devices.',
  evidenceTruncated: true,
  findings: [
    {
      kind: 'service_down',
      severity: 'critical',
      deviceId: 'd1',
      deviceHostname: 'WKS-01',
      title: 'Print Spooler is stopped',
      detail: 'The watched Spooler service has been stopped since 09:12.',
      evidence: { serviceName: 'Spooler', state: 'stopped' },
      proposal: {
        tool: 'manage_services',
        action: 'restart',
        disposition: 'intent_created',
        reason: null,
        intentId: 'intent-9',
      },
    },
    {
      kind: 'unpatched_critical',
      severity: 'high',
      deviceId: 'd2',
      deviceHostname: 'WKS-02',
      title: '3 critical CVEs unpatched',
      detail: 'Three critical vulnerabilities have no applied patch.',
      evidence: { cveCount: 3 },
      proposal: {
        tool: 'remediate_vulnerability',
        action: null,
        disposition: 'refused',
        reason: 'not_allowlisted',
        intentId: null,
      },
    },
    {
      kind: 'disk_pressure',
      severity: 'medium',
      deviceId: null,
      deviceHostname: null,
      title: 'Volume C: is 94% full',
      detail: 'Free space has fallen below the 10% floor.',
      evidence: { percentUsed: 94 },
      proposal: null,
    },
    {
      kind: 'stale_agents',
      severity: 'low',
      deviceId: 'd3',
      deviceHostname: 'SRV-03',
      title: 'Agent has not checked in for 6 days',
      detail: 'Last heartbeat was 2026-08-23.',
      evidence: { lastSeenDays: 6 },
      proposal: {
        tool: 'manage_services',
        action: 'restart',
        disposition: 'cap_reached',
        reason: 'max_actions_per_run',
        intentId: null,
      },
    },
    {
      kind: 'pending_reboots',
      severity: 'info',
      deviceId: 'd3',
      deviceHostname: 'SRV-03',
      title: 'Reboot pending since Tuesday',
      detail: 'A servicing operation is waiting on a restart.',
      evidence: { pendingSince: '2026-08-25' },
      proposal: {
        tool: 'manage_services',
        action: 'restart',
        disposition: 'error',
        reason: 'intent_error',
        intentId: null,
      },
    },
    {
      kind: 'failed_backups',
      severity: 'high',
      deviceId: 'd2',
      deviceHostname: 'WKS-02',
      title: 'Nightly backup failed twice',
      detail: 'The last two scheduled backup jobs ended in failure.',
      evidence: { failures: 2 },
      proposal: {
        tool: 'remediate_vulnerability',
        action: null,
        disposition: 'refused',
        reason: 'device_not_in_org',
        intentId: null,
      },
    },
  ],
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

  it('names the act-mode op key and target on an executed entry', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-trace-entry-3')).toBeInTheDocument());
    const entry = screen.getByTestId('run-detail-trace-entry-3');
    expect(entry).toHaveTextContent('service.restart');
    expect(entry).toHaveTextContent('Spooler');
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

  it('renders a translated trigger label and a device-anomalies link for an anomaly-triggered run (wave 6 PR 4, #3828)', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, triggerKind: 'anomaly' as const, anomalyIncidentId: 'incident-1' } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.getByText('Anomaly')).toBeInTheDocument();
    const link = screen.getByTestId('run-detail-anomaly-link');
    expect(link).toHaveAttribute('href', '/devices/d1#anomalies');
  });

  it('omits the device-anomalies link for a non-anomaly run', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.queryByTestId('run-detail-anomaly-link')).not.toBeInTheDocument();
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

// Phase 2 wave P2-2 (#4189, Task 14) — the sweep-findings section.
describe('RunDetailPage sweep findings', () => {
  it('renders nothing when the run carries no sweep outcome', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: null } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-sweep')).not.toBeInTheDocument();
  });

  it('renders the summary, the evidence-truncated note and one row per finding', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-sweep-summary')).toHaveTextContent(
      'Six problems found across three devices.',
    );
    expect(screen.getByTestId('ai-agent-run-sweep-truncated')).toBeInTheDocument();
    for (let index = 0; index < 6; index += 1) {
      expect(screen.getByTestId(`ai-agent-run-sweep-finding-${index}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('ai-agent-run-sweep-finding-6')).not.toBeInTheDocument();
  });

  it('omits the evidence-truncated note when nothing was truncated', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: { ...SWEEP, evidenceTruncated: false } } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-sweep-truncated')).not.toBeInTheDocument();
  });

  it('translates the kind and severity and shows the hostname, title and detail', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0')).toBeInTheDocument());
    const row = screen.getByTestId('ai-agent-run-sweep-finding-0');
    expect(row).toHaveTextContent('Service down');
    expect(row).toHaveTextContent('Critical');
    expect(row).toHaveTextContent('WKS-01');
    expect(row).toHaveTextContent('Print Spooler is stopped');
    expect(row).toHaveTextContent('The watched Spooler service has been stopped since 09:12.');
  });

  it('renders evidence as key/value pairs rather than a raw JSON blob', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    const { container } = render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-sweep-finding-0-evidence')).toHaveTextContent('serviceName: Spooler');
    expect(screen.getByTestId('ai-agent-run-sweep-finding-0-evidence')).toHaveTextContent('state: stopped');
    // A JSON dump would carry the object punctuation; the k/v rendering never does.
    expect(container.innerHTML).not.toContain('{&quot;serviceName&quot;');
  });

  it('falls back to an em dash for a fleet-wide finding with no hostname', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-2')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-sweep-finding-2-device')).toHaveTextContent('—');
  });

  it('links an intent_created proposal to Approvals', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0')).toBeInTheDocument());
    const link = screen.getByTestId('ai-agent-run-sweep-proposal-link-0');
    expect(link).toHaveAttribute('href', '/approvals');
    expect(link).toHaveTextContent('Approval requested');
  });

  it('shows a translated reason instead of a link for a refused proposal', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-1')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-sweep-proposal-link-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-run-sweep-finding-1-proposal')).toHaveTextContent(
      'Tool not allowed for this agent',
    );
  });

  it('shows an em dash when a finding proposed nothing', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-2')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-sweep-finding-2-proposal')).toHaveTextContent('—');
  });

  it('translates every proposal reason rather than leaking the raw token', async () => {
    const reasons = [
      'device_not_in_evidence',
      'device_not_in_org',
      'not_allowlisted',
      'no_eligible_approvers',
      'intent_error',
      'max_actions_per_run',
    ];
    const findings = reasons.map((reason, index) => ({
      ...SWEEP.findings[1],
      title: `Finding ${index}`,
      proposal: { ...SWEEP.findings[1].proposal, reason },
    }));
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: { ...SWEEP, findings } } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-5')).toBeInTheDocument());
    reasons.forEach((reason, index) => {
      const cell = screen.getByTestId(`ai-agent-run-sweep-finding-${index}-proposal`);
      expect(cell.textContent).not.toBe(reason);
      expect(cell.textContent?.trim().length).toBeGreaterThan(0);
      // The raw enum token must never reach the DOM — an untranslated key
      // renders as the key itself, which would contain the token.
      expect(cell.textContent).not.toContain(reason);
    });
  });

  it('names the sweep kinds it checked', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-kinds')).toBeInTheDocument());
    const kinds = screen.getByTestId('ai-agent-run-sweep-kinds');
    expect(kinds).toHaveTextContent('Service down');
    expect(kinds).toHaveTextContent('Failed backups');
    expect(kinds.textContent).not.toContain('service_down');
  });
});
