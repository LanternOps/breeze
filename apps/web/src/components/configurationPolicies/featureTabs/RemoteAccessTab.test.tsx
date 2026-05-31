import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteAccessTab from './RemoteAccessTab';

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

const HOST_TO_VIEWER = 'Remote machine → operator (copy out)';
const VIEWER_TO_HOST = 'Operator → remote machine (paste in)';

describe('RemoteAccessTab — clipboard direction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'remote_access',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  it('defaults host→viewer OFF (egress) and viewer→host ON (paste)', () => {
    render(
      <RemoteAccessTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    expect(screen.getByRole('switch', { name: HOST_TO_VIEWER })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: VIEWER_TO_HOST })).toHaveAttribute('aria-checked', 'true');
  });

  it('persists clipboard direction into inlineSettings on save', async () => {
    render(
      <RemoteAccessTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    // Enable host→viewer egress (off by default).
    fireEvent.click(screen.getByRole('switch', { name: HOST_TO_VIEWER }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        featureType: 'remote_access',
        inlineSettings: expect.objectContaining({
          clipboardHostToViewer: true,
          clipboardViewerToHost: true,
        }),
      }),
    );
  });

  it('reflects an existing link that disables paste (viewer→host)', () => {
    render(
      <RemoteAccessTab
        policyId="policy-1"
        existingLink={{
          id: 'link-1',
          featureType: 'remote_access' as const,
          featurePolicyId: null,
          inlineSettings: { clipboardHostToViewer: true, clipboardViewerToHost: false },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    expect(screen.getByRole('switch', { name: HOST_TO_VIEWER })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: VIEWER_TO_HOST })).toHaveAttribute('aria-checked', 'false');
  });
});
