import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../reports/reportExport', () => ({
  exportReport: vi.fn().mockResolvedValue(undefined),
  getBrowserTimezone: () => 'UTC',
}));

import RunDetailPage from './RunDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { exportReport } from '../reports/reportExport';

const fetchMock = vi.mocked(fetchWithAuth);
const exportReportMock = vi.mocked(exportReport);

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

// Phase 2 wave P2-3 (#4190) — a `narrative`-profile run's outcome projection
// (`AiAgentRunNarrativeDto`). All eight sections, in NARRATIVE_SECTION_KEYS
// order, with the server-attached titles the report itself uses.
const NARRATIVE = {
  headline: 'A quiet week: 3 alerts closed and every backup green.',
  sections: [
    { key: 'overview', title: 'Overview', bullets: ['12 devices monitored all week.'] },
    { key: 'alerts', title: 'Alerts', bullets: ['3 alerts raised, all closed.', 'No repeat offenders.'] },
    { key: 'sweeps_and_fixes', title: 'Sweeps & fixes', bullets: ['Spooler restarted on WKS-01.'] },
    { key: 'tickets', title: 'Tickets', bullets: ['2 tickets resolved.'] },
    { key: 'patching_and_security', title: 'Patching & security', bullets: ['No critical CVEs outstanding.'] },
    { key: 'backups', title: 'Backups', bullets: ['Every nightly job succeeded.'] },
    { key: 'fleet', title: 'Fleet', bullets: ['One device added.'] },
    { key: 'recommendations', title: 'Recommendations', bullets: ['Schedule the SRV-03 reboot.'] },
  ],
  reportRunId: 'rr-1',
  reportId: 'rep-1',
  downloadPath: '/api/reports/runs/rr-1/download',
  periodStart: '2026-08-17T00:00:00.000Z',
  periodEnd: '2026-08-24T00:00:00.000Z',
  contextTruncated: false,
};

// P2-4 (#4191, Task 12) — a `triage`-profile run's ticket proposal
// (`AiAgentRunTicketProposalDto`). Every field carries a DISTINCT value (not
// a uniform fixture) so a wrong-field bug — e.g. rendering `priority.value`
// under the `categoryId` label — cannot hide behind matching text.
const TICKET_PROPOSAL = {
  version: 1 as const,
  summary: 'Printer offline; the user needs the driver reinstalled.',
  fields: {
    categoryId: { value: 'cat-hardware-printer', confidence: 0.82 },
    priority: { value: 'high' as const, confidence: 0.65 },
  },
  device: { hostname: 'WKS-07', serial: 'SN-778812' },
  draftReply: 'Hi Jordan, we are dispatching a fix for the printer driver now.',
  draftResolutionNote: 'Reinstalled the HP LaserJet driver remotely; test page printed cleanly.',
  notes: ['User reported the issue at 08:12.', 'No other devices affected on this site.'],
  intentIds: ['intent-42'],
  draftsWritten: [{ kind: 'reply' as const, draftId: 'draft-91' }],
};

const TICKET_INTENT = {
  id: 'intent-42',
  status: 'approved',
  actionName: 'manage_tickets:update_fields',
  approvalScope: 'supervised' as const,
  decidedVia: 'policy',
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
  exportReportMock.mockReset();
  exportReportMock.mockResolvedValue(undefined);
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

  it('renders evidence as a definition list of key/value pairs rather than a raw JSON blob or a flattened string', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    const { container } = render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0')).toBeInTheDocument());
    const evidence = screen.getByTestId('ai-agent-run-sweep-finding-0-evidence');
    // A real <dl> with <dt>/<dd> pairs — not a flattened "k: v · k: v" string
    // — so a screen reader gets term/value structure.
    expect(evidence.tagName).toBe('DL');
    const terms = evidence.querySelectorAll('dt');
    const values = evidence.querySelectorAll('dd');
    expect(Array.from(terms).map((el) => el.textContent)).toEqual(['serviceName:', 'state:']);
    expect(Array.from(values).map((el) => el.textContent)).toEqual(['Spooler', 'stopped']);
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

// Phase 2 wave P2-3 (#4190) — the weekly-narrative section.
describe('RunDetailPage narrative', () => {
  it('renders nothing when the run produced no narrative', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: null } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-narrative')).not.toBeInTheDocument();
  });

  it('renders the headline and all eight sections with their bullets', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: NARRATIVE } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-narrative-headline')).toHaveTextContent(
      'A quiet week: 3 alerts closed and every backup green.',
    );
    for (const section of NARRATIVE.sections) {
      const block = screen.getByTestId(`ai-agent-run-narrative-section-${section.key}`);
      expect(block).toHaveTextContent(section.title);
      for (const bullet of section.bullets) expect(block).toHaveTextContent(bullet);
    }
  });

  it('renders a model-authored bullet as text, never as markup', async () => {
    const injected = '<img src=x onerror="alert(1)"> and **not bold**';
    const narrative = {
      ...NARRATIVE,
      sections: NARRATIVE.sections.map((section, index) =>
        index === 0 ? { ...section, bullets: [injected] } : section),
    };
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative')).toBeInTheDocument());
    const block = screen.getByTestId('ai-agent-run-narrative-section-overview');
    // The literal characters survive as text; no element was created from them.
    expect(block).toHaveTextContent(injected);
    expect(block.querySelector('img')).toBeNull();
  });

  it('links to the generated report and offers the download as a button, never a raw API anchor', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: NARRATIVE } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-run-narrative-report-link')).toHaveAttribute('href', '/reports');

    // The download route answers JSON and authenticates from the Authorization
    // header only, so an <a href> to it is dead in a browser. It must be a
    // button that fetches + renders client-side.
    const download = screen.getByTestId('ai-agent-run-narrative-download');
    expect(download.tagName).toBe('BUTTON');
    expect(download).not.toHaveAttribute('href');
  });

  it('fetches the stored snapshot and hands the narrative summary to exportReport', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: NARRATIVE } });
    const snapshot = {
      type: 'ai_org_narrative',
      format: 'pdf',
      data: { rows: [], summary: { narrative: { headline: NARRATIVE.headline, sections: NARRATIVE.sections } } },
    };
    render(<RunDetailPage runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative')).toBeInTheDocument());

    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/reports/runs/') ? json(snapshot) : json({ data: [] })));
    fireEvent.click(screen.getByTestId('ai-agent-run-narrative-download'));

    await waitFor(() => expect(exportReportMock).toHaveBeenCalledTimes(1));
    // Bearer-authenticated fetch against the API-relative path, not the raw
    // /api/... downloadPath a browser navigation would have used.
    expect(fetchMock).toHaveBeenCalledWith('/reports/runs/rr-1/download');
    expect(exportReportMock).toHaveBeenCalledWith([], expect.objectContaining({
      format: 'pdf',
      reportType: 'ai_org_narrative',
      summary: snapshot.data.summary,
    }));
    expect(screen.queryByTestId('ai-agent-run-narrative-download-error')).not.toBeInTheDocument();
  });

  it('surfaces an inline error when the snapshot fetch fails, and never calls exportReport', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: NARRATIVE } });
    render(<RunDetailPage runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative')).toBeInTheDocument());

    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/reports/runs/')
        ? json({ error: 'nope' }, false, 404)
        : json({ data: [] })));
    fireEvent.click(screen.getByTestId('ai-agent-run-narrative-download'));

    await waitFor(() =>
      expect(screen.getByTestId('ai-agent-run-narrative-download-error')).toBeInTheDocument());
    expect(exportReportMock).not.toHaveBeenCalled();
  });

  it('omits both links for a narrative that never reached a report run', async () => {
    const narrative = { ...NARRATIVE, reportRunId: null, reportId: null, downloadPath: null };
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-narrative-report-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-run-narrative-download')).not.toBeInTheDocument();
  });

  it('says so when the run\'s context was cut short, and stays quiet when it was not', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: { ...NARRATIVE, contextTruncated: true } } });
    const { unmount } = render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative-truncated')).toBeInTheDocument());
    unmount();

    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: NARRATIVE } });
    render(<RunDetailPage runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-narrative-truncated')).not.toBeInTheDocument();
  });

  it('names the reporting window it covers', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, narrative: NARRATIVE } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-narrative-period')).toBeInTheDocument());
    const period = screen.getByTestId('ai-agent-run-narrative-period');
    // Formatted through the locale date formatter, never the raw ISO string.
    expect(period.textContent).not.toContain('2026-08-17T00:00:00.000Z');
    expect(period.textContent).toContain('2026');
  });
});

// P2-4 (#4191, Task 12) — the ticket-triage proposal section: a
// `triage`-profile run's outcome (`AiAgentRunTicketProposalDto`). Same
// "renders nothing when absent" contract as the sweep/narrative sections
// above — `ticketProposal` is null for every other profile.
describe('RunDetailPage ticket triage proposal', () => {
  it('renders nothing when the run carries no ticket proposal', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, ticketProposal: null } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-page')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-run-triage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-detail-profile-triage')).not.toBeInTheDocument();
  });

  it('badges the run as triage in the header and renders the proposal summary', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, ticketProposal: TICKET_PROPOSAL, intents: [TICKET_INTENT] } });
    render(<RunDetailPage runId="run-1" />);

    expect(await screen.findByTestId('run-detail-profile-triage')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-run-triage-summary')).toHaveTextContent(TICKET_PROPOSAL.summary);
  });

  it('renders each proposed field with its OWN confidence — not the sibling field\'s', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, ticketProposal: TICKET_PROPOSAL, intents: [TICKET_INTENT] } });
    render(<RunDetailPage runId="run-1" />);

    const categoryRow = await screen.findByTestId('ai-agent-run-triage-field-categoryId');
    // Critique finding #6: the DTO carries no resolved category NAME, only a
    // raw internal category UUID (`fields.categoryId.value`) — that id must
    // never reach the DOM. Only its confidence is shown.
    expect(categoryRow).not.toHaveTextContent('cat-hardware-printer');
    expect(categoryRow).toHaveTextContent('82');

    const priorityRow = screen.getByTestId('ai-agent-run-triage-field-priority');
    expect(priorityRow).toHaveTextContent('high');
    expect(priorityRow).toHaveTextContent('65');
    // Cross-contamination guard: the category row must not carry priority's
    // confidence value, and vice versa.
    expect(categoryRow).not.toHaveTextContent('65');
    expect(priorityRow).not.toHaveTextContent('82');
  });

  it('renders the proposed device identifiers, notes, and both drafts', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, ticketProposal: TICKET_PROPOSAL, intents: [TICKET_INTENT] } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => screen.getByTestId('ai-agent-run-triage'));
    expect(screen.getByTestId('ai-agent-run-triage-device')).toHaveTextContent('WKS-07');
    expect(screen.getByTestId('ai-agent-run-triage-device')).toHaveTextContent('SN-778812');
    expect(screen.getByTestId('ai-agent-run-triage-notes')).toHaveTextContent('User reported the issue at 08:12.');
    expect(screen.getByTestId('ai-agent-run-triage-notes')).toHaveTextContent('No other devices affected on this site.');
    expect(screen.getByTestId('ai-agent-run-triage-draft-reply')).toHaveTextContent(TICKET_PROPOSAL.draftReply);
    expect(screen.getByTestId('ai-agent-run-triage-draft-resolution')).toHaveTextContent(TICKET_PROPOSAL.draftResolutionNote);
  });

  it('links a proposal intent to its live status from the run\'s intents array, and lists the draft written', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, ticketProposal: TICKET_PROPOSAL, intents: [TICKET_INTENT] } });
    render(<RunDetailPage runId="run-1" />);

    const intentRow = await screen.findByTestId('ai-agent-run-triage-intent-intent-42');
    expect(intentRow).toHaveTextContent('manage_tickets:update_fields');
    expect(intentRow).toHaveTextContent('approved');

    expect(screen.getByTestId('ai-agent-run-triage-draft-draft-91')).toBeInTheDocument();
  });

  // #4468: a ticket-triage run can propose several intents (one row each),
  // but they all resolve to the SAME /approvals inbox — a link repeated once
  // per row added nothing and read as N distinct destinations. Only one
  // collapsed link should render for the whole intents list.
  it('collapses repeated per-intent /approvals links into a single link', async () => {
    const secondIntent = { ...TICKET_INTENT, id: 'intent-43', actionName: 'manage_tickets:add_note', status: 'pending' };
    mockEndpoints({
      detail: {
        ...RUN_DETAIL,
        ticketProposal: { ...TICKET_PROPOSAL, intentIds: ['intent-42', 'intent-43'] },
        intents: [TICKET_INTENT, secondIntent],
      },
    });
    render(<RunDetailPage runId="run-1" />);

    const intentsSection = await screen.findByTestId('ai-agent-run-triage-intents');
    await screen.findByTestId('ai-agent-run-triage-intent-intent-42');
    await screen.findByTestId('ai-agent-run-triage-intent-intent-43');

    const approvalsLinks = within(intentsSection)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === '/approvals');
    expect(approvalsLinks).toHaveLength(1);
  });

  it('never renders raw tool args/input/output anywhere in the triage section', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, ticketProposal: TICKET_PROPOSAL, intents: [TICKET_INTENT] } });
    const { container } = render(<RunDetailPage runId="run-1" />);

    await waitFor(() => screen.getByTestId('ai-agent-run-triage'));
    const html = container.innerHTML;
    for (const forbidden of ['toolInput', 'toolOutput', 'args', 'arguments']) {
      expect(html).not.toContain(forbidden);
    }
  });

  // Issue #4462 — the per-field skip reasons `persistTicketTriage` computes
  // (ticketTriageFindings.ts) were previously console-only; this asserts
  // they now render on the run detail once the DTO carries them.
  it('renders per-field skip reasons when the proposal carries them', async () => {
    mockEndpoints({
      detail: {
        ...RUN_DETAIL,
        ticketProposal: {
          ...TICKET_PROPOSAL,
          skipped: [
            { item: 'fields', reason: 'below_confidence_floor' },
            { item: 'link', reason: 'device_already_linked' },
          ],
        },
        intents: [TICKET_INTENT],
      },
    });
    render(<RunDetailPage runId="run-1" />);

    const skippedSection = await screen.findByTestId('ai-agent-run-triage-skipped');
    expect(skippedSection).toHaveTextContent(/confidence/i);
    expect(screen.getByTestId('ai-agent-run-triage-skipped-fields')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-run-triage-skipped-link')).toBeInTheDocument();
  });

  it('omits the skipped section when the proposal carries no skips', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, ticketProposal: TICKET_PROPOSAL, intents: [TICKET_INTENT] } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => screen.getByTestId('ai-agent-run-triage'));
    expect(screen.queryByTestId('ai-agent-run-triage-skipped')).not.toBeInTheDocument();
  });
});

// Critique finding #5 — the document outline must run h1 → h2 → h3 with no
// skipped level. The exposure-budget card used to be an h3 sandwiched
// between the page h1 and the next section's h2.
describe('RunDetailPage heading order', () => {
  it('keeps every top-level section at h2, sibling to the exposure-budget card', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-budget-card')).toBeInTheDocument());

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);

    const budgetHeading = screen.getByText('Exposure budget');
    expect(budgetHeading.tagName).toBe('H2');

    const sweepHeading = screen.getByText('Sweep findings');
    expect(sweepHeading.tagName).toBe('H2');

    const traceHeading = screen.getByText('Execution trace');
    expect(traceHeading.tagName).toBe('H2');
  });
});

// Critique finding #6 — the ledger must never print the raw AiToolStatus
// enum token; it goes through i18n first.
describe('RunDetailPage ledger status labels', () => {
  it('translates the ledger status instead of printing the raw enum', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-ledger')).toBeInTheDocument());
    const row = screen.getByTestId('run-detail-ledger').querySelector('tbody tr');
    expect(row).not.toBeNull();
    // RUN_DETAIL.ledger[0].status is the raw enum 'completed' — the cell
    // must show the translated label, not the bare lowercase token.
    expect(row).toHaveTextContent('Completed');
  });
});

// Critique finding #3 — bare muted <p> empty states become a structured
// EmptyState with a description of what will appear.
describe('RunDetailPage empty states', () => {
  it('renders a not-found EmptyState with a description and a way back to the list', async () => {
    mockEndpoints({ detailOk: false, detailStatus: 404 });
    render(<RunDetailPage runId="missing" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-not-found')).toBeInTheDocument());
    expect(screen.getByText('Run not found.')).toBeInTheDocument();
    expect(screen.getByText(/deleted|out of date/i)).toBeInTheDocument();
    expect(screen.getByText('Back to runs')).toHaveAttribute('href', '/ai-agents/runs');
  });

  it('renders a description in the empty trace/ledger/intents sections instead of a bare line', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, trace: [], ledger: [], intents: [] } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.getByText('No trace entries recorded.')).toBeInTheDocument();
    expect(screen.getByText('Tool calls the agent proposes or executes will be listed here.')).toBeInTheDocument();
    expect(screen.getByText('No tool executions recorded.')).toBeInTheDocument();
    expect(screen.getByText('No linked approvals.')).toBeInTheDocument();
  });
});

// Critique finding #1 — an in-flight run must update on its own; the page
// polls silently (no full-page reload flicker) while status is non-terminal,
// stops once terminal, and pauses while the tab is hidden.
describe('RunDetailPage live polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('polls every 5s while the run is running and reflects the updated status', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, status: 'running' as const } });
    render(<RunDetailPage runId="run-1" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('run-detail-header')).toHaveTextContent('Running');
    expect(screen.getByTestId('run-live-indicator')).toBeInTheDocument();

    mockEndpoints({ detail: { ...RUN_DETAIL, status: 'completed' as const } });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('run-detail-header')).toHaveTextContent('Completed');
    expect(screen.queryByTestId('run-live-indicator')).not.toBeInTheDocument();
  });

  it('never flips the page back to the full-page loading state while polling', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, status: 'running' as const } });
    render(<RunDetailPage runId="run-1" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('run-detail-page')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The header/page stayed mounted throughout — a naive poll that reused
    // `load()` would have flipped `loading` and replaced this with
    // `run-detail-loading` on every tick.
    expect(screen.queryByTestId('run-detail-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-detail-page')).toBeInTheDocument();
  });

  it('stops polling once the run is already terminal on first load', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, status: 'completed' as const } });
    render(<RunDetailPage runId="run-1" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsAfterLoad = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });

  it('pauses polling while the document is hidden', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, status: 'running' as const } });
    render(<RunDetailPage runId="run-1" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const callsAfterLoad = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });

  // Review finding P2-2 (#4187 critique): overlapping poll responses must
  // apply in request order, not resolution order.
  it('discards a stale poll response that resolves after a newer one', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, status: 'running' as const } });
    render(<RunDetailPage runId="run-1" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('run-detail-header')).toHaveTextContent('Running');

    let resolveOlder!: (value: Response) => void;
    let resolveNewer!: (value: Response) => void;
    const detailResponses = [
      new Promise<Response>((resolve) => {
        resolveOlder = resolve;
      }),
      new Promise<Response>((resolve) => {
        resolveNewer = resolve;
      }),
    ];
    let call = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/ai/agents/runs/')) {
        return detailResponses[call++] ?? Promise.resolve(json({ data: RUN_DETAIL }));
      }
      if (url.startsWith('/ai/agents/exposure-budget')) {
        return Promise.resolve(json({ data: BUDGET }));
      }
      return Promise.resolve(json({ data: [] }));
    });

    // Two poll ticks fire back to back (5s cadence while running) before
    // either response resolves.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    // Resolve the NEWER request first with a fresh status, then the OLDER
    // request with a stale one — the stale one must not win.
    resolveNewer(json({ data: { ...RUN_DETAIL, status: 'completed' as const } }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    resolveOlder(json({ data: { ...RUN_DETAIL, status: 'running' as const } }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('run-detail-header')).toHaveTextContent('Completed');
  });
});
