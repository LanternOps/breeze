import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import AuditLogViewer from './AuditLogViewer';
import { fireEvent } from '@testing-library/react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
// Stand-in for the filter panel: one button applies a known filter set, and it
// echoes the filters it was opened with (#9941).
vi.mock('./AuditFilters', () => ({
  default: ({ onApply, initialFilters }: { onApply: (f: unknown) => void; initialFilters?: unknown }) => (
    <>
    <pre data-testid="mock-initial-filters">{JSON.stringify(initialFilters ?? null)}</pre>
    <button
      type="button"
      onClick={() =>
        onApply({
          datePreset: '7d',
          userId: '11111111-1111-4111-8111-111111111111',
          userEmail: 'dana@example.com',
          actions: ['login'],
          resources: ['device'],
          search: 'abc',
        })
      }
    >
      apply-test-filters
    </button>
    </>
  ),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('AuditLogViewer', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.mocked(showToast).mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: [], pagination: { total: 0, totalPages: 1 } }));
  });

  it('injects no orgId override by default — ambient scope handles it, as before', async () => {
    render(<AuditLogViewer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0];
    expect((init as { orgIdOverride?: string })?.orgIdOverride).toBeUndefined();
  });

  it('pins every request to the record org via orgIdOverride when orgId is set, regardless of ambient scope (#5075 W02)', async () => {
    render(<AuditLogViewer orgId="org-record-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { orgIdOverride?: string })?.orgIdOverride).toBe('org-record-1');
    }
  });

  it('pins the export request to the same org', async () => {
    render(<AuditLogViewer orgId="org-record-1" />);
    await screen.findByText(/audit log/i);

    const exportButton = screen.getByRole('button', { name: /export/i });
    exportButton.click();

    await waitFor(() => {
      const exportCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/audit-logs/export'));
      expect(exportCall).toBeTruthy();
      expect((exportCall![1] as { orgIdOverride?: string })?.orgIdOverride).toBe('org-record-1');
    });
  });

  it('renders /audit-logs/search entries (object resource, object details) without crashing', async () => {
    const searchEntry = {
      id: 'log-1',
      timestamp: '2026-10-01T12:00:00.000Z',
      user: { id: 'u1', name: 'Dana Admin', email: 'dana@example.com', role: 'user' },
      action: 'device.update',
      resource: { type: 'device', id: 'dev-1', name: 'WS-FRONTDESK-01' },
      category: 'device',
      result: 'success',
      ipAddress: '10.0.0.1',
      userAgent: 'test',
      initiatedBy: null,
      details: { reason: 'rename' },
    };
    fetchMock.mockResolvedValue(jsonResponse({ data: [searchEntry], pagination: { total: 1, totalPages: 1 } }));
    render(<AuditLogViewer />);

    expect(await screen.findByText('WS-FRONTDESK-01')).toBeTruthy();
    expect(screen.getByText('Dana Admin')).toBeTruthy();
  });
  it('toasts the API error text when the export fails instead of failing silently', async () => {
    render(<AuditLogViewer />);
    await screen.findByText(/audit log/i);
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Export exploded' }, false, 500));

    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() =>
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Export exploded' })
      )
    );
  });

  it('reopens the filter panel seeded with the applied filters (#9941)', async () => {
    render(<AuditLogViewer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const filtersToggle = () => screen.getByRole('button', { name: /filters/i });

    fireEvent.click(filtersToggle());
    expect(JSON.parse(screen.getByTestId('mock-initial-filters').textContent!)).toBeNull();

    fireEvent.click(screen.getByText('apply-test-filters'));
    // Apply closes (unmounts) the panel; reopening must hand it what was applied.
    await waitFor(() => expect(screen.queryByTestId('mock-initial-filters')).toBeNull());
    fireEvent.click(filtersToggle());
    expect(JSON.parse(screen.getByTestId('mock-initial-filters').textContent!)).toEqual({
      datePreset: '7d',
      userId: '11111111-1111-4111-8111-111111111111',
      userEmail: 'dana@example.com',
      actions: ['login'],
      resources: ['device'],
      search: 'abc',
    });
  });

  it('sends the viewer filters the export API accepts (userId) on the export request', async () => {
    render(<AuditLogViewer />);
    await screen.findByText(/audit log/i);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(await screen.findByText('apply-test-filters'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('userId='))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/audit-logs/export'));
      expect(call).toBeTruthy();
      const qs = new URLSearchParams(String(call![0]).split('?')[1] ?? '');
      expect(qs.get('userId')).toBe('11111111-1111-4111-8111-111111111111');
      // #9671: a picked user is matched by id; the email text match would AND
      // away that user's rows that carry no actor email (agent.command.*).
      expect(qs.has('user')).toBe(false);
    });
  });

  it('forwards the same date/user/action/resource/search filters to the export as the list request (#8366)', async () => {
    render(<AuditLogViewer />);
    await screen.findByText(/audit log/i);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(await screen.findByText('apply-test-filters'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/audit-logs/search'))).toBe(true));
    const listCall = [...fetchMock.mock.calls].reverse().find(([u]) => String(u).includes('/audit-logs/search'))!;
    const listQs = new URLSearchParams(String(listCall[0]).split('?')[1] ?? '');

    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/audit-logs/export'));
      expect(call).toBeTruthy();
      const qs = new URLSearchParams(String(call![0]).split('?')[1] ?? '');
      for (const key of ['userId', 'action', 'resource', 'q']) {
        expect(listQs.get(key), `list sends ${key}`).toBeTruthy();
        expect(qs.get(key), `export sends ${key}`).toBe(listQs.get(key));
      }
      // The relative "last 7d" window is recomputed at click time, so compare
      // within a few seconds rather than byte-for-byte.
      expect(listQs.get('from')).toBeTruthy();
      expect(qs.get('from')).toBeTruthy();
      expect(Math.abs(Date.parse(qs.get('from')!) - Date.parse(listQs.get('from')!))).toBeLessThan(10_000);
      expect(qs.get('to')).toBeTruthy();
      // Pagination / count hints are list-only.
      expect(qs.has('page')).toBe(false);
      expect(qs.has('limit')).toBe(false);
      expect(qs.has('skipCount')).toBe(false);
    });
  });

  describe('row presentation (#9672)', () => {
    const row = (action: string, extra: Record<string, unknown> = {}) => ({
      id: `log-${action}`,
      timestamp: '2026-10-01T12:00:00.000Z',
      user: { name: 'Dana Admin', email: 'dana@example.com', role: 'user' },
      action,
      resource: 'Disk cleanup',
      resourceType: 'script',
      details: JSON.stringify({ a: 1, b: 2, c: 3 }),
      ipAddress: '10.0.0.1',
      userAgent: 'test',
      sessionId: '',
      changes: { before: {}, after: {} },
      ...extra,
    });

    it('colours badges by the first segment of the dotted code', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ entries: [row('user.login'), row('script.execute')], pagination: { total: 2, totalPages: 1 } }),
      );
      render(<AuditLogViewer />);
      await screen.findAllByTestId('audit-action-badge');
      const [login, script] = screen.getAllByTestId('audit-action-badge');
      expect(login.className).not.toBe(script.className);
      expect(script.className).not.toContain('slate');
    });

    it('does not claim "N fields updated" when there is no before-state', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          entries: [row('script.execute', { changes: { before: {}, after: { a: 1, b: 2, c: 3 } } })],
          pagination: { total: 1, totalPages: 1 },
        }),
      );
      render(<AuditLogViewer />);
      fireEvent.click((await screen.findAllByTestId('audit-row-toggle'))[0]);
      expect(screen.queryByText(/fields? updated/i)).toBeNull();
    });

    it('counts changed fields when a before-state exists', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          entries: [row('device.update', { changes: { before: { a: 0 }, after: { a: 1, b: 2 } } })],
          pagination: { total: 1, totalPages: 1 },
        }),
      );
      render(<AuditLogViewer />);
      fireEvent.click((await screen.findAllByTestId('audit-row-toggle'))[0]);
      expect(screen.getByText(/2 fields updated/i)).toBeTruthy();
    });
  });
});
