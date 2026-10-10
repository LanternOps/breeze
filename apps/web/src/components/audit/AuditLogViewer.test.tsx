import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import AuditLogViewer from './AuditLogViewer';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('AuditLogViewer', () => {
  beforeEach(() => {
    fetchMock.mockReset();
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
});
