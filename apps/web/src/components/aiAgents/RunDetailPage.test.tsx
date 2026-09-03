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
    // Critique finding #2: the terms are HUMAN labels, never the raw
    // camelCase field names the sweep loader happens to use.
    expect(Array.from(terms).map((el) => el.textContent)).toEqual(['Service name:', 'State:']);
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
    // Critique finding #2: the intent status is translated, never the raw
    // `action_intents.status` token.
    expect(intentRow).toHaveTextContent('Approved');
    expect(intentRow.textContent).not.toContain('approved');

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

// Critique finding #1 — the run summary is the agent's own account of what it
// found. It leads the header (above the machine-derived metadata grid), reads
// at body weight, and renders a safe markdown subset instead of literal
// asterisks and un-listed "1." lines.
describe('RunDetailPage summary', () => {
  it('leads the header with the summary, above the machine-derived metadata grid', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-summary')).toBeInTheDocument());
    expect(screen.getByText('What the agent found')).toBeInTheDocument();

    const summary = screen.getByTestId('run-detail-summary');
    const meta = screen.getByTestId('run-detail-meta');
    // The summary must come FIRST in document order — the metadata grid is
    // supporting detail, not the headline.
    // eslint-disable-next-line no-bitwise
    expect(summary.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders markdown emphasis and ordered lists instead of literal asterisks', async () => {
    const summary = '**WKS-01** is degraded.\n\n1. **Failed backup** (high)\n2. Disk at 94%\n';
    mockEndpoints({ detail: { ...RUN_DETAIL, summary } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-summary')).toBeInTheDocument());
    const block = screen.getByTestId('run-detail-summary');
    expect(block.querySelector('strong')?.textContent).toBe('WKS-01');
    expect(block.querySelectorAll('ol > li')).toHaveLength(2);
    // The raw markup must be GONE, not merely styled around it.
    expect(block.textContent).not.toContain('**');
  });

  it('renders inline code without leaking backticks', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, summary: 'Restarted `Spooler` on WKS-01.' } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-summary')).toBeInTheDocument());
    const block = screen.getByTestId('run-detail-summary');
    expect(block.querySelector('code')?.textContent).toBe('Spooler');
    expect(block.textContent).not.toContain('`');
  });

  it('never turns raw HTML in a model-authored summary into markup', async () => {
    const summary = '<img src=x onerror="alert(1)"> <script>alert(2)</script> **bold**';
    mockEndpoints({ detail: { ...RUN_DETAIL, summary } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-summary')).toBeInTheDocument());
    const block = screen.getByTestId('run-detail-summary');
    expect(block.querySelector('img')).toBeNull();
    expect(block.querySelector('script')).toBeNull();
    // Review finding #7: `skipHtml` drops the raw tag source entirely rather
    // than converting it to literal escaped text — the earlier comment's
    // claim that it was already "dropped" was wrong for react-markdown 10
    // (which turns it into text without `skipHtml`), so this is now the
    // property that actually keeps the tag soup off the screen.
    expect(block.textContent).not.toContain('<img');
    expect(block.textContent).not.toContain('<script');
    // The safe subset still applied to the parts that were markdown.
    expect(block.querySelector('strong')?.textContent).toBe('bold');
  });

  // Review finding #7 — a fenced code block is common in a tool-output
  // summary; `pre` was missing from the allowlist, so `unwrapDisallowed`
  // dropped the wrapping element and left only the bare inline text.
  it('renders a fenced code block as a pre element', async () => {
    const summary = 'Ran:\n\n```\nGet-Service Spooler\n```';
    mockEndpoints({ detail: { ...RUN_DETAIL, summary } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-summary')).toBeInTheDocument());
    const block = screen.getByTestId('run-detail-summary');
    expect(block.querySelector('pre')).not.toBeNull();
    expect(block.querySelector('pre')?.textContent).toContain('Get-Service Spooler');
  });

  it('keeps only http(s) links and renders any other scheme as plain text', async () => {
    const summary = 'See [the runbook](https://example.com/runbook) or [this](javascript:alert(1)).';
    mockEndpoints({ detail: { ...RUN_DETAIL, summary } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-summary')).toBeInTheDocument());
    const block = screen.getByTestId('run-detail-summary');
    const links = Array.from(block.querySelectorAll('a'));
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/runbook');
    // The rejected link keeps its label as text, so no content is lost.
    expect(block.textContent).toContain('this');
    expect(block.innerHTML).not.toContain('javascript:');
  });

  it('omits the whole summary block when the run wrote none', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, summary: null } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.queryByTestId('run-detail-summary')).not.toBeInTheDocument();
  });
});

// Critique finding #1c — a `no_action` verdict on a run that DID produce
// findings/proposals must not claim "No action needed" as the headline.
describe('RunDetailPage verdict vs findings', () => {
  it('badges the count of findings to review instead of claiming no action', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, runVerdict: 'no_action' as const, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    const badge = screen.getByTestId('run-detail-findings-badge');
    // 6 sweep findings + 1 proposed trace entry — the denied trace entry is a
    // guardrail refusing a tool the model attempted, not a finding to review
    // (review finding #6).
    expect(badge).toHaveTextContent('7 findings to review');
    expect(badge.className).toContain('amber');
    // Review finding #7: `run-detail-verdict-badge` is a stable wrapper that
    // survives the override — it's present here too, wrapping the findings
    // badge, so a consumer that always looks for "the verdict badge" never
    // sees it disappear.
    expect(screen.getByTestId('run-detail-verdict-badge')).toContainElement(badge);
    // The verdict itself survives, demoted to secondary text.
    expect(screen.getByTestId('run-detail-verdict-secondary')).toHaveTextContent('No action needed');
  });

  // Review finding #6 — a guardrail DENIAL is the system working as
  // intended, not something left for a human to review; it must never bump
  // the findings count.
  it('does not count a denied trace entry as a finding to review', async () => {
    mockEndpoints({
      detail: {
        ...RUN_DETAIL,
        runVerdict: 'no_action' as const,
        sweep: null,
        trace: [{ kind: 'denied' as const, tool: 'files.delete', reason: 'protected path' }],
      },
    });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    // A denial alone must not trip the findings-override — the plain verdict
    // badge stands.
    expect(screen.getByTestId('run-detail-verdict-badge')).toHaveTextContent('No action needed');
    expect(screen.queryByTestId('run-detail-findings-badge')).not.toBeInTheDocument();
  });

  it('keeps the plain verdict badge when a no-action run really found nothing', async () => {
    mockEndpoints({
      detail: { ...RUN_DETAIL, runVerdict: 'no_action' as const, sweep: null, trace: [] },
    });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.getByTestId('run-detail-verdict-badge')).toHaveTextContent('No action needed');
    expect(screen.queryByTestId('run-detail-findings-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-detail-verdict-secondary')).not.toBeInTheDocument();
  });

  it('leaves a non-no_action verdict alone even when findings exist', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, runVerdict: 'needs_attention' as const, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.getByTestId('run-detail-verdict-badge')).toHaveTextContent('Needs attention');
    expect(screen.queryByTestId('run-detail-findings-badge')).not.toBeInTheDocument();
  });
});

// Critique finding #2 — no machine internals on a reading surface.
describe('RunDetailPage evidence rendering', () => {
  const withEvidence = (evidence: Record<string, string | number | boolean | null>) => ({
    ...RUN_DETAIL,
    sweep: { ...SWEEP, findings: [{ ...SWEEP.findings[0], evidence }] },
  });

  it('renders booleans as words rather than true/false', async () => {
    mockEndpoints({ detail: withEvidence({ knownExploited: true, autoRestartAttempted: false }) });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0-evidence')).toBeInTheDocument());
    const evidence = screen.getByTestId('ai-agent-run-sweep-finding-0-evidence');
    expect(evidence).toHaveTextContent('Yes');
    expect(evidence).toHaveTextContent('No');
    expect(evidence.textContent).not.toContain('true');
    expect(evidence.textContent).not.toContain('false');
  });

  it('formats ISO timestamps through the locale formatter instead of printing them raw', async () => {
    mockEndpoints({ detail: withEvidence({ checkedAt: '2026-08-20T10:00:00.000Z', pendingSince: '2026-08-25' }) });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0-evidence')).toBeInTheDocument());
    const evidence = screen.getByTestId('ai-agent-run-sweep-finding-0-evidence');
    expect(evidence.textContent).not.toContain('2026-08-20T10:00:00.000Z');
    expect(evidence.textContent).not.toContain('2026-08-25');
    expect(evidence.textContent).toContain('2026');
  });

  it('drops opaque uuid identifiers rather than showing them to an operator', async () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    mockEndpoints({
      detail: withEvidence({ deviceVulnerabilityId: uuid, deviceId: 'd1', cveCount: 3 }),
    });
    const { container } = render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0-evidence')).toBeInTheDocument());
    expect(container.innerHTML).not.toContain(uuid);
    // The device id is already the Device column's link target, so it is not
    // repeated as an evidence row either.
    const evidence = screen.getByTestId('ai-agent-run-sweep-finding-0-evidence');
    expect(evidence.textContent).not.toContain('deviceVulnerabilityId');
    expect(evidence).toHaveTextContent('CVE count');
  });

  it('sentence-cases an unmapped key instead of printing camelCase', async () => {
    mockEndpoints({ detail: withEvidence({ pendingSince: 'soon', watchType: 'service' }) });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0-evidence')).toBeInTheDocument());
    const evidence = screen.getByTestId('ai-agent-run-sweep-finding-0-evidence');
    expect(evidence).toHaveTextContent('Pending since');
    expect(evidence).toHaveTextContent('Watch type');
    expect(evidence.textContent).not.toContain('pendingSince');
    expect(evidence.textContent).not.toContain('watchType');
  });

  it('links the finding device to its device page', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-0-device')).toBeInTheDocument());
    const link = screen.getByTestId('ai-agent-run-sweep-finding-0-device').querySelector('a');
    expect(link).toHaveAttribute('href', '/devices/d1');
    expect(link).toHaveTextContent('WKS-01');
  });

  it('translates a linked-approval status instead of printing the raw enum token', async () => {
    mockEndpoints({
      detail: { ...RUN_DETAIL, intents: [{ ...RUN_DETAIL.intents[0], status: 'pending_approval' }] },
    });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-intents')).toBeInTheDocument());
    const list = screen.getByTestId('run-detail-intents');
    expect(list).toHaveTextContent('Awaiting approval');
    expect(list.textContent).not.toContain('pending_approval');
  });
});

// Critique finding #3 — the one actionable finding must not be a dead end.
describe('RunDetailPage sweep proposal affordances', () => {
  it("links a not-allowlisted proposal to the agent's permissions", async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-1-proposal')).toBeInTheDocument());
    const cell = screen.getByTestId('ai-agent-run-sweep-finding-1-proposal');
    expect(cell).toHaveTextContent('Tool not allowed for this agent');
    const link = screen.getByTestId('ai-agent-run-sweep-permissions-link-1');
    expect(link).toHaveAttribute('href', '/settings/ai-agents#agent=a1');
    // Warning tone, not muted: this is the one thing the operator can fix.
    expect(cell.className).toContain('amber');
  });

  it('leaves a non-permissions reason unlinked but still in warning tone', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-3-proposal')).toBeInTheDocument());
    const cell = screen.getByTestId('ai-agent-run-sweep-finding-3-proposal');
    expect(cell).toHaveTextContent('Action limit reached for this run');
    expect(screen.queryByTestId('ai-agent-run-sweep-permissions-link-3')).not.toBeInTheDocument();
    expect(cell.className).toContain('amber');
  });
});

// Critique finding #4 — duration belongs in the status row, and a sub-second
// tool call must not read as "0s".
describe('RunDetailPage duration', () => {
  it('shows the run duration in the status row', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.getByTestId('run-detail-header-duration')).toHaveTextContent('4m 55s');
  });

  it('renders a sub-second tool call in milliseconds rather than 0s', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-trace-entry-3')).toBeInTheDocument());
    // trace[3].durationMs is 250 — `Math.round(250/1000)` floored it to "0s".
    const entry = screen.getByTestId('run-detail-trace-entry-3');
    expect(entry).toHaveTextContent('250ms');
    expect(entry.textContent).not.toContain('0s');
  });

  // Review finding #7 — `formatDuration` fell through to `Math.round(NaN / 1000)`
  // and rendered the literal string "NaNs" for any non-numeric input; a run
  // with no `startedAt` (queued but never dequeued) hits this via the header,
  // and a ledger entry with a missing `durationMs` hits it directly.
  it('shows a dash rather than "NaNs" for a run with no startedAt', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, startedAt: null } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header-duration')).toBeInTheDocument());
    const duration = screen.getByTestId('run-detail-header-duration');
    expect(duration).toHaveTextContent('—');
    expect(duration.textContent).not.toContain('NaN');
  });

  it('shows a dash rather than "NaNs" for a ledger entry with an undefined durationMs', async () => {
    mockEndpoints({
      detail: {
        ...RUN_DETAIL,
        ledger: [{ ...RUN_DETAIL.ledger[0], durationMs: undefined as unknown as number }],
      },
    });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-ledger')).toBeInTheDocument());
    const table = screen.getByTestId('run-detail-ledger');
    expect(table.textContent).not.toContain('NaN');
  });
});

// Critique finding #5 — an exposure readout of "0 of 0 devices" is noise.
describe('RunDetailPage exposure budget gating', () => {
  it('hides the card entirely for a run that targeted no device', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, deviceId: null, deviceHostname: null, sweep: null } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    expect(screen.queryByTestId('run-detail-budget-card')).not.toBeInTheDocument();
  });

  it('still shows the card for a device-less sweep run that touched devices', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, deviceId: null, deviceHostname: null, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-budget-card')).toBeInTheDocument());
  });

  it('hides the card when the readout itself is 0 of 0', async () => {
    mockEndpoints({ budget: { ...BUDGET, distinctDevices: 0, allowance: 0 } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-header')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('run-detail-budget-loading')).not.toBeInTheDocument());
    expect(screen.queryByTestId('run-detail-budget-card')).not.toBeInTheDocument();
  });
});

// Critique finding #6 — the findings table needs an accessible caption, and
// the two trace-shaped sections must say how they differ.
describe('RunDetailPage accessibility', () => {
  it('gives the sweep findings table a visually-hidden caption', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-findings')).toBeInTheDocument());
    const caption = screen.getByTestId('ai-agent-run-sweep-findings').querySelector('caption');
    expect(caption).not.toBeNull();
    expect(caption?.className).toContain('sr-only');
    expect(caption?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('explains how the execution trace and the tool-execution ledger differ', async () => {
    mockEndpoints();
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run-detail-trace')).toBeInTheDocument());
    const traceDescription = screen.getByTestId('run-detail-trace-description');
    const ledgerDescription = screen.getByTestId('run-detail-ledger-description');
    expect(traceDescription.textContent?.trim().length).toBeGreaterThan(0);
    expect(ledgerDescription.textContent?.trim().length).toBeGreaterThan(0);
    // Two sections that render the same single row must not carry the same
    // explanation, or the reader learns nothing about the difference.
    expect(traceDescription.textContent).not.toBe(ledgerDescription.textContent);
  });
});

// Critique finding #7 — at 390px the six-column findings table degraded into
// two visible columns and ~250px-tall empty rows. Stacked cards below `md`.
describe('RunDetailPage findings at narrow widths', () => {
  it('renders one stacked card per finding below md, and keeps the table from md up', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-cards')).toBeInTheDocument());
    const cards = screen.getByTestId('ai-agent-run-sweep-finding-cards');
    expect(cards.className).toContain('md:hidden');
    for (let index = 0; index < 6; index += 1) {
      expect(screen.getByTestId(`ai-agent-run-sweep-finding-card-${index}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('ai-agent-run-sweep-finding-card-6')).not.toBeInTheDocument();

    const tableWrapper = screen.getByTestId('ai-agent-run-sweep-findings-table-wrapper');
    expect(tableWrapper.className).toContain('hidden');
    expect(tableWrapper.className).toContain('md:block');
  });

  it('carries the full finding on a card — severity, device, title, detail, evidence and proposal', async () => {
    mockEndpoints({ detail: { ...RUN_DETAIL, sweep: SWEEP } });
    render(<RunDetailPage runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-run-sweep-finding-card-0')).toBeInTheDocument());
    const card = screen.getByTestId('ai-agent-run-sweep-finding-card-0');
    expect(card).toHaveTextContent('Critical');
    expect(card).toHaveTextContent('WKS-01');
    expect(card).toHaveTextContent('Print Spooler is stopped');
    expect(card).toHaveTextContent('The watched Spooler service has been stopped since 09:12.');
    expect(screen.getByTestId('ai-agent-run-sweep-finding-card-0-evidence')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-run-sweep-card-proposal-link-0')).toHaveAttribute('href', '/approvals');
  });
});
