import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsageTab from './UsageTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';

const USAGE_ROWS = [
  {
    month: '2026-06',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'beefbeef-1111-4222-8333-444455556666',
    userEmail: 'finance.user@contoso.com',
    messageCount: 40,
    sessionCount: 4,
    inputTokens: 10000,
    outputTokens: 2000,
    costCents: 150,
  },
  {
    month: '2026-06',
    orgId: ORG_ID,
    orgName: 'Contoso Accounting',
    clientUserId: 'cafecafe-1111-4222-8333-444455556666',
    userEmail: 'ap.clerk@contoso.com',
    messageCount: 18,
    sessionCount: 2,
    inputTokens: 5000,
    outputTokens: 1000,
    costCents: 75,
  },
];

const TOTALS = {
  messageCount: 58,
  sessionCount: 6,
  inputTokens: 15000,
  outputTokens: 3000,
  costCents: 225,
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
    }
    if (url.startsWith('/client-ai/admin/usage.csv?') && !init?.method) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        blob: vi.fn().mockResolvedValue(new Blob(['month,org_name'], { type: 'text/csv' })),
        json: vi.fn(),
      } as unknown as Response;
    }
    if (url.startsWith('/client-ai/admin/usage?') && !init?.method) {
      return makeJsonResponse({ rows: USAGE_ROWS, totals: TOTALS });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('UsageTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no createObjectURL — stub the pair the download path uses.
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
  });

  it('renders org groups with subtotals and the totals footer', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`)).toBeInTheDocument()
    );
    // Org subtotal row: 58 messages, $2.25 total cost (225 cents)
    expect(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`).textContent).toContain('58');
    expect(screen.getByTestId('ai-office-usage-totals').textContent).toContain('$2.25');
  });

  it('expands an org group to per-user rows', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`)).toBeInTheDocument()
    );
    expect(screen.queryAllByTestId('ai-office-usage-user-row')).toHaveLength(0);
    fireEvent.click(screen.getByTestId(`ai-office-usage-org-${ORG_ID}`));
    expect(screen.getAllByTestId('ai-office-usage-user-row')).toHaveLength(2);
    expect(screen.getByText('finance.user@contoso.com')).toBeInTheDocument();
    expect(screen.getByText('ap.clerk@contoso.com')).toBeInTheDocument();
  });

  it('re-queries when the month range changes (YYYY-MM params)', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/client-ai/admin/usage?'))).toBe(true)
    );
    fireEvent.change(screen.getByTestId('ai-office-usage-from'), { target: { value: '2026-01' } });
    await waitFor(() => {
      const usageCalls = fetchMock.mock.calls.filter(([u]) =>
        String(u).startsWith('/client-ai/admin/usage?')
      );
      expect(String(usageCalls[usageCalls.length - 1]![0])).toContain('from=2026-01');
    });
  });

  it('Export CSV hits usage.csv and triggers a blob download', async () => {
    mockApi();
    render(<UsageTab />);
    await waitFor(() =>
      expect(screen.getByTestId('ai-office-usage-export')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('ai-office-usage-export'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).startsWith('/client-ai/admin/usage.csv?'))
      ).toBe(true)
    );
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});
