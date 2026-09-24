import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_DESIGNER_ENABLE_ERROR_CODES, type FleetDesignOutcome } from '@breeze/shared';
import en from '../../locales/en/fleetDesign.json';
import FleetDesignPage from './FleetDesignPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) }));

// usePermissions reads useAuthStore, which the auth mock above does not
// provide — stub the hook itself, with a per-test switch for ai_agents:write.
const canWriteAgentsMock = vi.fn(() => true);
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: [],
    can: (_resource: string, action: string) => (action === 'write' ? canWriteAgentsMock() : true),
  }),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: Array<{ id: string; name: string }>; currentOrgId: string | null }) => unknown) =>
    selector({
      organizations: [
        { id: 'org-1', name: 'Acme MSP Customer' },
        { id: 'org-2', name: 'Other Org' },
      ],
      currentOrgId: 'org-1',
    }),
}));

const listDesignsMock = vi.fn();
const getDesignMock = vi.fn();
const listAppliedMock = vi.fn();
const startDesignRunMock = vi.fn();
const rollbackMock = vi.fn();
const fileAsDocumentMock = vi.fn();
const getDesignerSetupMock = vi.fn();
const enableDesignerMock = vi.fn();

vi.mock('@/lib/api/fleetDesign', () => ({
  getDesignerSetup: (...args: unknown[]) => getDesignerSetupMock(...args),
  enableDesigner: (...args: unknown[]) => enableDesignerMock(...args),
  listDesigns: (...args: unknown[]) => listDesignsMock(...args),
  getDesign: (...args: unknown[]) => getDesignMock(...args),
  listApplied: (...args: unknown[]) => listAppliedMock(...args),
  startDesignRun: (...args: unknown[]) => startDesignRunMock(...args),
  rollback: (...args: unknown[]) => rollbackMock(...args),
  fileAsDocument: (...args: unknown[]) => fileAsDocumentMock(...args),
}));

// The drawer has its own full test suite (ApplyDrawer.test.tsx) — stub it here
// so this page's tests exercise only list/select/viewer wiring.
vi.mock('./ApplyDrawer', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="apply-drawer-stub" /> : null),
}));

const OUTCOME: FleetDesignOutcome = {
  schemaVersion: 1,
  generatedAt: '2026-09-01T00:00:00.000Z',
  markdown: '# Fleet Design',
  thresholds: { confidence: 0.6, precursors: { diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2 } },
  sections: {
    found: { summary: ['12 devices assessed'], findings: [{ title: 'Domain controllers', deviceCount: 2, evidence: [] }] },
    functions: [
      { functionKey: 'shared_workstation', label: 'Workstation', deviceIds: ['d1', 'd2'], confidence: 0.9, evidence: [], itemRef: 'functions:shared_workstation' },
    ],
    monitoring: [
      {
        functionKey: 'shared_workstation',
        watches: [
          { watchType: 'service', name: 'spooler', alertOnStop: true, autoRestart: false, rationale: 'printing', itemRef: 'monitoring:shared_workstation:watch:0' },
        ],
        alertRules: [
          {
            name: 'High CPU',
            severity: 'high',
            kind: 'cpu',
            condition: { operator: 'gt', value: 90 },
            responses: [],
            deliveryMode: 'inherit',
            deliveryChannelIds: [],
            cooldownMinutes: 15,
            rationale: 'CPU pressure',
            action: 'none',
            paging: 'none',
            itemRef: 'monitoring:shared_workstation:rule:0',
          },
        ],
      },
    ],
    retired: [{ kind: 'watch', policyId: 'p1', policyName: 'Old Policy', itemName: 'Old Watch', reason: 'superseded', itemRef: 'retired:0' }],
    automation: [{ functionKey: 'shared_workstation', playbooks: [], scripts: [{ name: 'Cleanup', purpose: 'disk space', osTypes: ['windows'], language: 'powershell', content: '' }] }],
    legacy: [{ scriptId: 'sc-1', scriptName: 'old-cleanup.ps1', intent: 'disk cleanup', bucket: 'covered', notes: 'replaced by Cleanup' }],
    baseline: { notes: ['Alerts per 100 endpoints trending down'], numbers: { alertsPer100EndpointsPerMonth: 3, ticketsPerMonth: 5, precursors: [] } },
    unsure: {
      lowConfidenceFunctions: [],
      unreachableDevices: [],
      needsHuman: ['Confirm the print server role'],
      roleCorrections: [
        { deviceId: 'd3', currentRole: 'workstation', proposedRole: 'server', evidence: [], billingRelevant: true, itemRef: 'roleCorrections:d3' },
      ],
    },
  },
};

const LIST_ITEM = {
  reportRunId: 'run-1',
  reportId: 'report-1',
  orgId: 'org-1',
  generatedAt: '2026-09-01T00:00:00.000Z',
  runId: 'agent-run-1',
  functionCount: 1,
  watchCount: 1,
  ruleCount: 1,
  evidenceTruncated: false,
};

const DETAIL = {
  reportRunId: 'run-1',
  reportId: 'report-1',
  orgId: 'org-1',
  summary: { fleetDesign: { outcome: OUTCOME } },
  markdown: '# Fleet Design',
  downloadPath: '/api/reports/runs/run-1/download',
};

describe('FleetDesignPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    listDesignsMock.mockResolvedValue([LIST_ITEM]);
    getDesignMock.mockResolvedValue(DETAIL);
    listAppliedMock.mockResolvedValue([]);
    getDesignerSetupMock.mockResolvedValue({ status: 'ready', agentId: 'agent-1', canEnable: false });
    canWriteAgentsMock.mockReturnValue(true);
  });

  // #6214: the page bootstraps its own designer agent instead of dead-ending
  // on "No designer agent is configured" with no way forward.
  describe('designer setup banner', () => {
    it('shows nothing when a designer agent is ready', async () => {
      render(<FleetDesignPage />);
      await waitFor(() => expect(getDesignerSetupMock).toHaveBeenCalledWith('org-1'));
      expect(screen.queryByTestId('fleet-design-designer-setup')).not.toBeInTheDocument();
    });

    it('offers one-click enable when no designer exists and the user can create one', async () => {
      getDesignerSetupMock
        .mockResolvedValueOnce({ status: 'missing', agentId: null, canEnable: true })
        .mockResolvedValue({ status: 'ready', agentId: 'agent-1', canEnable: false });
      enableDesignerMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { status: 'ready', agentId: 'agent-1', canEnable: false } }),
      });
      render(<FleetDesignPage />);

      const banner = await screen.findByTestId('fleet-design-designer-setup');
      expect(banner).toHaveAttribute('data-status', 'missing');
      expect(banner.textContent).toContain('No Fleet Designer agent');
      fireEvent.click(screen.getByTestId('fleet-design-enable-button'));

      await waitFor(() => expect(enableDesignerMock).toHaveBeenCalledWith('org-1'));
      await waitFor(() => expect(screen.queryByTestId('fleet-design-designer-setup')).not.toBeInTheDocument());
    });

    it('explains an off agent and offers to turn it on', async () => {
      getDesignerSetupMock.mockResolvedValue({ status: 'off', agentId: 'agent-1', canEnable: true });
      render(<FleetDesignPage />);

      const banner = await screen.findByTestId('fleet-design-designer-setup');
      expect(banner.textContent).toContain('turned off');
      expect(screen.getByTestId('fleet-design-enable-button')).toBeInTheDocument();
    });

    it('hides the button and names the remedy when the caller cannot enable (org token, partner baseline)', async () => {
      getDesignerSetupMock.mockResolvedValue({ status: 'missing', agentId: null, canEnable: false });
      render(<FleetDesignPage />);

      const banner = await screen.findByTestId('fleet-design-designer-setup');
      expect(screen.queryByTestId('fleet-design-enable-button')).not.toBeInTheDocument();
      expect(banner.textContent).toContain('partner administrator');
    });

    it('hides the button for a read-only user even when the server says it could be enabled', async () => {
      canWriteAgentsMock.mockReturnValue(false);
      getDesignerSetupMock.mockResolvedValue({ status: 'missing', agentId: null, canEnable: true });
      render(<FleetDesignPage />);

      await screen.findByTestId('fleet-design-designer-setup');
      expect(screen.queryByTestId('fleet-design-enable-button')).not.toBeInTheDocument();
    });

    it('has friendly copy for every enable error code the API can answer with', () => {
      const errors = (en as { page: { designerSetup: { errors: Record<string, string> } } }).page.designerSetup.errors;
      for (const code of FLEET_DESIGNER_ENABLE_ERROR_CODES) {
        const key = code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        expect(errors[key], `page.designerSetup.errors.${key}`).toBeTruthy();
      }
    });

    it('never offers enable for the platform kill switch', async () => {
      getDesignerSetupMock.mockResolvedValue({ status: 'kill_switch_off', agentId: 'agent-1', canEnable: false });
      render(<FleetDesignPage />);

      const banner = await screen.findByTestId('fleet-design-designer-setup');
      expect(banner.textContent).toContain('platform-wide');
      expect(screen.queryByTestId('fleet-design-enable-button')).not.toBeInTheDocument();
    });

    it('turns the run route\'s 404 no_designer_agent into the same inline reason as a skip', async () => {
      startDesignRunMock.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'no_designer_agent' }),
      });
      render(<FleetDesignPage />);

      await waitFor(() => expect(listDesignsMock).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId('fleet-design-start-button'));

      await waitFor(() => expect(screen.getByTestId('fleet-design-start-skip-reason')).toBeInTheDocument());
      expect(screen.getByTestId('fleet-design-start-skip-reason').textContent).toContain('No Fleet Designer agent');
      // The probe re-runs after a declined start so the banner catches up.
      await waitFor(() => expect(getDesignerSetupMock).toHaveBeenCalledTimes(2));
    });
  });

  it('lists designs, selects a row, and renders all eight sections of the outcome', async () => {
    render(<FleetDesignPage />);

    await waitFor(() => expect(listDesignsMock).toHaveBeenCalledWith('org-1'));
    await waitFor(() => expect(screen.getByTestId('fleet-design-list-row-run-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('fleet-design-list-row-run-1'));

    await waitFor(() => expect(getDesignMock).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(screen.getByTestId('fleet-design-viewer')).toBeInTheDocument());

    for (const key of ['found', 'functions', 'monitoring', 'retired', 'automation', 'legacy', 'baseline', 'unsure']) {
      expect(screen.getByTestId(`fleet-design-section-${key}`)).toBeInTheDocument();
    }
    expect(window.location.hash).toBe('#run-1');
  });

  it('renders the drift banner and table when the design carries drift (W05)', async () => {
    getDesignMock.mockResolvedValue({
      ...DETAIL,
      summary: {
        fleetDesign: {
          outcome: OUTCOME,
          drift: {
            approvedReportRunId: 'run-0',
            appliedAt: '2026-06-01T10:00:00.000Z',
            missing: [{ functionKey: 'shared_workstation', kind: 'rule', name: 'High CPU' }],
            extra: [{ policyId: 'p9', policyName: 'Hand-made', kind: 'watch', name: 'Fax', deviceCount: 3 }],
            changed: [{ functionKey: 'shared_workstation', kind: 'watch', name: 'spooler', field: 'enabled', approved: 'true', live: 'false' }],
          },
        },
      },
    });
    window.location.hash = '#run-1';
    render(<FleetDesignPage />);

    await waitFor(() => expect(screen.getByTestId('fleet-design-drift')).toBeInTheDocument());
    const banner = screen.getByTestId('fleet-design-drift-banner');
    expect(banner.textContent).toContain('1 missing');
    expect(banner.textContent).toContain('1 extra');
    expect(banner.textContent).toContain('1 changed');
    expect(screen.getByTestId('fleet-design-drift-table').textContent).toContain('Hand-made');
    expect(screen.getByTestId('fleet-design-drift-table').textContent).toContain('High CPU');
    expect(screen.queryByTestId('fleet-design-section-approvedDesign-not-measured')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fleet-design-section-drift-not-measured')).not.toBeInTheDocument();
  });

  it('files the design as an org document through runAction (W05)', async () => {
    fileAsDocumentMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ documentId: 'doc-1', alreadyFiled: false, evidence: null }),
    });
    window.location.hash = '#run-1';
    render(<FleetDesignPage />);
    await waitFor(() => expect(screen.getByTestId('fleet-design-file-document')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('fleet-design-file-document'));

    await waitFor(() => expect(fileAsDocumentMock).toHaveBeenCalledWith('run-1'));
  });

  it('surfaces failed drift evidence from the stored summary', async () => {
    getDesignMock.mockResolvedValue({
      ...DETAIL,
      summary: { fleetDesign: { outcome: OUTCOME, unavailable: ['approvedDesign', 'counts'] } },
    });
    render(<FleetDesignPage />);
    fireEvent.click(await screen.findByTestId('fleet-design-list-row-run-1'));
    expect(await screen.findByTestId('fleet-design-section-approvedDesign-not-measured')).toHaveTextContent('Not measured');
    expect(screen.getByTestId('fleet-design-section-counts-not-measured')).toHaveTextContent('Not measured');
    expect(screen.queryByTestId('fleet-design-drift')).not.toBeInTheDocument();
  });

  it('renders no drift block when the design has none', async () => {
    window.location.hash = '#run-1';
    render(<FleetDesignPage />);
    await waitFor(() => expect(screen.getByTestId('fleet-design-viewer')).toBeInTheDocument());
    expect(screen.queryByTestId('fleet-design-drift')).not.toBeInTheDocument();
  });

  it('selects the design named by the URL hash on load', async () => {
    window.location.hash = '#run-1';
    render(<FleetDesignPage />);

    await waitFor(() => expect(getDesignMock).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(screen.getByTestId('fleet-design-viewer')).toBeInTheDocument());
  });

  it('shows an empty state when the organization has no designs', async () => {
    listDesignsMock.mockResolvedValue([]);
    render(<FleetDesignPage />);

    await waitFor(() => expect(listDesignsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('fleet-design-list')).not.toBeInTheDocument();
  });

  it('surfaces the skip reason when starting a run is declined', async () => {
    startDesignRunMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, skipped: 'mode_off' }),
    });
    render(<FleetDesignPage />);

    await waitFor(() => expect(listDesignsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('fleet-design-start-button'));

    await waitFor(() => expect(screen.getByTestId('fleet-design-start-skip-reason')).toBeInTheDocument());
    expect(screen.getByTestId('fleet-design-start-skip-reason').textContent).toContain('turned off');
  });

  it('shows a running indicator after starting a design run and clears it once the run finishes (paper cut 23)', async () => {
    startDesignRunMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ runId: 'agent-run-9' }),
    });
    vi.mocked(fetchWithAuth).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/ai/agents/runs/agent-run-9')) {
        return {
          ok: true,
          json: async () => ({ data: { status: 'completed', summary: null, computeCents: 0, costCents: 0, artifacts: [] } }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });

    render(<FleetDesignPage />);
    await waitFor(() => expect(listDesignsMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('fleet-design-start-button'));

    await waitFor(() => expect(screen.getByTestId('fleet-design-running-row')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('fleet-design-running-row')).not.toBeInTheDocument());
    // The list is reloaded once the run lands, on top of the initial mount load.
    await waitFor(() => expect(listDesignsMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
