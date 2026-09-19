import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TimeTrackingSettingsCard from './TimeTrackingSettingsCard';

const partnerRes = (settings: unknown) =>
  ({ ok: true, status: 200, json: async () => ({ data: { id: 'p-1', settings } }) }) as Response;

function mockPartner(settings: unknown) {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/orgs/partners/me' && (!init || init.method !== 'PATCH')) return partnerRes(settings);
    return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
  });
}

const lastPatchBody = () => {
  const call = fetchWithAuth.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('TimeTrackingSettingsCard', () => {
  it('renders the toggle OFF when the partner has no timeTracking block', async () => {
    mockPartner({});
    render(<TimeTrackingSettingsCard />);
    const toggle = await screen.findByTestId('time-suggestions-enabled');
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  // #3608: a stored `false` is an operator's decision, not an absent value. The
  // API's parser already treats only an explicit `true` as on; the UI must not
  // render "unset" for it either.
  it('a stored enabled:false is rendered as off, not as "unset"', async () => {
    mockPartner({ timeTracking: { sessionSuggestions: { enabled: false, minSessionSeconds: 300, mergeGapMinutes: 5 } } });
    render(<TimeTrackingSettingsCard />);
    const toggle = await screen.findByTestId('time-suggestions-enabled');
    expect((toggle as HTMLInputElement).checked).toBe(false);
    // The stored thresholds still render — off does not mean "no configuration".
    expect((screen.getByTestId('time-suggestions-min-session') as HTMLInputElement).value).toBe('300');
    expect((screen.getByTestId('time-suggestions-merge-gap') as HTMLInputElement).value).toBe('5');
  });

  it('saving sends the COMPLETE sessionSuggestions object (PATCH replaces it wholesale)', async () => {
    mockPartner({ timeTracking: { sessionSuggestions: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 } } });
    render(<TimeTrackingSettingsCard />);
    fireEvent.click(await screen.findByTestId('time-suggestions-enabled'));
    fireEvent.click(screen.getByTestId('time-suggestions-save'));
    await waitFor(() => expect(lastPatchBody()).not.toBeNull());
    // Sending only { enabled } would destroy both thresholds.
    expect(lastPatchBody()).toEqual({
      settings: { timeTracking: { sessionSuggestions: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 } } },
    });
  });

  it('a failed save surfaces an error, never a silent no-op', async () => {
    mockPartner({});
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response;
      }
      return partnerRes({});
    });
    render(<TimeTrackingSettingsCard />);
    fireEvent.click(await screen.findByTestId('time-suggestions-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('rejects out-of-range thresholds client-side and never sends them', async () => {
    mockPartner({});
    render(<TimeTrackingSettingsCard />);
    const min = await screen.findByTestId('time-suggestions-min-session');
    fireEvent.change(min, { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('time-suggestions-save'));
    await waitFor(() => expect(screen.getByTestId('time-suggestions-error')).toBeTruthy());
    expect(lastPatchBody()).toBeNull();

    fireEvent.change(min, { target: { value: '120' } });
    fireEvent.change(screen.getByTestId('time-suggestions-merge-gap'), { target: { value: '999' } });
    fireEvent.click(screen.getByTestId('time-suggestions-save'));
    await waitFor(() => expect(screen.getByTestId('time-suggestions-error')).toBeTruthy());
    expect(lastPatchBody()).toBeNull();
  });
});
