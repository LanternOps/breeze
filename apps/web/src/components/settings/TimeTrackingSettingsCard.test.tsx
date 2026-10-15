import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
let canManagePartnerWide: boolean | undefined = true;
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { canManagePartnerWide } }),
}));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TimeTrackingSettingsCard from './TimeTrackingSettingsCard';

// GET /orgs/partners/me returns the partner row itself, not a { data } envelope.
const partnerRes = (settings: unknown) =>
  ({ ok: true, status: 200, json: async () => ({ id: 'p-1', settings }) }) as Response;

const APPROVAL_DEFAULTS = {
  enabled: { value: false, source: 'default' },
  budgetTrigger: { value: true, source: 'default' },
  afterHoursTrigger: { value: true, source: 'default' },
  enforcement: { value: 'soft', source: 'default' },
  requestTtlHours: { value: 72, source: 'default' },
};
let approvalEffective: Record<string, unknown> = APPROVAL_DEFAULTS;

const approvalPatchBody = () => {
  const call = fetchWithAuth.mock.calls.find(
    (c) => c[0] === '/ticketing/approval-settings' && (c[1] as RequestInit | undefined)?.method === 'PATCH',
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
};

function mockPartner(settings: unknown) {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/ticketing/approval-settings') {
      return { ok: true, status: 200, json: async () => ({ data: approvalEffective }) } as Response;
    }
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
  canManagePartnerWide = true;
  approvalEffective = APPROVAL_DEFAULTS;
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

  it('saving without changes sends the stored settings back unchanged', async () => {
    mockPartner({ timeTracking: {
      sessionSuggestions: { enabled: true, minSessionSeconds: 300, mergeGapMinutes: 5 },
      locationSuggestions: { enabled: true, defaultRadiusM: 300 },
    } });
    render(<TimeTrackingSettingsCard />);
    await waitFor(() =>
      expect((screen.getByTestId('time-suggestions-enabled') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByTestId('time-suggestions-save'));
    await waitFor(() => expect(lastPatchBody()).not.toBeNull());
    expect(lastPatchBody()).toEqual({
      settings: {
        timeTracking: {
          sessionSuggestions: { enabled: true, minSessionSeconds: 300, mergeGapMinutes: 5 },
          locationSuggestions: { enabled: true, defaultRadiusM: 300 },
        },
      },
    });
  });

  it('saving sends the COMPLETE sessionSuggestions object (PATCH replaces it wholesale)', async () => {
    mockPartner({ timeTracking: { sessionSuggestions: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 } } });
    render(<TimeTrackingSettingsCard />);
    fireEvent.click(await screen.findByTestId('time-suggestions-enabled'));
    fireEvent.click(screen.getByTestId('time-suggestions-save'));
    await waitFor(() => expect(lastPatchBody()).not.toBeNull());
    // Sending only { enabled } would destroy both thresholds.
    expect(lastPatchBody()).toEqual({
      settings: {
        timeTracking: {
          sessionSuggestions: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 },
          locationSuggestions: { enabled: false, defaultRadiusM: 150 },
        },
      },
    });
  });

  describe('location suggestions', () => {
    it('renders OFF with no radius input when the partner has no locationSuggestions block', async () => {
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      const toggle = await screen.findByTestId('location-suggestions-enabled');
      expect((toggle as HTMLInputElement).checked).toBe(false);
      expect(screen.queryByTestId('location-suggestions-radius')).toBeNull();
      expect(screen.getByText('Suggest a timer when a technician arrives at a client site')).toBeTruthy();
      expect(screen.getByText(/never sent to Breeze/)).toBeTruthy();
    });

    it('a stored enabled:false stays off; a stored enabled:true shows the stored radius', async () => {
      mockPartner({ timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 300 } } });
      render(<TimeTrackingSettingsCard />);
      await waitFor(() =>
        expect((screen.getByTestId('location-suggestions-enabled') as HTMLInputElement).checked).toBe(true));
      expect((screen.getByTestId('location-suggestions-radius') as HTMLInputElement).value).toBe('300');
    });

    it('toggling on reveals the radius and Save sends the COMPLETE locationSuggestions object alongside sessionSuggestions', async () => {
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      fireEvent.click(await screen.findByTestId('location-suggestions-enabled'));
      const radius = screen.getByTestId('location-suggestions-radius') as HTMLInputElement;
      expect(radius.value).toBe('150');
      fireEvent.click(screen.getByTestId('time-suggestions-save'));
      await waitFor(() => expect(lastPatchBody()).not.toBeNull());
      expect(lastPatchBody().settings.timeTracking.locationSuggestions).toEqual({ enabled: true, defaultRadiusM: 150 });
    });

    it('rejects a radius of 20 inline and never submits', async () => {
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      fireEvent.click(await screen.findByTestId('location-suggestions-enabled'));
      fireEvent.change(screen.getByTestId('location-suggestions-radius'), { target: { value: '20' } });
      fireEvent.click(screen.getByTestId('time-suggestions-save'));
      await waitFor(() => expect(screen.getByTestId('location-suggestions-error')).toBeTruthy());
      expect(lastPatchBody()).toBeNull();
      fireEvent.change(screen.getByTestId('location-suggestions-radius'), { target: { value: '1001' } });
      fireEvent.click(screen.getByTestId('time-suggestions-save'));
      await waitFor(() => expect(screen.getByTestId('location-suggestions-error')).toBeTruthy());
      expect(lastPatchBody()).toBeNull();
    });
  });

  it.each([
    ['non-OK response', () => fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)],
    ['thrown request', () => fetchWithAuth.mockRejectedValue(new Error('network'))],
  ])('initial load failure (%s): error shown, Save disabled, no PATCH', async (_n, arrange) => {
    arrange();
    render(<TimeTrackingSettingsCard />);
    expect(await screen.findByTestId('time-suggestions-load-error')).toBeTruthy();
    const save = screen.getByTestId('time-suggestions-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(lastPatchBody()).toBeNull();
  });

  it('feature off with a stored radius of 300: Save still sends defaultRadiusM 300', async () => {
    mockPartner({ timeTracking: { locationSuggestions: { enabled: false, defaultRadiusM: 300 } } });
    render(<TimeTrackingSettingsCard />);
    await waitFor(() => expect((screen.getByTestId('time-suggestions-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('time-suggestions-save'));
    await waitFor(() => expect(lastPatchBody()).not.toBeNull());
    expect(lastPatchBody().settings.timeTracking.locationSuggestions).toEqual({ enabled: false, defaultRadiusM: 300 });
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

  describe('customer approval section', () => {
    it('renders the inherited source label for a field whose source is default', async () => {
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      const source = await screen.findByTestId('approval-enabled-source');
      expect(source).toHaveTextContent('Default');
      expect((screen.getByTestId('approval-enabled') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('approval-ttl') as HTMLInputElement).value).toBe('72');
    });

    it('shows the partner source once a field is set at the partner level', async () => {
      approvalEffective = { ...APPROVAL_DEFAULTS, enforcement: { value: 'hard', source: 'partner' } };
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      const source = await screen.findByTestId('approval-enforcement-source');
      expect(source).toHaveTextContent(/partner/i);
      expect((screen.getByTestId('approval-enforcement') as HTMLSelectElement).value).toBe('hard');
    });

    it('saving sends only the changed approval fields to /ticketing/approval-settings', async () => {
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      await screen.findByTestId('approval-enabled-source');
      fireEvent.click(screen.getByTestId('approval-enabled'));
      fireEvent.change(screen.getByTestId('approval-ttl'), { target: { value: '48' } });
      fireEvent.click(screen.getByTestId('time-suggestions-save'));
      await waitFor(() => expect(approvalPatchBody()).not.toBeNull());
      expect(approvalPatchBody()).toEqual({ enabled: true, requestTtlHours: 48 });
    });

    it('does not PATCH the approval endpoint when no approval field changed', async () => {
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      await screen.findByTestId('approval-enabled-source');
      fireEvent.click(screen.getByTestId('time-suggestions-save'));
      await waitFor(() => expect(lastPatchBody()).not.toBeNull());
      expect(approvalPatchBody()).toBeNull();
    });

    it('first PATCH ok + approval PATCH 500: shows the specific message and no plain "saved" toast', async () => {
      mockPartner({});
      const base = fetchWithAuth.getMockImplementation()!;
      fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/ticketing/approval-settings' && init?.method === 'PATCH') {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return base(url, init);
      });
      render(<TimeTrackingSettingsCard />);
      await screen.findByTestId('approval-enabled-source');
      fireEvent.click(screen.getByTestId('approval-enabled'));
      fireEvent.click(screen.getByTestId('time-suggestions-save'));
      await waitFor(() => expect(approvalPatchBody()).not.toBeNull());
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: expect.stringContaining('saved, but the customer approval') }),
        ),
      );
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      // The draft stays dirty so the user can retry.
      expect((screen.getByTestId('approval-enabled') as HTMLInputElement).checked).toBe(true);
    });

    it('rejects an out-of-range TTL before sending anything', async () => {
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      await screen.findByTestId('approval-enabled-source');
      fireEvent.change(screen.getByTestId('approval-ttl'), { target: { value: '9999' } });
      fireEvent.click(screen.getByTestId('time-suggestions-save'));
      expect(await screen.findByTestId('approval-error')).toBeInTheDocument();
      expect(approvalPatchBody()).toBeNull();
    });

    it('is read-only with an explanation without partner-wide rights', async () => {
      canManagePartnerWide = false;
      mockPartner({});
      render(<TimeTrackingSettingsCard />);
      await screen.findByTestId('approval-enabled-source');
      expect(screen.getByTestId('approval-readonly-note')).toBeInTheDocument();
      expect((screen.getByTestId('approval-enabled') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('approval-ttl') as HTMLInputElement).disabled).toBe(true);
    });
  });
});
