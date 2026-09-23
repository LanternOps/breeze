// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PortalRunDto } from '@breeze/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportRunList, reportDisplayName } from './ReportRunList';

const { generateMock, listMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  portalApi: {
    generateReport: generateMock,
    getReportRuns: listMock,
    reportArtifactUrl: (id: string, format: string) =>
      `/api/v1/portal/reports/runs/${id}/${format}`,
  },
}));

const run: PortalRunDto = {
  id: 'run-1',
  reportId: 'report-1',
  name: 'Customer portal — Executive summary',
  type: 'executive_summary',
  status: 'completed',
  startedAt: '2026-09-02T12:00:00.000Z',
  completedAt: '2026-09-02T12:01:00.000Z',
  rowCount: 4,
  createdAt: '2026-09-02T12:00:00.000Z',
};

const runAt = (id: string): PortalRunDto => ({ ...run, id });

describe('ReportRunList', () => {
  beforeEach(() => vi.clearAllMocks());

  // #5784 W03 (OD-10 = A). A managed-evidence run reaches the portal list only
  // after its occurrence is delivered; the customer may never generate one, so
  // the toolbar must NOT gain a fourth button.
  it('lists a delivered endpoint management review run with no generate button for it', () => {
    const evidenceRun: PortalRunDto = {
      ...run,
      id: 'run-epm',
      name: 'Service evidence — Endpoint management review',
      type: 'endpoint_management_review',
    };

    render(<ReportRunList initialRuns={[evidenceRun]} timezone="America/Denver" />);

    expect(screen.getByTestId('portal-report-run-row-run-epm')).toBeTruthy();
    // #6101: the internal "Service evidence —" prefix is trimmed, same as
    // the MSP-side "Customer portal —" prefix.
    expect(screen.getByText('Endpoint management review')).toBeTruthy();
    expect(screen.queryByText(/Service evidence/)).toBeNull();
    expect(
      screen.getByTestId('portal-report-run-pdf-run-epm').getAttribute('href'),
    ).toBe('/api/v1/portal/reports/runs/run-epm/pdf');
    expect(screen.queryByTestId('portal-reports-generate-endpoint-management')).toBeNull();
    expect(screen.queryByText(/generate endpoint management/i)).toBeNull();
  });

  it('generates a report and renders PDF/CSV download links', async () => {
    generateMock.mockResolvedValue({ data: run });
    listMock.mockResolvedValue({ data: [run] });

    render(<ReportRunList initialRuns={[]} timezone="America/Denver" />);

    fireEvent.click(
      screen.getByTestId('portal-reports-generate-executive'),
    );

    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledWith('executive_summary');
    });
    expect(
      await screen.findByTestId('portal-report-run-row-run-1'),
    ).toBeTruthy();

    expect(
      screen.getByTestId('portal-report-run-pdf-run-1').getAttribute('href'),
    ).toBe(
      '/api/v1/portal/reports/runs/run-1/pdf',
    );
    expect(
      screen.getByTestId('portal-report-run-csv-run-1').getAttribute('href'),
    ).toBe(
      '/api/v1/portal/reports/runs/run-1/csv',
    );
  });

  it('renders generated timestamps in the organization timezone with its label', () => {
    render(
      <ReportRunList
        initialRuns={[run]}
        timezone="America/Denver"
      />,
    );

    expect(screen.getByTestId('portal-report-run-row-run-1').textContent)
      .toContain('Sep 2, 2026, 06:01 AM (America/Denver)');
  });

  it('rules the runs as a ledger with scoped column headers', () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const headers = Array.from(
      document.querySelectorAll('th[scope="col"]'),
    ).map((th) => th.textContent);
    expect(headers).toEqual(['Report', 'Generated', 'Download']);
  });

  it("strips the MSP-side 'Customer portal' prefix from the customer's own list", () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const row = screen.getByTestId('portal-report-run-row-run-1');
    expect(row.textContent).toContain('Executive summary');
    expect(row.textContent).not.toContain('Customer portal');
  });

  // #6101: `MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX` in
  // apps/api/src/services/managedEvidenceRegistry.ts is an internal label —
  // customers should never see "Service evidence —" any more than they see
  // "Customer portal —".
  describe('reportDisplayName', () => {
    it('trims the "Customer portal —" prefix (em dash)', () => {
      expect(reportDisplayName('Customer portal — Executive summary')).toBe(
        'Executive summary',
      );
    });

    it('trims the "Service evidence —" prefix (em dash)', () => {
      expect(reportDisplayName('Service evidence — Threat detection review')).toBe(
        'Threat detection review',
      );
    });

    it('tolerates the en dash and hyphen variants for both prefixes', () => {
      expect(reportDisplayName('Customer portal – Executive summary')).toBe(
        'Executive summary',
      );
      expect(reportDisplayName('Customer portal - Executive summary')).toBe(
        'Executive summary',
      );
      expect(reportDisplayName('Service evidence – Vulnerability management')).toBe(
        'Vulnerability management',
      );
      expect(reportDisplayName('Service evidence - Vulnerability management')).toBe(
        'Vulnerability management',
      );
    });

    it('leaves a name with neither prefix untouched', () => {
      expect(reportDisplayName('Executive summary')).toBe('Executive summary');
    });

    it('tolerates a dash with no surrounding whitespace', () => {
      expect(reportDisplayName('Service evidence—Vulnerability management')).toBe(
        'Vulnerability management',
      );
    });

    it('does not trim the prefix when it appears mid-string, not at the start', () => {
      expect(reportDisplayName('Report: Service evidence — Vulnerability management')).toBe(
        'Report: Service evidence — Vulnerability management',
      );
    });
  });

  it('totals the ledger in a foot line', () => {
    render(
      <ReportRunList
        initialRuns={[runAt('a'), runAt('b'), runAt('c')]}
        timezone="UTC"
      />,
    );
    expect(screen.getByTestId('report-ledger-foot').textContent).toBe(
      '3 reports available',
    );
  });

  it('announces the generate progress and completion politely', async () => {
    let settle: ((value: unknown) => void) | undefined;
    generateMock.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    listMock.mockResolvedValue({ data: [run] });

    render(<ReportRunList initialRuns={[]} timezone="UTC" />);

    const status = screen.getByTestId('portal-reports-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');

    fireEvent.click(screen.getByTestId('portal-reports-generate-posture'));

    await waitFor(() => {
      expect(status.textContent).toBe(
        'Generating your security summary…',
      );
    });

    settle?.({ data: run });

    await waitFor(() => {
      expect(status.textContent).toBe('Your report is ready.');
    });
  });

  it('offers the three generate actions as peers, with no false primary', () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const posture = screen.getByTestId('portal-reports-generate-posture');
    const executive = screen.getByTestId('portal-reports-generate-executive');
    const lifecycle = screen.getByTestId('portal-reports-generate-lifecycle');
    expect(posture.className).toBe(executive.className);
    expect(lifecycle.className).toBe(executive.className);
    // BTN_PRIMARY's service-green fill is the tell.
    expect(posture.className).not.toContain('bg-primary');
  });

  it('generates a hardware lifecycle plan from the third action', async () => {
    generateMock.mockResolvedValue({ data: { ...run, type: 'hardware_lifecycle' } });
    listMock.mockResolvedValue({ data: [{ ...run, type: 'hardware_lifecycle' }] });

    render(<ReportRunList initialRuns={[]} timezone="UTC" />);

    fireEvent.click(screen.getByTestId('portal-reports-generate-lifecycle'));

    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledWith('hardware_lifecycle');
    });
  });

  it('labels the lifecycle action and its progress line in plain words', async () => {
    let release: (value: unknown) => void = () => {};
    generateMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    listMock.mockResolvedValue({ data: [] });

    render(<ReportRunList initialRuns={[]} timezone="UTC" />);

    const button = screen.getByTestId('portal-reports-generate-lifecycle');
    expect(button.textContent).toBe('Generate hardware lifecycle plan');

    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByTestId('portal-reports-status').textContent,
      ).toBe('Generating your hardware lifecycle plan…');
    });

    release({ data: run });
  });

  it('speaks of the machines rather than an "environment", and labels the summary plainly', () => {
    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    const container = document.body.textContent ?? '';
    expect(container).toContain('Generate and download a current summary of your machines.');
    expect(container).not.toContain('environment');
    expect(screen.getByTestId('portal-reports-generate-posture').textContent).toBe(
      'Generate security summary',
    );
  });

  it.each([
    ['failed', 'Did not complete'],
    ['running', 'Still generating'],
  ] as const)('offers no download for a %s run', (status, copy) => {
    render(
      <ReportRunList
        initialRuns={[{ ...run, status, completedAt: null }]}
        timezone="UTC"
      />,
    );

    expect(screen.queryByTestId('portal-report-run-pdf-run-1')).toBeNull();
    expect(screen.queryByTestId('portal-report-run-csv-run-1')).toBeNull();
    expect(screen.getByTestId('portal-report-run-download-run-1').textContent).toBe(copy);
    // The outcome is stated once per row, not echoed in the Generated column.
    const row = screen.getByTestId('portal-report-run-row-run-1');
    expect(row.textContent?.split(copy)).toHaveLength(2);
    expect(row.textContent).not.toContain('Generated');
  });

  it('tells the customer when to come back after a rate limit', async () => {
    generateMock.mockResolvedValue({
      error: 'Report generation is temporarily limited',
      statusCode: 429,
      headers: new Headers({ 'Retry-After': '120' }),
    });

    render(<ReportRunList initialRuns={[run]} timezone="UTC" />);

    fireEvent.click(screen.getByTestId('portal-reports-generate-posture'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Report generation is temporarily limited. Try again in about 2 minutes.',
    );
    expect(screen.getByTestId('portal-reports-status').textContent).toBe('');
  });

  // #5784 W02 / OD-10 = A: the customer SEES and downloads what their service
  // plan produced, but cannot generate it — only the three self-service types
  // get a button. The type reaches this list through portalRunListPredicate,
  // which has no type filter, so an unwidened union would be a type lie the
  // compiler cannot see.
  it('labels a threat detection run without offering a generate button', () => {
    const threatRun: PortalRunDto = {
      ...run,
      id: 'run-td',
      name: 'Service evidence — Threat detection review',
      type: 'threat_detection_review',
    };
    render(<ReportRunList initialRuns={[threatRun]} timezone="UTC" />);
    expect(screen.getByTestId('portal-report-run-row-run-td')).toBeInTheDocument();
    expect(screen.getByText(/threat detection review/i)).toBeInTheDocument();
    expect(screen.queryByTestId('portal-reports-generate-threat_detection_review')).toBeNull();
    // Downloadable, though: delivery already gated visibility server-side.
    expect(screen.getByTestId('portal-report-run-pdf-run-td')).toBeInTheDocument();
  });

  // #5784 W04, OD-10 = A. A delivered vulnerability-management run is LISTED
  // and downloadable, but the portal user never gets a button to produce one.
  it('lists a delivered vulnerability management run with no generate action for it', () => {
    render(
      <ReportRunList
        initialRuns={[{
          ...run,
          id: 'run-vuln',
          name: 'Service evidence — Vulnerability management',
          type: 'vulnerability_management',
        }]}
        timezone="UTC"
      />,
    );

    // #6101: `reportDisplayName` trims both the MSP's "Customer portal —"
    // prefix and the internal "Service evidence —" prefix.
    expect(screen.getByText('Vulnerability management')).toBeTruthy();
    expect(screen.queryByText(/Service evidence/)).toBeNull();
    expect(screen.getByTestId('portal-report-runs-table')).toBeTruthy();
    expect(screen.queryByTestId('portal-reports-generate-vulnerability')).toBeNull();
    // Exactly the three self-service actions, unchanged.
    expect(screen.getByTestId('portal-reports-generate-posture')).toBeTruthy();
    expect(screen.getByTestId('portal-reports-generate-executive')).toBeTruthy();
    expect(screen.getByTestId('portal-reports-generate-lifecycle')).toBeTruthy();
  });

  // #5784 W06 / OD-10 = A, and the PII case: this artifact carries user
  // principal names and IP addresses, so it must be listed-but-not-generatable
  // for exactly the same reason as the threat review above, only more so.
  it('labels an identity access run without offering a generate button', () => {
    const identityRun: PortalRunDto = {
      ...run,
      id: 'run-ia',
      name: 'Service evidence — Identity and access review',
      type: 'identity_access_review',
    };
    render(<ReportRunList initialRuns={[identityRun]} timezone="UTC" />);
    expect(screen.getByTestId('portal-report-run-row-run-ia')).toBeInTheDocument();
    expect(screen.getByText(/identity and access review/i)).toBeInTheDocument();
    expect(screen.queryByTestId('portal-reports-generate-identity_access_review')).toBeNull();
    // Downloadable, though: delivery already gated visibility server-side.
    expect(screen.getByTestId('portal-report-run-pdf-run-ia')).toBeInTheDocument();
  });

  // #3198 W03. These three types are internal by construction: they are absent
  // from PORTAL_REPORT_TYPES, never portal_self_service, and their definitions
  // are org- or partner-owned MSP reports. If a row of one ever reaches this
  // component, something upstream has leaked — so the component must not be the
  // thing that renders it, and must certainly never offer to generate one.
  const BUSINESS_TYPES = [
    { type: 'ticket_sla_attainment', name: 'Ticket SLA attainment' },
    { type: 'technician_time_billability', name: 'Technician time & billability' },
    { type: 'ar_aging', name: 'AR aging' },
  ] as const;
  const leakedRun = (type: string, name: string) =>
    ({ ...run, id: `run-${type}`, name, type }) as unknown as PortalRunDto;

  it.each(BUSINESS_TYPES)('renders no row and no generate button for $type', ({ type, name }) => {
    render(<ReportRunList initialRuns={[leakedRun(type, name), run]} timezone="America/Denver" />);

    expect(screen.queryByTestId(`portal-report-run-row-run-${type}`)).toBeNull();
    expect(screen.queryByText(name)).toBeNull();
    // Positive control: the legitimate row beside it still renders.
    expect(screen.getByTestId('portal-report-run-row-run-1')).toBeTruthy();
    expect(screen.queryByTestId(`portal-reports-generate-${type.replace(/_/g, '-')}`)).toBeNull();
  });

  it('keeps all three business types out after the post-generate re-fetch', async () => {
    const fresh: PortalRunDto = { ...run, id: 'run-new' };
    generateMock.mockResolvedValue({ data: fresh });
    listMock.mockResolvedValue({
      data: [fresh, ...BUSINESS_TYPES.map(({ type, name }) => leakedRun(type, name)), run],
    });

    render(<ReportRunList initialRuns={[run]} timezone="America/Denver" />);
    fireEvent.click(screen.getByTestId('portal-reports-generate-executive'));

    expect(await screen.findByTestId('portal-report-run-row-run-new')).toBeTruthy();
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('portal-report-run-row-run-1')).toBeTruthy();
    for (const { type, name } of BUSINESS_TYPES) {
      expect(screen.queryByTestId(`portal-report-run-row-run-${type}`)).toBeNull();
      expect(screen.queryByText(name)).toBeNull();
    }
  });
});

describe('ReportRunList — hardware lifecycle link', () => {
  it('renders a ruled link row under the title when given a lifecycleHref, and nothing otherwise', () => {
    const { unmount } = render(<ReportRunList initialRuns={[]} timezone="UTC" lifecycleHref="/portal/devices#lifecycle" />);
    const link = screen.getByTestId('reports-lifecycle-card');
    expect(link).toHaveAttribute('href', '/portal/devices#lifecycle');
    expect(link.className).not.toContain('bg-card');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    render(<ReportRunList initialRuns={[]} timezone="UTC" />);
    expect(screen.queryByTestId('reports-lifecycle-card')).toBeNull();
  });
});

describe('ReportRunList — lifecycle row padding', () => {
  it('gives the hover wash side padding while keeping the text on the column edge', () => {
    render(<ReportRunList initialRuns={[]} timezone="UTC" lifecycleHref="/portal/devices#lifecycle" />);
    const cls = screen.getByTestId('reports-lifecycle-card').className;
    expect(cls).toMatch(/\bpx-4\b/);
    expect(cls).toMatch(/-mx-4\b/);
  });
});
