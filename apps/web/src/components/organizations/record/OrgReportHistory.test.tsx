import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@/lib/i18n';
import OrgReportHistory from './OrgReportHistory';
import type { OrgFetch } from './orgRecordFetch';
import type { ReportHistoryDefinition, ReportHistoryRun } from './OrgReportHistory';

const ambientFetch = vi.fn();
vi.mock('@/stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/auth')>();
  return { ...actual, fetchWithAuth: (...args: unknown[]) => ambientFetch(...args) };
});

const ORG_ID = 'org-inactive-1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function definition(overrides: Partial<ReportHistoryDefinition> = {}): ReportHistoryDefinition {
  return {
    id: 'rep-1',
    name: 'Monthly device inventory',
    type: 'device_inventory',
    schedule: 'monthly',
    format: 'pdf',
    lastGeneratedAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    createdAt: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<ReportHistoryRun> = {}): ReportHistoryRun {
  return {
    id: 'run-1',
    reportId: 'rep-1',
    status: 'completed',
    startedAt: '2026-08-01T12:00:00.000Z',
    completedAt: '2026-08-01T12:05:00.000Z',
    rowCount: 42,
    errorMessage: null,
    createdAt: '2026-08-01T12:00:00.000Z',
    reportName: 'Monthly device inventory',
    reportType: 'device_inventory',
    ...overrides,
  };
}

type Call = [string, (RequestInit & { method?: string }) | undefined];

function fetchFor(defs: ReportHistoryDefinition[], runs: ReportHistoryRun[]): { orgFetch: OrgFetch; calls: () => Call[] } {
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/reports') return json({ data: defs, pagination: {} });
    if (path === '/reports/runs?limit=25') return json({ data: runs, pagination: {} });
    return json({ error: 'unexpected' }, 500);
  });
  return { orgFetch: fn as unknown as OrgFetch, calls: () => fn.mock.calls as unknown as Call[] };
}

function forbiddenFetch(): OrgFetch {
  return vi.fn(async () => json({ error: 'forbidden' }, 403)) as unknown as OrgFetch;
}

function erroringFetch(): OrgFetch {
  return vi.fn(async () => {
    throw new Error('network down');
  }) as unknown as OrgFetch;
}

afterEach(() => {
  ambientFetch.mockClear();
});

describe('OrgReportHistory', () => {
  it('renders definitions and runs from the two org-pinned requests', async () => {
    const { orgFetch, calls } = fetchFor([definition()], [run()]);
    render(<OrgReportHistory orgId={ORG_ID} orgFetch={orgFetch} statusLabel="suspended" />);

    await waitFor(() => expect(screen.getByTestId('org-report-history-definition')).toBeTruthy());
    expect(screen.getByTestId('org-report-history-definition').textContent).toContain('Monthly device inventory');
    expect(screen.getByTestId('org-report-history-run').textContent).toContain('Monthly device inventory');
    expect(screen.getByText(/suspended/)).toBeTruthy();

    const requestPaths = calls().map(([path]) => path);
    expect(requestPaths.some((p) => p === '/reports')).toBe(true);
    expect(requestPaths.some((p) => p.startsWith('/reports/runs'))).toBe(true);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it('shows the empty state when neither definitions nor runs come back', async () => {
    const { orgFetch } = fetchFor([], []);
    render(<OrgReportHistory orgId={ORG_ID} orgFetch={orgFetch} statusLabel="churned" />);
    await waitFor(() => expect(screen.getByTestId('org-report-history-empty')).toBeTruthy());
  });

  it('shows the forbidden state on a 403 from either endpoint', async () => {
    const orgFetch = forbiddenFetch();
    render(<OrgReportHistory orgId={ORG_ID} orgFetch={orgFetch} statusLabel="suspended" />);
    const forbidden = await screen.findByTestId('org-report-history-forbidden');
    expect(forbidden.textContent).toContain("don't have access");
  });

  it('shows the error state when the request throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const orgFetch = erroringFetch();
      render(<OrgReportHistory orgId={ORG_ID} orgFetch={orgFetch} statusLabel="suspended" />);
      await screen.findByTestId('org-report-history-error');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('renders no action controls — no buttons, no links', async () => {
    const { orgFetch } = fetchFor([definition()], [run()]);
    render(<OrgReportHistory orgId={ORG_ID} orgFetch={orgFetch} statusLabel="suspended" />);
    await waitFor(() => expect(screen.getByTestId('org-report-history-definition')).toBeTruthy());

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelectorAll('a').length).toBe(0);
    // Informational past-tense text ("Last generated …") is fine; action
    // verbs offered as controls ("Download", "Edit", "Delete") are not.
    const definitionText = screen.getByTestId('org-report-history-definition').textContent ?? '';
    const runText = screen.getByTestId('org-report-history-run').textContent ?? '';
    expect(/download|\bedit\b|\bdelete\b/i.test(definitionText)).toBe(false);
    expect(/download|\bedit\b|\bdelete\b/i.test(runText)).toBe(false);
  });
});
