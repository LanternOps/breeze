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
