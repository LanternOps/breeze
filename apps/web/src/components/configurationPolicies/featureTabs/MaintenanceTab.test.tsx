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
