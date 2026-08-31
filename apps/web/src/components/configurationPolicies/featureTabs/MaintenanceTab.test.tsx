import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MaintenanceTab from './MaintenanceTab';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

describe('MaintenanceTab — rebootIfPending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'maintenance',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  it('renders the reboot-if-pending toggle', () => {
    render(
      <MaintenanceTab policyId="policy-1" existingLink={undefined} linkedPolicyId={null} onLinkChanged={vi.fn()} />,
    );
    expect(screen.getByText(/Reboot if a reboot is pending/i)).toBeTruthy();
  });

  it('defaults rebootIfPending to false in the save payload', async () => {
    render(
      <MaintenanceTab policyId="policy-1" existingLink={undefined} linkedPolicyId={null} onLinkChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0] as [string | null, { inlineSettings: Record<string, unknown> }];
    expect(payload.inlineSettings.rebootIfPending).toBe(false);
  });

  it('enables rebootIfPending when the toggle is clicked', async () => {
    render(
      <MaintenanceTab policyId="policy-1" existingLink={undefined} linkedPolicyId={null} onLinkChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('maintenance-reboot-if-pending-toggle'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0] as [string | null, { inlineSettings: Record<string, unknown> }];
    expect(payload.inlineSettings.rebootIfPending).toBe(true);
  });

  it('reflects an existing rebootIfPending value and keeps it on save', async () => {
    render(
      <MaintenanceTab
        policyId="policy-1"
        existingLink={{ id: 'link-1', featureType: 'maintenance', featurePolicyId: null, inlineSettings: { rebootIfPending: true } } as never}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0] as [string | null, { inlineSettings: Record<string, unknown> }];
    expect(payload.inlineSettings.rebootIfPending).toBe(true);
  });
});

// Issue #4224: the start-time control was gated on `recurrence === 'once'`, so
// daily/weekly/monthly policies saved `windowStart` empty and the API silently
// anchored them to local midnight. These tests pin the OUTCOME — a start time
// the admin can type reaches the save payload — rather than the markup, and
// each asserts against `saveMock`'s payload (component state) rather than an
// input's `.value`, so a control that renders but never wires up would fail.
describe('MaintenanceTab — recurring start time', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'maintenance',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  const renderTab = (inlineSettings?: Record<string, unknown>) =>
    render(
      <MaintenanceTab
        policyId="policy-1"
        existingLink={
          inlineSettings
            ? ({ id: 'link-1', featureType: 'maintenance', featurePolicyId: null, inlineSettings } as never)
            : undefined
        }
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />,
    );

  const savedSettings = () => {
    const [, payload] = saveMock.mock.calls[0] as [string | null, { inlineSettings: Record<string, unknown> }];
    return payload.inlineSettings;
  };

  it('renders a start-time control for the default (weekly) recurrence', () => {
    renderTab();
    expect(screen.getByTestId('maintenance-start-time')).toBeTruthy();
  });

  it('saves an explicit midnight anchor rather than an empty windowStart', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('00:00');
  });

  it('sends the entered start time in the save payload', async () => {
    renderTab();
    fireEvent.change(screen.getByTestId('maintenance-start-time'), { target: { value: '01:50' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('01:50');
  });

  it('hydrates a stored start time into the control and keeps it on save', async () => {
    renderTab({ recurrence: 'daily', windowStart: '03:15' });
    // The payload half of this round-trip passed even before #4224 (the tab
    // echoes unknown inlineSettings straight back), so assert the control
    // actually displays the stored value too.
    expect((screen.getByTestId('maintenance-start-time') as HTMLInputElement).value).toBe('03:15');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('03:15');
  });

  it('normalises a legacy null start time to midnight for a recurring policy', async () => {
    renderTab({ recurrence: 'daily', windowStart: null });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('00:00');
  });

  it('keeps a stored start time that carries seconds', async () => {
    // The API's parser accepts "HH:MM:SS"; if the form did not, simply opening
    // the tab and saving would silently downgrade such a policy to midnight.
    renderTab({ recurrence: 'daily', windowStart: '02:45:00' });
    expect((screen.getByTestId('maintenance-start-time') as HTMLInputElement).value).toBe('02:45');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('02:45');
  });

  it('does not read a UTC instant as a local time of day when switching cadence', async () => {
    // Policies migrated by migrateToConfigPolicies store `once` windows as
    // toISOString(). Those digits are UTC, not wall-clock time in the policy's
    // timezone, so carrying them across would silently shift the window by the
    // zone's offset. Fall back to the visible midnight default instead.
    renderTab({ recurrence: 'once', windowStart: '2026-03-15T02:45:00.000Z' });
    fireEvent.change(screen.getByTestId('maintenance-recurrence'), { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('00:00');
  });

  it('falls back to midnight when the start time is left half-entered', async () => {
    // `<input type="time">` reports "" until both segments are filled. The
    // control keeps that as typed so it does not fight the user mid-edit, so
    // the save path is what has to guarantee a usable anchor.
    renderTab({ recurrence: 'daily', windowStart: '03:15' });
    fireEvent.change(screen.getByTestId('maintenance-start-time'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('00:00');
  });

  it('offers the date+time control for `once` and the time-only control otherwise', () => {
    renderTab();
    expect(screen.queryByTestId('maintenance-start-datetime')).toBeNull();

    fireEvent.change(screen.getByTestId('maintenance-recurrence'), { target: { value: 'once' } });
    expect(screen.getByTestId('maintenance-start-datetime')).toBeTruthy();
    expect(screen.queryByTestId('maintenance-start-time')).toBeNull();

    fireEvent.change(screen.getByTestId('maintenance-recurrence'), { target: { value: 'daily' } });
    expect(screen.getByTestId('maintenance-start-time')).toBeTruthy();
    expect(screen.queryByTestId('maintenance-start-datetime')).toBeNull();
  });

  it('carries the time of day over when switching from `once` to a recurring cadence', async () => {
    renderTab({ recurrence: 'once', windowStart: '2026-03-15T02:45' });
    fireEvent.change(screen.getByTestId('maintenance-recurrence'), { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('02:45');
    expect(savedSettings().recurrence).toBe('daily');
  });

  it('clears the time-only value when switching to `once` so a stale HH:MM is not saved as a datetime', async () => {
    renderTab({ recurrence: 'daily', windowStart: '02:45' });
    fireEvent.change(screen.getByTestId('maintenance-recurrence'), { target: { value: 'once' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(savedSettings().windowStart).toBe('');
  });
});

// Issue #3361: this tab shipped its own 16-entry hardcoded timezone list, the
// same defect #2856 fixed for sites/orgs/partners. Asia/Dubai was not in it, so
// a maintenance window could not be scheduled in that zone at all. These tests
// pin the fix to the OUTCOME (an out-of-old-list zone reaches the save payload)
// rather than to TimezoneSelect's internals, so they keep their meaning if the
// picker is restyled.
describe('MaintenanceTab — timezone picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'maintenance',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  const renderTab = () =>
    render(
      <MaintenanceTab policyId="policy-1" existingLink={undefined} linkedPolicyId={null} onLinkChanged={vi.fn()} />,
    );

  it('offers zones that were absent from the old hardcoded list', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('maintenance-timezone-trigger'));
    fireEvent.change(screen.getByTestId('maintenance-timezone-search'), {
      target: { value: 'dubai' },
    });
    expect(screen.getByTestId('maintenance-timezone-option-Asia/Dubai')).toBeTruthy();
  });

  it('saves a zone picked from the full IANA list', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('maintenance-timezone-trigger'));
    fireEvent.change(screen.getByTestId('maintenance-timezone-search'), {
      target: { value: 'sao paulo' },
    });
    fireEvent.click(screen.getByTestId('maintenance-timezone-option-America/Sao_Paulo'));

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0] as [string | null, { inlineSettings: Record<string, unknown> }];
    expect(payload.inlineSettings.timezone).toBe('America/Sao_Paulo');
  });

  it('preserves a stored zone the old list did not contain', () => {
    render(
      <MaintenanceTab
        policyId="policy-1"
        existingLink={{ id: 'link-1', featureType: 'maintenance', featurePolicyId: null, inlineSettings: { timezone: 'Africa/Nairobi' } } as never}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId('maintenance-timezone-trigger').textContent).toContain('Africa/Nairobi');
  });
});
