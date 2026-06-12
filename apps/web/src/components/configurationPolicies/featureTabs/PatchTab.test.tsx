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

describe('PatchTab patch sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as Response);
    saveMock.mockResolvedValue({ id: 'link-1', featureType: 'patch', inlineSettings: {} });
  });

  it('renders OS checked and third-party unchecked by default', async () => {
    render(<PatchTab {...baseProps} />);
    expect(await screen.findByLabelText(/os updates/i)).toBeChecked();
    expect(screen.getByLabelText(/third-party applications/i)).not.toBeChecked();
  });

  it('saves selected sources in inlineSettings', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByLabelText(/third-party applications/i));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.sources).toEqual(['os', 'third_party']);
  });

  it('keeps at least one source selected', async () => {
    render(<PatchTab {...baseProps} />);
    const osBox = await screen.findByLabelText(/os updates/i);
    fireEvent.click(osBox); // attempt to uncheck the only source
    expect(screen.getByLabelText(/os updates/i)).toBeChecked();
  });

  it('hydrates sources from an existing link', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['third_party'], autoApprove: false, autoApproveSeverities: [] },
        }}
      />
    );
    expect(await screen.findByLabelText(/third-party applications/i)).toBeChecked();
    expect(screen.getByLabelText(/os updates/i)).not.toBeChecked();
  });

  it('hydrates legacy alias source values', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['microsoft', 'custom'] },
        }}
      />
    );
    expect(await screen.findByLabelText(/os updates/i)).toBeChecked();
    expect(screen.getByLabelText(/third-party applications/i)).toBeChecked();
  });

  it('hydrates sources from an inherited parent link', async () => {
    render(
      <PatchTab
        {...baseProps}
        parentLink={{
          id: 'parent-link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['third_party'] },
        }}
      />
    );
    expect(await screen.findByLabelText(/third-party applications/i)).toBeChecked();
    expect(screen.getByLabelText(/os updates/i)).not.toBeChecked();
  });

  it('preserves unrelated stored settings across a save', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['os'], autoApprove: true, autoApproveSeverities: ['critical'] },
        }}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.autoApprove).toBe(true);
    expect(payload.inlineSettings.autoApproveSeverities).toEqual(['critical']);
  });

  it('includes wired auto-approve fields and apps in the save payload', async () => {
    render(<PatchTab {...baseProps} />);

    fireEvent.click(await screen.findByTestId('auto-approve-toggle'));
    fireEvent.click(screen.getByTestId('auto-approve-severity-critical'));
    fireEvent.change(screen.getByTestId('auto-approve-deferral'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings).toMatchObject({
      autoApprove: true,
      autoApproveSeverities: ['critical'],
      autoApproveDeferralDays: 3,
      apps: [],
    });
  });

  it('disables the auto-approve section and shows the ring-precedence notice when a ring is linked', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: 'ring-1',
          inlineSettings: { sources: ['os'], autoApprove: true, autoApproveSeverities: ['critical'] },
        }}
      />
    );

    expect(await screen.findByTestId('auto-approve-ring-notice')).toHaveTextContent(/governed by the linked update ring/i);
    expect(screen.getByTestId('auto-approve-toggle')).toBeDisabled();
  });

  it('hydrates auto-approve fields and apps from existing inline settings', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: {
            sources: ['third_party'],
            autoApprove: true,
            autoApproveSeverities: ['important'],
            autoApproveDeferralDays: 7,
            apps: [{ source: 'third_party', packageId: 'A.B', action: 'block' }],
          },
        }}
      />
    );

    expect(await screen.findByTestId('auto-approve-toggle')).toBeChecked();
    expect(screen.getByTestId('auto-approve-severity-important')).toBeChecked();
    expect(screen.getByTestId('auto-approve-deferral')).toHaveValue(7);
    expect(screen.getAllByText('A.B').length).toBeGreaterThan(0);
  });
});
