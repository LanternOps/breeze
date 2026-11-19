import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SoftwarePolicyTab from './SoftwarePolicyTab';
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

// The tab lazy-imports fetchWithAuth to load a read-only summary of the
// selected policy, keyed off `selectedPolicyId`. Its call args are the
// observable proof that `selectedPolicyId` state actually re-synced from a
// `parentLink` prop that arrived after mount — the initializer that seeds
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
    featureType: 'software_policy',
    featurePolicyId,
    inlineSettings: null,
  };
}

describe('SoftwarePolicyTab — re-sync when the parent arrives (#5080)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    fetchWithAuthMock.mockClear();
  });

  it('re-syncs the selection once the parent link arrives after mount (delayed-parent-load)', async () => {
    const { rerender } = render(<SoftwarePolicyTab {...baseProps} parentLink={undefined} />);

    // Nothing selected yet — the parent embed hasn't loaded, so no summary
    // fetch for a policy id (PolicyLinkSelector's own options fetch is fine).
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(expect.stringContaining('/software-policies/'));

    rerender(<SoftwarePolicyTab {...baseProps} parentLink={parentLink('sp-parent')} />);

    // The re-synced selectedPolicyId drives the summary-fetch effect.
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/software-policies/sp-parent'));
  });

  it('does not clobber an explicit selection once the policy has its own link', async () => {
    const existingLink: FeatureLink = {
      id: 'link-own',
      featureType: 'software_policy',
      featurePolicyId: 'sp-own',
      inlineSettings: null,
    };
    const { rerender } = render(
      <SoftwarePolicyTab {...baseProps} existingLink={existingLink} parentLink={undefined} />,
    );
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/software-policies/sp-own'));
    fetchWithAuthMock.mockClear();

    rerender(
      <SoftwarePolicyTab {...baseProps} existingLink={existingLink} parentLink={parentLink('sp-parent')} />,
    );

    // Own link wins — the parent's arrival must not steal the selection away
    // from an explicit override.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/software-policies/sp-parent');
  });
});


describe('SoftwarePolicyTab additive links', () => {
  it('renders each linked policy and adds a new link rather than editing an existing one', async () => {
    const links = [parentLink('allowlist'), { ...parentLink('blocklist'), id: 'link-blocklist' }];
    const { container } = render(<SoftwarePolicyTab {...baseProps} existingLink={links[0]} siblingLinks={links} allLinks={links} />);
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/software-policies/allowlist');
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/software-policies/blocklist');
    });
    expect(container.querySelectorAll('h2')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Add software policy' }));
    expect(container.querySelectorAll('h2')).toHaveLength(3);
  });

  it('removes only the selected software link', async () => {
    const onLinkChanged = vi.fn();
    const first = parentLink('allowlist');
    const second = { ...parentLink('blocklist'), id: 'link-blocklist' };
    render(<SoftwarePolicyTab {...baseProps} onLinkChanged={onLinkChanged} existingLink={first} siblingLinks={[first, second]} allLinks={[first, second]} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    fireEvent.click(await screen.findByTestId('feature-tab-remove-confirm'));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('link-blocklist'));
    expect(onLinkChanged).toHaveBeenCalledWith(null, 'software_policy', 'link-blocklist');
  });

  it('keeps inherited policies visible alongside own policies without override controls', async () => {
    const own = { ...parentLink('own-blocklist'), id: 'link-own' };
    const inherited = parentLink('parent-allowlist');
    render(<SoftwarePolicyTab {...baseProps} existingLink={own} siblingLinks={[own]} allLinks={[own, inherited]} parentLink={inherited} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/software-policies/parent-allowlist'));
    expect(screen.queryByRole('button', { name: /override/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revert/i })).not.toBeInTheDocument();
  });
});
