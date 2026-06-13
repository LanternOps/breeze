import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

// The device filter bar issues its own fetches; stub it out so the page's
// alert/device fetches are the only traffic under test.
vi.mock('../filters/DeviceFilterBar', () => ({
  DeviceFilterBar: () => null
}));

// Pin the org-scope selectors so the page doesn't try to read a real store.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { orgScope: string; currentOrgId: string | null }) => unknown) =>
    selector({ orgScope: 'current', currentOrgId: 'org-1' })
}));

const fetchMock = vi.mocked(fetchWithAuth);

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const activeAlert = {
  id: ALERT_ID,
  title: 'High CPU on SRV-01',
  message: 'CPU above 95% for 5 minutes',
  severity: 'critical',
  status: 'active',
  deviceId: 'device-1',
  deviceName: 'SRV-01',
  triggeredAt: new Date().toISOString()
};

/** A promise we can resolve from the test body to simulate a slow ack. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AlertsPage — acknowledge in-flight feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an in-flight spinner on the acked row while the request is pending, then a success toast', async () => {
    const ackDeferred = deferred<Response>();

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}/acknowledge` && method === 'POST') {
        // Deliberately do NOT resolve yet — this models the ~19s ack.
        return ackDeferred.promise;
      }
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });

    render(<AlertsPage />);

    // Wait for the alert row to render.
    const ackButton = await screen.findByRole('button', { name: /Acknowledge: High CPU on SRV-01/i });
    const row = ackButton.closest('tr')!;

    // Click Ack — the request is now in flight (deferred, unresolved).
    fireEvent.click(ackButton);

    // While in flight, the row must surface a spinner and hide the action buttons.
    await waitFor(() => {
      expect(within(row).queryByRole('button', { name: /Acknowledge:/i })).not.toBeInTheDocument();
    });
    expect(row.querySelector('.animate-spin')).toBeInTheDocument();

    // No success toast yet — the request hasn't returned.
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));

    // Resolve the ack.
    ackDeferred.resolve(makeJsonResponse({ success: true }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });
  });

  it('disables the AlertDetails Acknowledge button and shows a spinner while the request is pending', async () => {
    const ackDeferred = deferred<Response>();

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}` && method === 'GET') {
        // Detail-panel fetch (status/notification history).
        return Promise.resolve(makeJsonResponse({ statusHistory: [], notificationHistory: [] }));
      }
      if (url === `/alerts/${ALERT_ID}/acknowledge` && method === 'POST') {
        return ackDeferred.promise;
      }
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });

    render(<AlertsPage />);

    // Open the slide-over by clicking the row (the title cell).
    const titleCell = await screen.findByText('High CPU on SRV-01');
    fireEvent.click(titleCell);

    // The detail panel's Acknowledge button (full word, distinct from the row "Ack").
    const dialog = await screen.findByRole('dialog');
    const detailAck = within(dialog).getByRole('button', { name: /^Acknowledge$/i });
    expect(detailAck).not.toBeDisabled();

    fireEvent.click(detailAck);

    // In flight: button disabled + spinner present in the dialog footer.
    await waitFor(() => expect(detailAck).toBeDisabled());
    expect(dialog.querySelector('.animate-spin')).toBeInTheDocument();

    ackDeferred.resolve(makeJsonResponse({ success: true }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });
  });

  it('surfaces an error toast when the acknowledge request fails', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/alerts' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
      }
      if (url === '/devices' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === `/alerts/${ALERT_ID}/acknowledge` && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });

    render(<AlertsPage />);
    const ackButton = await screen.findByRole('button', { name: /Acknowledge: High CPU on SRV-01/i });
    fireEvent.click(ackButton);

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});
