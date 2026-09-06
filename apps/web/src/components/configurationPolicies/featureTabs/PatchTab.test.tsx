import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PatchTab from './PatchTab';
import { fetchWithAuth } from '../../../stores/auth';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const baseProps = {
  policyId: 'policy-1',
  existingLink: null,
  onLinkChanged: vi.fn(),
  linkedPolicyId: undefined,
  parentLink: null,
} as any;

describe('PatchTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as Response);
    saveMock.mockResolvedValue({ id: 'link-1', featureType: 'patch', inlineSettings: {} });
  });

  // Auto-approval rules live on Update Rings, but patch *sources* are the policy's
  // own install-scope gate (evaluator source-filters on settings.sources). #1428
  // wrongly stripped this control, stranding third-party patching as unreachable —
  // it's restored as a single third-party toggle (OS is always included).
  it('renders the Patch Sources third-party toggle, off by default', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByText('Approval Ring');
    expect(screen.getByText('Patch Sources')).toBeInTheDocument();
    const toggle = screen.getByTestId('patch-third-party-sources-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('adds third_party to sources on save when the toggle is switched on', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByTestId('patch-third-party-sources-toggle'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.sources).toEqual(['os', 'third_party']);
  });

  it('hydrates the third-party toggle on, and drops third_party back to [os] when switched off', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os', 'third_party'] },
        }}
      />
    );
    const toggle = await screen.findByTestId('patch-third-party-sources-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.sources).toEqual(['os']);
  });

  it('does not render the Automatic Approval section', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByText('Approval Ring');
    expect(screen.queryByText('Automatic Approval')).toBeNull();
    expect(screen.queryByTestId('auto-approve-toggle')).toBeNull();
    expect(screen.queryByTestId('auto-approve-severity-critical')).toBeNull();
    expect(screen.queryByTestId('auto-approve-deferral')).toBeNull();
  });

  it('keeps the Approval Ring link, Installation Schedule, and Application Rules', async () => {
    render(<PatchTab {...baseProps} />);
    expect(await screen.findByText('Approval Ring')).toBeInTheDocument();
    expect(screen.getByText('No ring (manual approvals only)')).toBeInTheDocument();
    expect(screen.getByText('Installation Schedule')).toBeInTheDocument();
    expect(screen.getByText('Reboot Policy')).toBeInTheDocument();
    expect(screen.getByText('Application Rules')).toBeInTheDocument();
  });

  // #2609: schedule fields rendered <label> with no htmlFor/id association, so
  // screen readers announced an unnamed control and getByLabel(...) failed.
  it('associates the schedule labels with their inputs (a11y, #2609)', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByText('Installation Schedule');

    expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    expect(screen.getByLabelText('Time')).toBeInTheDocument();

    // Weekly is the default frequency, so the Day of week select is present.
    expect(screen.getByLabelText('Day of week')).toBeInTheDocument();
  });

  it('links the policy to the selected ring on save', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'ring-1', name: 'Pilot', ringOrder: 1, deferralDays: 0, gracePeriodHours: 4 }],
      }),
    } as unknown as Response);

    render(<PatchTab {...baseProps} />);
    fireEvent.change(await screen.findByTestId('approval-ring-select'), { target: { value: 'ring-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.featurePolicyId).toBe('ring-1');
  });

  // The auto-approve/sources fields are no longer editable, but existing stored
  // values must survive a save untouched (back-compat with the deprecated fallback).
  it('preserves stored auto-approve and sources fields in the save payload', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['third_party'], autoApprove: true, autoApproveSeverities: ['critical'] },
        }}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.autoApprove).toBe(true);
    expect(payload.inlineSettings.autoApproveSeverities).toEqual(['critical']);
    expect(payload.inlineSettings.sources).toEqual(['third_party']);
  });

  it('blocks save when a pinned app rule has no version, then proceeds once fixed', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: {
            sources: ['os'],
            apps: [{ source: 'third_party', packageId: 'A.B', action: 'pin', pinnedVersion: '' }],
          },
        }}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /save/i }));

    expect(saveMock).not.toHaveBeenCalled();
    // Inline hint from the app-rules section plus the error banner.
    expect(screen.getAllByText('Pinned applications need a version.').length).toBe(2);

    fireEvent.change(screen.getByTestId('app-rule-pin-version-third_party|a.b'), {
      target: { value: '1.2.3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
  });

  // #1872: sole-patch-source enforcement toggle.
  it('renders the exclusive Windows Update toggle, off by default', async () => {
    render(<PatchTab {...baseProps} />);
    const toggle = await screen.findByTestId('patch-exclusive-windows-update-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Manage Windows Update exclusively through Breeze')).toBeInTheDocument();
  });

  it('persists exclusiveWindowsUpdate=true in the save payload when toggled on', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByTestId('patch-exclusive-windows-update-toggle'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.exclusiveWindowsUpdate).toBe(true);
  });

  it('hydrates the toggle from a stored exclusiveWindowsUpdate value', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], exclusiveWindowsUpdate: true },
        }}
      />
    );
    const toggle = await screen.findByTestId('patch-exclusive-windows-update-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  // #3197: operator-configurable warning window before a patch-triggered reboot.
  it('renders the reboot delay input with the default value when reboot policy is not "never"', async () => {
    render(<PatchTab {...baseProps} />);
    const input = await screen.findByTestId('patch-reboot-delay-minutes');
    expect(input).toHaveValue(15);
  });

  it('hides the reboot delay input when reboot policy is "never"', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootPolicy: 'never' },
        }}
      />
    );
    await screen.findByText('Reboot Policy');
    expect(screen.queryByTestId('patch-reboot-delay-minutes')).toBeNull();
  });

  it('persists rebootDelayMinutes in the save payload when changed', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.change(await screen.findByTestId('patch-reboot-delay-minutes'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.rebootDelayMinutes).toBe(30);
  });

  it('hydrates the reboot delay input from a stored rebootDelayMinutes value', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootDelayMinutes: 45 },
        }}
      />
    );
    const input = await screen.findByTestId('patch-reboot-delay-minutes');
    expect(input).toHaveValue(45);
  });

  // #3207: end-user reboot deferral. Off by default — the budget fields only
  // exist once an admin opts in, so the tab cannot imply a Postpone button that
  // no device will ever show.
  it('offers the deferral toggle, off, and hides the budget fields until it is on', async () => {
    render(<PatchTab {...baseProps} />);
    const toggle = await screen.findByTestId('patch-reboot-allow-deferral-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('patch-reboot-max-deferrals')).toBeNull();
    expect(screen.queryByTestId('patch-reboot-deferral-minutes')).toBeNull();
  });

  it('shows max deferrals and the deferral window once enabled', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootAllowDeferral: true },
        }}
      />
    );
    expect(await screen.findByTestId('patch-reboot-max-deferrals')).toHaveValue(3);
    expect(screen.getByTestId('patch-reboot-deferral-minutes')).toHaveValue(60);
  });

  it('hides the whole deferral block when the reboot policy is never', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], rebootPolicy: 'never', rebootAllowDeferral: true },
        }}
      />
    );
    await screen.findByText('Reboot Policy');
    expect(screen.queryByTestId('patch-reboot-allow-deferral-toggle')).toBeNull();
    expect(screen.queryByTestId('patch-reboot-max-deferrals')).toBeNull();
  });

  it('hydrates the budget fields from stored values', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: {
            sources: ['os'],
            rebootAllowDeferral: true,
            rebootMaxDeferrals: 2,
            rebootDeferralMinutes: 30,
          },
        }}
      />
    );
    expect(await screen.findByTestId('patch-reboot-max-deferrals')).toHaveValue(2);
    expect(screen.getByTestId('patch-reboot-deferral-minutes')).toHaveValue(30);
  });

  it('persists the deferral settings in the save payload', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByTestId('patch-reboot-allow-deferral-toggle'));
    fireEvent.change(await screen.findByTestId('patch-reboot-max-deferrals'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByTestId('patch-reboot-deferral-minutes'), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.rebootAllowDeferral).toBe(true);
    expect(payload.inlineSettings.rebootMaxDeferrals).toBe(5);
    expect(payload.inlineSettings.rebootDeferralMinutes).toBe(45);
  });

  it('sends deferral off by default so an untouched policy keeps today’s behaviour', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByTestId('patch-reboot-delay-minutes');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.rebootAllowDeferral).toBe(false);
  });

  describe('inline ring editor', () => {
    it('creates a ring inline, refetches, and auto-selects it', async () => {
      fetchMock.mockImplementation((_url: any, opts: any) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ data: { id: 'ring-9' } }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            data: [{ id: 'ring-9', name: 'Broad', enabled: true, ringOrder: 0, deferralDays: 0, gracePeriodHours: 4 }],
          }),
        } as unknown as Response);
      });

      render(<PatchTab {...baseProps} />);
      fireEvent.click(await screen.findByRole('button', { name: /new ring/i }));
      fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Broad' } });
      fireEvent.click(screen.getByRole('button', { name: /create ring/i }));

      await waitFor(() => expect(screen.getByTestId('approval-ring-select')).toHaveValue('ring-9'));
      const postCall = fetchMock.mock.calls.find(([, o]: any) => o?.method === 'POST');
      expect(postCall?.[0]).toBe('/update-rings');
    });

    it('surfaces an error when inline ring create fails', async () => {
      fetchMock.mockImplementation((_url: any, opts: any) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 500, json: vi.fn().mockResolvedValue({}) } as unknown as Response);
        }
        return Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response);
      });

      render(<PatchTab {...baseProps} />);
      fireEvent.click(await screen.findByRole('button', { name: /new ring/i }));
      fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Broad' } });
      fireEvent.click(screen.getByRole('button', { name: /create ring/i }));

      expect(await screen.findByText('Failed to create update ring')).toBeInTheDocument();
    });
  });
});
