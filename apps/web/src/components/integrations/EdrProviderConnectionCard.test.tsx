import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import EdrProviderConnectionCard from './EdrProviderConnectionCard';
import type { EdrConnection } from '@/lib/edrProviders';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const res = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const conn = (o: Record<string, unknown> = {}): EdrConnection =>
  ({
    id: 'c1', partnerId: 'p1', provider: 'bitdefender', name: 'Main GravityZone', baseUrl: null, region: null,
    vendorRootId: 'r1', vendorRootName: null, vendorRootType: null, isActive: true, status: 'connected',
    detectionIntervalMinutes: null, inventoryIntervalMinutes: null,
    effectiveDetectionIntervalMinutes: 5, effectiveInventoryIntervalMinutes: 30,
    lastInventorySyncAt: null, lastInventorySyncStatus: null, lastInventorySyncError: null,
    lastDetectionSyncAt: null, lastDetectionSyncStatus: null, lastDetectionSyncError: null,
    lastSyncTenants: 0, lastSyncUnmappedTenants: 0, lastSyncFailedTenants: 0, lastSyncEndpoints: 0,
    lastSyncLinkedEndpoints: 0, lastSyncAmbiguousEndpoints: 0, lastSyncOpenDetections: 0,
    capabilitiesSnapshot: null, createdAt: '', updatedAt: '', hasCredentials: true, hasWebhookSecret: true,
    actionsEnabled: false, pushSupported: true, pushEnabled: false, pushRegisteredAt: null, lastHintAt: null,
    ...o,
  }) as EdrConnection;

function mount(c: EdrConnection, canManage = true, onChanged = vi.fn()) {
  render(
    <EdrProviderConnectionCard
      connection={c}
      provider={undefined}
      canManage={canManage}
      onChanged={onChanged}
      onTestResult={vi.fn()}
    />,
  );
  return onChanged;
}

const calls = (method: string) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  fetchMock.mockResolvedValue(res({ data: conn() }));
});

describe('EdrProviderConnectionCard response-action / push switches', () => {
  it('hides both switches for non-partner-admins', () => {
    mount(conn(), false);
    expect(screen.queryByTestId('edr-connection-actions-enabled')).toBeNull();
    expect(screen.queryByTestId('edr-connection-push-enabled')).toBeNull();
  });

  it('hides the push switch when the provider does not support push', () => {
    mount(conn({ pushSupported: false }));
    expect(screen.getByTestId('edr-connection-actions-enabled')).toBeInTheDocument();
    expect(screen.queryByTestId('edr-connection-push-enabled')).toBeNull();
  });

  it('requires a confirm dialog to enable response actions, then PATCHes actionsEnabled', async () => {
    mount(conn());
    fireEvent.click(screen.getByTestId('edr-connection-actions-enabled'));
    expect(calls('PATCH')).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('edr-connection-actions-confirm'));
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1));
    const [url, init] = calls('PATCH')[0]!;
    expect(url).toBe('/edr/connections/c1');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ actionsEnabled: true });
  });

  it('disables response actions without a confirm dialog', async () => {
    mount(conn({ actionsEnabled: true }));
    fireEvent.click(screen.getByTestId('edr-connection-actions-enabled'));
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1));
    expect(JSON.parse((calls('PATCH')[0]![1] as RequestInit).body as string)).toEqual({ actionsEnabled: false });
    expect(screen.queryByTestId('edr-connection-actions-confirm')).toBeNull();
  });

  it('enables push via POST /push and refreshes', async () => {
    const changed = mount(conn());
    fireEvent.click(screen.getByTestId('edr-connection-push-enabled'));
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
    expect(calls('POST')[0]![0]).toBe('/edr/connections/c1/push');
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('maps a 409 public_url_unset to a specific error toast', async () => {
    fetchMock.mockResolvedValue(res({ error: 'x', code: 'public_url_unset' }, 409));
    mount(conn());
    fireEvent.click(screen.getByTestId('edr-connection-push-enabled'));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringMatching(/public URL/i) }),
      ),
    );
  });

  it('disables push via DELETE /push and shows warnings as a warning toast', async () => {
    fetchMock.mockResolvedValue(res({ data: conn(), warnings: ['Vendor could not be reached'] }));
    mount(conn({ pushEnabled: true }));
    fireEvent.click(screen.getByTestId('edr-connection-push-enabled'));
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('DELETE')[0]![0]).toBe('/edr/connections/c1/push');
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'warning', message: expect.stringContaining('Vendor could not be reached') }),
      ),
    );
  });

  it('shows the test-event button only when push is enabled, with a neutral note after sending', async () => {
    const { unmount } = render(
      <EdrProviderConnectionCard connection={conn()} provider={undefined} canManage onChanged={vi.fn()} onTestResult={vi.fn()} />,
    );
    expect(screen.queryByTestId('edr-connection-push-test')).toBeNull();
    unmount();

    fetchMock.mockResolvedValue(res({ accepted: true }, 202));
    const changed = mount(conn({ pushEnabled: true }));
    fireEvent.click(screen.getByTestId('edr-connection-push-test'));
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
    expect(calls('POST')[0]![0]).toBe('/edr/connections/c1/push/test');
    expect(await screen.findByTestId('edr-connection-push-test-note')).toHaveTextContent(/few minutes/i);
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('shows the last push event time or an empty note, and never promises instant delivery', () => {
    const { unmount } = render(
      <EdrProviderConnectionCard connection={conn({ pushEnabled: true })} provider={undefined} canManage onChanged={vi.fn()} onTestResult={vi.fn()} />,
    );
    expect(screen.getByTestId('edr-connection-push-last')).toHaveTextContent('No push events received yet');
    unmount();
    mount(conn({ pushEnabled: true, lastHintAt: new Date(Date.now() - 3600_000).toISOString() }));
    expect(screen.getByTestId('edr-connection-push-last')).toHaveTextContent(/Last push event:/);
    expect(document.body.textContent ?? '').not.toMatch(/instant|real-time|realtime/i);
  });
});
