import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #9728: opening a saved custom (builder) report blanked filterConditions,
// dataSource, columns, groupBy, aggregation, chartType and the checked
// formats, and the next save PUT the blank defaults over the stored config.
// The REAL ReportBuilder is rendered.
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

const savedConfig = {
  builderType: 'alerts',
  dataSource: { timeWindow: 'last_7_days', severity: 'critical' },
  columns: ['title', 'severity'],
  filterConditions: [{ id: 'f1', logic: 'and', field: 'severity', operator: 'is', value: 'critical' }],
  groupBy: 'severity',
  aggregation: { type: 'count' },
  chartType: 'bar',
  exportFormats: ['csv', 'pdf'],
  dateRange: { preset: 'last_7_days' },
};

const putBody = () => {
  const put = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
  return JSON.parse(String((put[1] as RequestInit).body)) as { config: Record<string, unknown> };
};

describe('ReportEditPage round-trips the saved builder state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: null });
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/rep-9' && !init?.method) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'rep-9', name: 'Critical alerts', type: 'alert_summary', schedule: 'weekly',
            format: 'csv', orgId: 'org-7', partnerId: null, config: savedConfig,
            lastGeneratedAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
          }),
        });
      }
      if (url === '/reports/rep-9' && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'rep-9' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    });
  });

  it('saves an untouched edit with the stored builder fields intact', async () => {
    render(<ReportEditPage reportId="rep-9" />);
    await screen.findByDisplayValue('Critical alerts');
    fireEvent.click(await screen.findByTestId('report-builder-submit'));
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true),
    );
    const { config } = putBody();
    expect(config.filterConditions).toEqual(savedConfig.filterConditions);
    expect(config.dataSource).toEqual(savedConfig.dataSource);
    expect(config.columns).toEqual(savedConfig.columns);
    expect(config.groupBy).toBe('severity');
    expect(config.chartType).toBe('bar');
    expect(config.exportFormats).toEqual(['csv', 'pdf']);
  });
});
