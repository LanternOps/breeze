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

  // Approval rules and patch sources now live exclusively on Update Rings.
  it('does not render the Patch Sources section', async () => {
    render(<PatchTab {...baseProps} />);
    await screen.findByText('Approval Ring');
    expect(screen.queryByText('Patch Sources')).toBeNull();
    expect(screen.queryByLabelText(/os updates/i)).toBeNull();
    expect(screen.queryByLabelText(/third-party applications/i)).toBeNull();
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
});
