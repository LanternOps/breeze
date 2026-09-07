import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import PeripheralControlTab from './PeripheralControlTab';
import type { FeatureLink, FeatureTabProps } from './types';

const saveMock = vi.fn(async () => ({ id: 'link-1' }));
const removeMock = vi.fn(async () => true);

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

// The tab imports fetchWithAuth to load a read-only summary of the selected
// policy, keyed off `selectedPolicyId`. Its call args are the observable
// proof that `selectedPolicyId` state actually re-synced from a `parentLink`
// prop that arrived after mount — the initializer that seeds
// `selectedPolicyId` from `effectiveLink` only runs once, at mount (#5080).
const { fetchWithAuthMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
}));

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

function parentLink(featurePolicyId: string): FeatureLink {
  return {
    id: 'link-parent',
    featureType: 'peripheral_control',
    featurePolicyId,
    inlineSettings: null,
  };
}

describe('PeripheralControlTab — re-sync when the parent arrives (#5080)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    fetchWithAuthMock.mockClear();
  });

  it('re-syncs the selection once the parent link arrives after mount (delayed-parent-load)', async () => {
    const { rerender } = render(<PeripheralControlTab {...baseProps} parentLink={undefined} />);

    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(expect.stringContaining('/peripherals/policies/'));

    rerender(<PeripheralControlTab {...baseProps} parentLink={parentLink('pc-parent')} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/peripherals/policies/pc-parent'));
  });

  it('does not clobber an explicit selection once the policy has its own link', async () => {
    const existingLink: FeatureLink = {
      id: 'link-own',
      featureType: 'peripheral_control',
      featurePolicyId: 'pc-own',
      inlineSettings: null,
    };
    const { rerender } = render(
      <PeripheralControlTab {...baseProps} existingLink={existingLink} parentLink={undefined} />,
    );
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/peripherals/policies/pc-own'));
    fetchWithAuthMock.mockClear();

    rerender(
      <PeripheralControlTab {...baseProps} existingLink={existingLink} parentLink={parentLink('pc-parent')} />,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/peripherals/policies/pc-parent');
  });
});
