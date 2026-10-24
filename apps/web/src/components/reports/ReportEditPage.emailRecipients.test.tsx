import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pre-release sweep v0.124.0: a template dialog (#8913) writes the extra email
// addresses to `config.emailRecipients`. The edit page must hydrate them into
// the builder, otherwise the first save PUTs `emailRecipients: []` and the
// report silently stops emailing them. The REAL ReportBuilder is rendered.
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportEditPage from './ReportEditPage';
import { useOrgStore } from '../../stores/orgStore';

let loaded: Record<string, unknown>;

function storedReport(config: Record<string, unknown>) {
  return {
    id: 'rep-1',
    name: 'Backups weekly',
    type: 'backup_status',
    schedule: 'weekly',
    format: 'pdf',
    orgId: 'org-7',
    partnerId: null,
    config,
    lastGeneratedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const putBody = () => {
  const put = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
  return JSON.parse(String((put[1] as RequestInit).body)) as { config: Record<string, unknown> };
};

describe('ReportEditPage keeps a template report\'s email recipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: null });
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/rep-1' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(loaded) });
      }
      if (url === '/reports/rep-1' && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'rep-1' }) });
      }
      if (url === '/orgs/organizations/org-7/contacts') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ id: 'c-1', name: 'Pat Owner', email: 'pat@acme.test' }] }),
        });
      }
      if (url === '/reports/rep-1/recipients') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ contactId: 'c-1' }] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    });
  });

  it('lists the stored extra address and sends it back unchanged on save', async () => {
    loaded = storedReport({ dateRange: { preset: 'last_30_days' }, emailRecipients: ['a@example.com'] });
    render(<ReportEditPage reportId="rep-1" />);

    expect(await screen.findByText('a@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true),
    );
    expect(putBody().config.emailRecipients).toEqual(['a@example.com']);
  });

  it('ignores a malformed stored value instead of crashing the page', async () => {
    loaded = storedReport({ dateRange: { preset: 'last_30_days' }, emailRecipients: 'not-a-list' });
    render(<ReportEditPage reportId="rep-1" />);

    await screen.findByTestId('report-builder-submit');
    fireEvent.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true),
    );
    expect(putBody().config.emailRecipients).toEqual([]);
  });
});
