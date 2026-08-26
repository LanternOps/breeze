import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Losing the resolve compare-and-swap is a 409, not a broken page (#4094).
 *
 * The API's single-alert resolve is now winner-takes-all: when another technician
 * (or the auto-resolve sweep) transitions the alert first, this request gets a 409
 * and the server publishes nothing on its behalf. `runAction` already toasts the
 * server's reason for that. What must NOT happen is the page additionally latching
 * its persistent red error banner — the alert IS resolved, so framing the race as a
 * page failure is wrong, and it leaves the header showing a stale open status until
 * the user reloads by hand.
 */
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));

const fetchWithAuth = vi.fn();
const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock('../shared/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, showToast: (...args: unknown[]) => showToast(...args) };
});

import AlertDetailPage from './AlertDetailPage';

const ALERT_ID = 'a-cas-1';

const openAlert = {
  id: ALERT_ID,
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
};

const resolvedAlert = { ...openAlert, status: 'resolved', resolvedAt: '2026-08-24T18:00:00Z' };

/**
 * First GET returns the alert as open (so the Resolve button renders); the POST
 * answers 409; the GET that follows returns it resolved — exactly the sequence a
 * technician sees when someone beats them to it.
 */
function mockRaceLostThenRefetch() {
  let alertReads = 0;
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.endsWith('/tickets')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    }
    if (init?.method === 'POST' && url.endsWith('/resolve')) {
      return Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Alert was already resolved or dismissed by another request' }),
      });
    }
    alertReads += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(alertReads === 1 ? openAlert : resolvedAlert),
    });
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('AlertDetailPage — losing the resolve race', () => {
  it('re-fetches the alert instead of latching the error banner', async () => {
    mockRaceLostThenRefetch();
    render(<AlertDetailPage alertId={ALERT_ID} />);

    const resolveButton = await screen.findByRole('button', { name: /resolve/i });
    await userEvent.click(resolveButton);

    await waitFor(() => {
      // Two reads: the mount read plus the post-409 refresh. Only one would mean
      // the page kept rendering a status the server no longer agrees with.
      const alertReads = fetchWithAuth.mock.calls.filter(
        ([url, init]) => typeof url === 'string' && url.includes(ALERT_ID)
          && !url.endsWith('/tickets') && (init as { method?: string } | undefined)?.method !== 'POST'
      );
      expect(alertReads.length).toBeGreaterThanOrEqual(2);
    });

    // The banner text is the raw thrown message; asserting on the server sentence
    // covers both the `setError(err.message)` path and any re-wording of it.
    await waitFor(() => {
      expect(screen.queryByText(/already resolved or dismissed/i)).toBeNull();
    });
  });

  it('surfaces the failure to the user rather than swallowing it', async () => {
    mockRaceLostThenRefetch();
    render(<AlertDetailPage alertId={ALERT_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: /resolve/i }));

    // Suppressing the banner must not become suppressing the FEEDBACK — a resolve
    // that silently does nothing is the failure mode `runAction` exists to prevent.
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      );
    });
  });
});
