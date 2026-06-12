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

  it('reveals severity selection when auto-approve is enabled and saves it', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByLabelText(/automatically approve/i));
    fireEvent.click(screen.getByRole('button', { name: /critical/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.autoApprove).toBe(true);
    expect(payload.inlineSettings.autoApproveSeverities).toEqual(['critical']);
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
});
