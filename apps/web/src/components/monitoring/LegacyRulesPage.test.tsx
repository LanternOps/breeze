import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LegacyRulesPage from './LegacyRulesPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../hooks/useMlFeatureFlags', () => ({ useMlFeatureFlags: () => ({ isDisabled: () => false }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const rows = [
  {
    id: 'r-legacy',
    name: 'Disk rule',
    templateId: 't1',
    templateName: 'Disk Template',
    targetType: 'org',
    targetId: 'org-1',
    orgId: 'org-1',
    partnerId: null,
    isActive: true,
    managedByMonitorId: null,
    convertedToMonitorId: null,
  },
  {
    id: 'r-managed',
    name: 'Compiled from monitor',
    templateId: 't2',
    templateName: 'CPU Template',
    targetType: 'all',
    targetId: null,
    orgId: 'org-1',
    partnerId: null,
    isActive: true,
    managedByMonitorId: 'monitor-1',
    convertedToMonitorId: null,
  },
];

describe('LegacyRulesPage (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/alerts/rules') && !init) return json({ data: rows, pagination: { page: 1, limit: 50, total: 2 } });
      return json({ data: [] });
    });
  });

  it('lists non-managed rules and hides monitor-managed ones', async () => {
    render(<LegacyRulesPage />);
    await waitFor(() => expect(screen.getByTestId('legacy-rules-page')).toBeInTheDocument());

    expect(screen.getByTestId('legacy-rules-row-r-legacy')).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-rules-row-r-managed')).toBeNull();
  });

  it('shows a Converted badge instead of the Convert action for an already-converted rule', async () => {
    const convertedRows = [
      { ...rows[0], id: 'r-converted', convertedToMonitorId: 'monitor-9' },
    ];
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/alerts/rules') && !init) return json({ data: convertedRows, pagination: { page: 1, limit: 50, total: 1 } });
      return json({ data: [] });
    });
    render(<LegacyRulesPage />);
    await waitFor(() => expect(screen.getByTestId('legacy-rules-row-r-converted')).toBeInTheDocument());

    const row = screen.getByTestId('legacy-rules-row-r-converted');
    expect(within(row).getByText('Converted')).toBeInTheDocument();
    expect(within(row).queryByTestId('legacy-rules-convert-r-converted')).toBeNull();
  });

  it('converts a rule and navigates to the new monitor', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/convert-from-rule/r-legacy' && init?.method === 'POST') {
        return json({ data: { monitorId: 'monitor-9', configPolicyId: 'cp-9' } }, true, 201);
      }
      if (input.startsWith('/alerts/rules')) return json({ data: rows, pagination: { page: 1, limit: 50, total: 2 } });
      return json({ data: [] });
    });
    render(<LegacyRulesPage />);
    await waitFor(() => expect(screen.getByTestId('legacy-rules-page')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('legacy-rules-row-r-legacy')).getByTestId('legacy-rules-convert-r-legacy'));

    await waitFor(() => expect(navMock).toHaveBeenCalledWith('/alerts/monitors/monitor-9'));
  });

  it('shows the not-convertible message inline on a 409', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/convert-from-rule/r-legacy' && init?.method === 'POST') {
        return json({ error: 'RULE_NOT_CONVERTIBLE' }, false, 409);
      }
      if (input.startsWith('/alerts/rules')) return json({ data: rows, pagination: { page: 1, limit: 50, total: 2 } });
      return json({ data: [] });
    });
    render(<LegacyRulesPage />);
    await waitFor(() => expect(screen.getByTestId('legacy-rules-page')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('legacy-rules-row-r-legacy')).getByTestId('legacy-rules-convert-r-legacy'));

    await waitFor(() =>
      expect(within(screen.getByTestId('legacy-rules-row-r-legacy')).getByText(/cannot be expressed/i)).toBeInTheDocument(),
    );
  });
});
